import type { ManagementCatalogResponse, RemoteModelDBClient } from '@mode-db/sdk';
import type {
  DesignerLayerRow,
  DesignerLayout,
  DesignerModelLayout,
} from '../types/designer-layout.js';
import type { LayerTreeNode } from '../types/layer-tree.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { MldgDocument } from '../types/mldg-document.js';
import { createEmptyMldgDocument } from '../types/mldg-document.js';
import type { PropObject } from '../types/prop-object.js';
import {
  parseRelationCanvasMeta,
  serializeRelationCanvasMeta,
  type RelationCanvasMeta,
} from '../types/relation-canvas-meta.js';
import {
  GRAPH_INHERIT_KIND,
  INHERIT_RELATION_DEFAULT_NAME,
  INHERIT_RELATION_LABEL_I18N,
} from '../config/graph-edge-kinds.js';
import { extractEngineModelRelationPayload } from '../sync/engine-model-relation.js';
import {
  parseMldgDocumentFromUint8Array,
  serializeMldgDocumentToUint8Array,
} from '../sync/mldg-wire-bytes.js';
import { pullLatestDesignerSnapshot, pushDesignerSnapshot } from '../sync/sdk-designer-sync.js';
import { loadLibraryCanvas as loadLibraryCanvasFromRows } from '../sync/designer-row-hydrate.js';
import { mapI18nSuffix, pickCanonicalFromI18n } from '../utils/i18n-resolve.js';
import { pickNewModelColor } from '../utils/model-color-pick.js';
import { makeUniqueName } from '../utils/name-validation.js';

export type DataListener = () => void;

export interface LayerVisibilitySnapshot {
  hiddenNodeIds: Set<string>;
  hiddenRelationIds: Set<string>;
  mutedNodeIds: Set<string>;
  mutedRelationIds: Set<string>;
}

export interface LayerPageMembershipSnapshot {
  nodeIds: Set<string>;
  relationIds: Set<string>;
}

function newId(): string {
  return crypto.randomUUID();
}

import {
  defaultLayerGroupLabel,
  defaultLayerPageLabel,
  isLayerRootGroupId,
  LAYER_DEFAULT_PAGE_ID,
  LAYER_ROOT_GROUP_ID,
} from '../config/layer-tree-defaults.js';
import {
  applyLayerTreeDrop,
  collectPageIdsInSubtree,
  normalizeLayerTreeRoots,
  removeLayerNodeFromTree,
  type LayerDropZone,
} from '../utils/layer-tree-ops.js';

function createDefaultLayerTree(): LayerTreeNode[] {
  return [
    {
      id: LAYER_ROOT_GROUP_ID,
      kind: 'group',
      label: 'Root',
      name_i18n: { zh: '根分组', en: 'Root', ja: 'ルート' },
      isVisible: true,
      sort: 0,
      memberModelIds: [],
      children: [
        {
          id: LAYER_DEFAULT_PAGE_ID,
          kind: 'page',
          label: 'Main',
          name_i18n: { zh: '主页面', en: 'Main', ja: 'メイン' },
          isVisible: true,
          sort: 0,
          children: [],
          memberModelIds: [],
        },
      ],
    },
  ];
}

/**
 * 内存模型与关系；可与 SDK 同步（此处留扩展点）。
 */
export class DataManager {
  private _models: EngineModelNode[] = [];
  private _relations: EngineRelationEdge[] = [];
  private _layoutByModelId = new Map<string, DesignerModelLayout>();
  private _layers: DesignerLayerRow[] = [];
  /** node → layer ids（未出现在映射中的节点视为未归属图层，始终参与绘制）。 */
  private readonly _nodeToLayers = new Map<string, Set<string>>();
  private readonly _relationToLayers = new Map<string, Set<string>>();
  private readonly _autoRelationToLayers = new Map<string, Set<string>>();
  private _layerTreeRoots: LayerTreeNode[] = createDefaultLayerTree();
  private readonly _listeners = new Set<DataListener>();
  private _hoveredLayerPageId: string | undefined;
  private _layerTreePanelOpen = false;

  constructor() {
    this.resyncLayersFromTree();
  }

  /** 切换逻辑库后清空画布与层级树（新会话）。 */
  resetToNewLibrary(): void {
    this._models = [];
    this._relations = [];
    this._layoutByModelId.clear();
    this._nodeToLayers.clear();
    this._relationToLayers.clear();
    this._autoRelationToLayers.clear();
    this._layerTreeRoots = createDefaultLayerTree();
    this.resyncLayersFromTree();
    this.emit();
  }

  get layerTreeRoots(): readonly LayerTreeNode[] {
    return this._layerTreeRoots;
  }

  get defaultPageLayerId(): string {
    return LAYER_DEFAULT_PAGE_ID;
  }

  get hoveredLayerPageId(): string | undefined {
    return this._hoveredLayerPageId;
  }

  setHoveredLayerPageId(pageId: string | undefined): void {
    if (this._hoveredLayerPageId === pageId) {
      return;
    }
    this._hoveredLayerPageId = pageId;
    this.emit();
  }

  get layerTreePanelOpen(): boolean {
    return this._layerTreePanelOpen;
  }

  setLayerTreePanelOpen(isOpen: boolean): void {
    if (this._layerTreePanelOpen === isOpen) {
      return;
    }
    this._layerTreePanelOpen = isOpen;
    if (!isOpen) {
      this._hoveredLayerPageId = undefined;
    }
    this.emit();
  }

  isLayerRootGroup(id: string): boolean {
    return isLayerRootGroupId(id);
  }

  private cloneTree(nodes: readonly LayerTreeNode[]): LayerTreeNode[] {
    return nodes.map((n) => ({
      ...n,
      name_i18n: n.name_i18n ? { ...n.name_i18n } : undefined,
      description_i18n: n.description_i18n ? { ...n.description_i18n } : undefined,
      children: n.kind === 'group' ? this.cloneTree(n.children) : [],
      memberModelIds: n.kind === 'page' ? [...n.memberModelIds] : [],
      memberRelationIds: n.kind === 'page' ? [...(n.memberRelationIds ?? [])] : [],
    }));
  }

  /** 将分组/页的可见性同步为 flat `designerLayers`（仅页参与模型显隐）。 */
  private resyncLayersFromTree(): void {
    const next: DesignerLayerRow[] = [];
    const walk = (nodes: readonly LayerTreeNode[], groupHidden: boolean): void => {
      for (const n of nodes) {
        if (n.kind === 'group') {
          const gh = groupHidden || !n.isVisible;
          walk(n.children, gh);
        } else {
          next.push({
            id: n.id,
            label: n.label,
            order: n.sort,
            isVisible: n.isVisible && !groupHidden,
          });
        }
      }
    };
    walk(this._layerTreeRoots, false);
    next.sort((a, b) => a.order - b.order);
    this._layers = next;
  }

  setLayerTree(roots: LayerTreeNode[]): void {
    this._layerTreeRoots = normalizeLayerTreeRoots(roots);
    this.resyncLayersFromTree();
    this.rebuildAutoRelationLayers();
    this.emit();
  }

  addLayerGroup(parentGroupId: string, label: string = defaultLayerGroupLabel()): string {
    const id = newId();
    const parent = this.findTreeNode(parentGroupId);
    if (!parent || parent.kind !== 'group') {
      return id;
    }
    const node: LayerTreeNode = {
      id,
      kind: 'group',
      label,
      isVisible: true,
      sort: parent.children.length,
      memberModelIds: [],
      children: [],
    };
    parent.children.push(node);
    this.resyncLayersFromTree();
    this.emit();
    return id;
  }

  addLayerPage(parentGroupId: string, label: string = defaultLayerPageLabel()): string {
    const id = newId();
    const parent = this.findTreeNode(parentGroupId);
    if (!parent || parent.kind !== 'group') {
      return id;
    }
    const page: LayerTreeNode = {
      id,
      kind: 'page',
      label,
      isVisible: true,
      sort: parent.children.filter((c) => c.kind === 'page').length,
      children: [],
      memberModelIds: [],
    };
    parent.children.push(page);
    this.resyncLayersFromTree();
    this.emit();
    return id;
  }

  toggleLayerTreeNode(id: string): void {
    const n = this.findTreeNode(id);
    if (!n) {
      return;
    }
    n.isVisible = !n.isVisible;
    this.resyncLayersFromTree();
    this.emit();
  }

  updateLayerNode(
    id: string,
    patch: Partial<Pick<LayerTreeNode, 'label' | 'name_i18n' | 'description_i18n'>>,
  ): void {
    const n = this.findTreeNode(id);
    if (!n) {
      return;
    }
    if (patch.label !== undefined) {
      n.label = patch.label;
    }
    if (patch.name_i18n !== undefined) {
      n.name_i18n = patch.name_i18n;
    }
    if (patch.description_i18n !== undefined) {
      n.description_i18n = patch.description_i18n;
    }
    this.resyncLayersFromTree();
    this.emit();
  }

  moveLayerNode(dragId: string, targetId: string, zone: LayerDropZone): boolean {
    const next = this.cloneTree(this._layerTreeRoots);
    if (!applyLayerTreeDrop(next, dragId, targetId, zone)) {
      return false;
    }
    this._layerTreeRoots = next;
    this.resyncLayersFromTree();
    this.emit();
    return true;
  }

  /** 删除组/页（含子树）；根分组不可删。 */
  removeLayerNode(id: string): boolean {
    if (isLayerRootGroupId(id)) {
      return false;
    }
    const node = this.findTreeNode(id);
    if (!node) {
      return false;
    }
    const removedPageIds = new Set(collectPageIdsInSubtree(node));
    for (const [modelId, layerSet] of this._nodeToLayers) {
      for (const pageId of removedPageIds) {
        layerSet.delete(pageId);
      }
      if (layerSet.size === 0) {
        this._nodeToLayers.delete(modelId);
      }
    }
    for (const [relationId, layerSet] of this._relationToLayers) {
      for (const pageId of removedPageIds) {
        layerSet.delete(pageId);
      }
      if (layerSet.size === 0) {
        this._relationToLayers.delete(relationId);
      }
    }
    const next = this.cloneTree(this._layerTreeRoots);
    if (!removeLayerNodeFromTree(next, id)) {
      return false;
    }
    this._layerTreeRoots = next;
    this.resyncLayersFromTree();
    this.rebuildAutoRelationLayers();
    this.emit();
    return true;
  }

  assignModelToPage(modelId: string, pageId: string): void {
    this.assignNodeToLayers(modelId, [pageId]);
  }

  assignRelationToPage(relationId: string, pageId: string): void {
    this.assignRelationToLayers(relationId, [pageId]);
  }

  private walkTree(fn: (n: LayerTreeNode) => void): void {
    const go = (nodes: readonly LayerTreeNode[]): void => {
      for (const n of nodes) {
        fn(n);
        if (n.kind === 'group') {
          go(n.children);
        }
      }
    };
    go(this._layerTreeRoots);
  }

  private findTreeNode(id: string): LayerTreeNode | undefined {
    let found: LayerTreeNode | undefined;
    this.walkTree((n) => {
      if (n.id === id) {
        found = n;
      }
    });
    return found;
  }

  subscribe(fn: DataListener): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this._listeners) {
      fn();
    }
  }

  get models(): readonly EngineModelNode[] {
    return this._models;
  }

  get relations(): readonly EngineRelationEdge[] {
    return this._relations;
  }

  get designerLayers(): readonly DesignerLayerRow[] {
    return this._layers;
  }

  private syncNodeLayerIndex(nodeId: string, layerIds: string[]): void {
    this._nodeToLayers.delete(nodeId);
    if (layerIds.length === 0) {
      return;
    }
    this._nodeToLayers.set(nodeId, new Set(layerIds));
    for (const lid of layerIds) {
      if (!this._layers.some((l) => l.id === lid)) {
        this._layers.push({ id: lid, label: lid, order: this._layers.length, isVisible: true });
      }
    }
    this._layers.sort((a, b) => a.order - b.order);
  }

  private syncRelationLayerIndex(relationId: string, layerIds: string[]): void {
    this._relationToLayers.delete(relationId);
    if (layerIds.length === 0) {
      return;
    }
    this._relationToLayers.set(relationId, new Set(layerIds));
    for (const lid of layerIds) {
      if (!this._layers.some((l) => l.id === lid)) {
        this._layers.push({ id: lid, label: lid, order: this._layers.length, isVisible: true });
      }
    }
    this._layers.sort((a, b) => a.order - b.order);
  }

  private effectiveRelationLayerIds(relationId: string): Set<string> {
    const layerIds = new Set<string>();
    const addLayer = (layerId: string): void => {
      layerIds.add(layerId);
    };
    const manual = this._relationToLayers.get(relationId);
    const automatic = this._autoRelationToLayers.get(relationId);
    if (manual) {
      for (const layerId of manual) {
        addLayer(layerId);
      }
    }
    if (automatic) {
      for (const layerId of automatic) {
        addLayer(layerId);
      }
    }
    return layerIds;
  }

  private rebuildAutoRelationLayers(): void {
    this._autoRelationToLayers.clear();
    for (const relation of this._relations) {
      const sourceLayers = this._nodeToLayers.get(relation.source_model_id);
      const targetLayers =
        relation.source_model_id === relation.target_model_id
          ? sourceLayers
          : this._nodeToLayers.get(relation.target_model_id);
      if (!sourceLayers || !targetLayers) {
        continue;
      }
      const autoLayers = new Set<string>();
      for (const layerId of sourceLayers) {
        if (layerId !== LAYER_DEFAULT_PAGE_ID && targetLayers.has(layerId)) {
          autoLayers.add(layerId);
        }
      }
      if (autoLayers.size > 0) {
        this._autoRelationToLayers.set(relation.id, autoLayers);
      }
    }
  }

  ensureLayer(row: DesignerLayerRow): void {
    const idx = this._layers.findIndex((l) => l.id === row.id);
    if (idx >= 0) {
      this._layers[idx] = row;
    } else {
      this._layers.push(row);
      this._layers.sort((a, b) => a.order - b.order);
    }
    this.emit();
  }

  toggleLayerVisibility(layerId: string): void {
    const layer = this._layers.find((l) => l.id === layerId);
    if (!layer) {
      return;
    }
    layer.isVisible = !layer.isVisible;
    this.emit();
  }

  setLayerVisibility(layerId: string, isVisible: boolean): void {
    const layer = this._layers.find((l) => l.id === layerId);
    if (!layer || layer.isVisible === isVisible) {
      return;
    }
    layer.isVisible = isVisible;
    this.emit();
  }

  assignNodeToLayers(nodeId: string, layerIds: string[]): void {
    this.syncNodeLayerIndex(nodeId, layerIds);
    this.syncTreeMembersForNode(nodeId, layerIds);
    this.rebuildAutoRelationLayers();
    this.emit();
  }

  assignRelationToLayers(relationId: string, layerIds: string[]): void {
    this.syncRelationLayerIndex(relationId, layerIds);
    this.syncTreeMembersForRelation(relationId, layerIds);
    this.emit();
  }

  toggleModelPageMembership(modelId: string, pageId: string): void {
    if (pageId === LAYER_DEFAULT_PAGE_ID) {
      return;
    }
    const next = new Set(this._nodeToLayers.get(modelId) ?? []);
    if (next.has(pageId)) {
      next.delete(pageId);
    } else {
      next.add(pageId);
    }
    this.syncNodeLayerIndex(modelId, [...next]);
    this.syncTreeMembersForNode(modelId, [...next]);
    this.rebuildAutoRelationLayers();
    this.emit();
  }

  toggleRelationPageMembership(relationId: string, pageId: string): void {
    if (pageId === LAYER_DEFAULT_PAGE_ID) {
      return;
    }
    const next = new Set(this._relationToLayers.get(relationId) ?? []);
    if (next.has(pageId)) {
      next.delete(pageId);
    } else {
      next.add(pageId);
    }
    this.syncRelationLayerIndex(relationId, [...next]);
    this.syncTreeMembersForRelation(relationId, [...next]);
    this.emit();
  }

  private syncTreeMembersForNode(nodeId: string, layerIds: readonly string[]): void {
    const set = new Set(layerIds);
    this.walkTree((node) => {
      if (node.kind !== 'page') {
        return;
      }
      const idx = node.memberModelIds.indexOf(nodeId);
      const want = set.has(node.id);
      if (idx >= 0 && !want) {
        node.memberModelIds.splice(idx, 1);
      } else if (want && idx < 0) {
        node.memberModelIds.push(nodeId);
      }
    });
  }

  private syncTreeMembersForRelation(relationId: string, layerIds: readonly string[]): void {
    const set = new Set(layerIds);
    this.walkTree((node) => {
      if (node.kind !== 'page') {
        return;
      }
      const members = node.memberRelationIds ?? [];
      const idx = members.indexOf(relationId);
      const want = set.has(node.id);
      if (idx >= 0 && !want) {
        members.splice(idx, 1);
      } else if (want && idx < 0) {
        members.push(relationId);
      }
      node.memberRelationIds = members;
    });
  }

  getLayersForNode(nodeId: string): readonly string[] {
    const s = this._nodeToLayers.get(nodeId);
    return s ? [...s] : [];
  }

  getLayersForRelation(relationId: string): readonly string[] {
    return [...this.effectiveRelationLayerIds(relationId)];
  }

  private isLayerVisible(layerId: string): boolean {
    const layer = this._layers.find((x) => x.id === layerId);
    return layer?.isVisible ?? layerId === LAYER_DEFAULT_PAGE_ID;
  }

  private layerMembershipForNode(nodeId: string): Set<string> {
    const layerIds = new Set<string>([LAYER_DEFAULT_PAGE_ID]);
    const explicit = this._nodeToLayers.get(nodeId);
    if (explicit) {
      for (const layerId of explicit) {
        layerIds.add(layerId);
      }
    }
    return layerIds;
  }

  private layerMembershipForRelation(relationId: string): Set<string> {
    const layerIds = new Set<string>([LAYER_DEFAULT_PAGE_ID]);
    const explicit = this.effectiveRelationLayerIds(relationId);
    if (explicit) {
      for (const layerId of explicit) {
        layerIds.add(layerId);
      }
    }
    return layerIds;
  }

  private visibleLayerWeight(layerIds: ReadonlySet<string>): number {
    let weight = 0;
    for (const layerId of layerIds) {
      if (this.isLayerVisible(layerId)) {
        weight += 1;
      }
    }
    return weight;
  }

  getLayerVisibilitySnapshot(): LayerVisibilitySnapshot {
    const hiddenNodeIds = new Set<string>();
    const hiddenRelationIds = new Set<string>();
    const mutedNodeIds = new Set<string>();
    const mutedRelationIds = new Set<string>();

    for (const model of this._models) {
      const weight = this.visibleLayerWeight(this.layerMembershipForNode(model.id));
      if (weight <= 0) {
        hiddenNodeIds.add(model.id);
      } else if (weight === 1) {
        mutedNodeIds.add(model.id);
      }
    }

    for (const relation of this._relations) {
      const weight = this.visibleLayerWeight(this.layerMembershipForRelation(relation.id));
      if (weight <= 0) {
        hiddenRelationIds.add(relation.id);
      } else if (weight === 1) {
        mutedRelationIds.add(relation.id);
      }
    }

    return { hiddenNodeIds, hiddenRelationIds, mutedNodeIds, mutedRelationIds };
  }

  getLayerPageMembershipSnapshot(pageId: string): LayerPageMembershipSnapshot {
    const nodeIds = new Set<string>();
    const relationIds = new Set<string>();

    if (pageId === LAYER_DEFAULT_PAGE_ID) {
      for (const model of this._models) {
        nodeIds.add(model.id);
      }
      for (const relation of this._relations) {
        relationIds.add(relation.id);
      }
      return { nodeIds, relationIds };
    }

    for (const model of this._models) {
      if (this._nodeToLayers.get(model.id)?.has(pageId)) {
        nodeIds.add(model.id);
      }
    }
    for (const relation of this._relations) {
      if (this.effectiveRelationLayerIds(relation.id).has(pageId)) {
        relationIds.add(relation.id);
      }
    }
    return { nodeIds, relationIds };
  }

  /**
   * 未归属任何图层的节点始终绘制；已归属的节点仅当其至少所属图层之一 `isVisible` 时绘制。
   */
  getHiddenNodeIdsForLayerVisibility(): Set<string> {
    return this.getLayerVisibilitySnapshot().hiddenNodeIds;
  }

  getLayout(modelId: string): DesignerModelLayout | undefined {
    return this._layoutByModelId.get(modelId);
  }

  setLayout(layout: DesignerModelLayout): void {
    this._layoutByModelId.set(layout.uuid, layout);
    this.emit();
  }

  upsertModel(node: EngineModelNode, layout?: Partial<DesignerModelLayout>): void {
    const merged: EngineModelNode = { ...node };
    const idx = this._models.findIndex((m) => m.id === merged.id);
    if (idx >= 0) {
      this._models[idx] = merged;
    } else {
      this._models.push(merged);
    }
    const existing = this._layoutByModelId.get(node.id);
    const base: DesignerModelLayout = existing ?? {
      uuid: node.id,
      position: { x: 80, y: 80 },
      color_theme: 'default',
      z_index: 0,
    };
    this._layoutByModelId.set(node.id, {
      ...base,
      ...layout,
      uuid: node.id,
      position: layout?.position ?? base.position,
    });
    this.emit();
  }

  updateModelName(id: string, model_name: string): void {
    const m = this._models.find((x) => x.id === id);
    if (!m) {
      return;
    }
    m.model_name = model_name;
    this.emit();
  }

  /** 合并 `sys_model` 对齐的可选字段（name_i18n / description_i18n / color_value 等） */
  updateModelPatch(id: string, patch: Partial<EngineModelNode>): void {
    const m = this._models.find((x) => x.id === id);
    if (!m) {
      return;
    }
    Object.assign(m, patch);
    this.emit();
  }

  /** 合并表现域布局（对齐 posX/posY、canvas_meta 序列化来源） */
  patchLayout(modelId: string, patch: Partial<DesignerModelLayout>): void {
    const cur = this.getLayout(modelId);
    if (!cur) {
      return;
    }
    this.setLayout({ ...cur, ...patch, uuid: modelId });
  }

  updateProps(id: string, props: PropObject[]): void {
    const m = this._models.find((x) => x.id === id);
    if (!m) {
      return;
    }
    m.props_objects_array = props;
    this.emit();
  }

  removeModel(id: string): void {
    const removedRelationIds = new Set(
      this._relations
        .filter((r) => r.source_model_id === id || r.target_model_id === id)
        .map((r) => r.id),
    );
    this._models = this._models.filter((m) => m.id !== id);
    this._relations = this._relations.filter(
      (r) => r.source_model_id !== id && r.target_model_id !== id,
    );
    this._layoutByModelId.delete(id);
    this._nodeToLayers.delete(id);
    this.walkTree((node) => {
      if (node.kind === 'page') {
        const i = node.memberModelIds.indexOf(id);
        if (i >= 0) {
          node.memberModelIds.splice(i, 1);
        }
        if (removedRelationIds.size > 0) {
          node.memberRelationIds = (node.memberRelationIds ?? []).filter(
            (relationId) => !removedRelationIds.has(relationId),
          );
        }
      }
    });
    for (const relationId of removedRelationIds) {
      this._relationToLayers.delete(relationId);
      this._autoRelationToLayers.delete(relationId);
    }
    this.rebuildAutoRelationLayers();
    this.emit();
  }

  addRelation(edge: EngineRelationEdge): void {
    this._relations.push(edge);
    this.syncRelationLayerIndex(edge.id, [LAYER_DEFAULT_PAGE_ID]);
    this.syncTreeMembersForRelation(edge.id, [LAYER_DEFAULT_PAGE_ID]);
    this.rebuildAutoRelationLayers();
    this.emit();
  }

  removeRelation(id: string): void {
    this._relations = this._relations.filter((r) => r.id !== id);
    this._relationToLayers.delete(id);
    this._autoRelationToLayers.delete(id);
    this.walkTree((node) => {
      if (node.kind !== 'page') {
        return;
      }
      const members = node.memberRelationIds ?? [];
      const i = members.indexOf(id);
      if (i >= 0) {
        members.splice(i, 1);
      }
      node.memberRelationIds = members;
    });
    this.emit();
  }

  updateRelation(edgeId: string, patch: Partial<EngineRelationEdge>): void {
    const r = this._relations.find((x) => x.id === edgeId);
    if (!r) {
      return;
    }
    Object.assign(r, patch);
    this.rebuildAutoRelationLayers();
    this.emit();
  }

  getRelationCanvasMeta(relationId: string): RelationCanvasMeta {
    const r = this._relations.find((x) => x.id === relationId);
    return parseRelationCanvasMeta(r?.canvas_meta_str);
  }

  patchRelationCanvasMeta(relationId: string, patch: Partial<RelationCanvasMeta>): void {
    const r = this._relations.find((x) => x.id === relationId);
    if (!r) {
      return;
    }
    const next = { ...parseRelationCanvasMeta(r.canvas_meta_str), ...patch };
    r.canvas_meta_str = serializeRelationCanvasMeta(next);
    this.emit();
  }

  isModelPositionLocked(modelId: string): boolean {
    return this.getLayout(modelId)?.position_locked === true;
  }

  isRelationLocked(relationId: string): boolean {
    return this.getRelationCanvasMeta(relationId).locked === true;
  }

  cloneModel(sourceId: string, at: { x: number; y: number }): string | undefined {
    const src = this._models.find((m) => m.id === sourceId);
    if (!src) {
      return undefined;
    }
    const nid = newId();
    const clonedProps: PropObject[] = src.props_objects_array.map((p) => ({
      ...p,
      id: newId(),
    }));
    const nameI18n =
      src.name_i18n && Object.keys(src.name_i18n).length > 0
        ? mapI18nSuffix(src.name_i18n, '_copy')
        : undefined;
    const clone: EngineModelNode = {
      id: nid,
      model_name: `model_${Date.now()}`,
      parent_id: src.parent_id,
      props_objects_array: clonedProps,
      ...(nameI18n ? { name_i18n: nameI18n } : {}),
      description_i18n: src.description_i18n ? { ...src.description_i18n } : undefined,
      color_value: src.color_value,
    };
    const srcLayout = this._layoutByModelId.get(sourceId);
    this.upsertModel(clone, {
      position: { x: at.x, y: at.y },
      color_theme: srcLayout?.color_theme ?? 'default',
      z_index: (srcLayout?.z_index ?? 0) + 1,
    });
    const parentLayers = this.getLayersForNode(sourceId);
    if (parentLayers.length > 0) {
      this.assignNodeToLayers(nid, [...parentLayers]);
    }
    return nid;
  }

  createChildModel(
    parentId: string,
    at: { x: number; y: number },
  ): { modelId: string; inheritEdgeId: string } | undefined {
    const parent = this._models.find((m) => m.id === parentId);
    if (!parent) {
      return undefined;
    }
    const nid = newId();
    const edgeId = newId();
    const pBase = pickCanonicalFromI18n(parent.name_i18n, parent.model_name);
    const childI18n = { zh: `${pBase}子`, en: `${pBase}_child` };
    const child: EngineModelNode = {
      id: nid,
      model_name: `model_${Date.now()}`,
      parent_id: parentId,
      props_objects_array: [],
      name_i18n: childI18n,
      color_value: pickNewModelColor(this._models, (id) => this._layoutByModelId.get(id)),
    };
    const pLayout = this._layoutByModelId.get(parentId);
    this.upsertModel(child, {
      position: { x: at.x, y: at.y },
      color_theme: pLayout?.color_theme ?? 'default',
      z_index: (pLayout?.z_index ?? 0) + 1,
    });
    const parentLayers = this.getLayersForNode(parentId);
    if (parentLayers.length > 0) {
      this.assignNodeToLayers(nid, [...parentLayers]);
    }
    // 继承边为单向虚线：唯一名默认 `inherits`（与成对关系线命名规则不同），不设 reverse_name。
    const usedNames = new Set<string>();
    for (const rel of this._relations) {
      if (rel.forward_name) usedNames.add(rel.forward_name);
      if (rel.reverse_name) usedNames.add(rel.reverse_name);
    }
    const inheritName = makeUniqueName(INHERIT_RELATION_DEFAULT_NAME, usedNames);
    this.addRelation({
      id: edgeId,
      source_model_id: parentId,
      target_model_id: nid,
      forward_name: inheritName,
      forward_name_i18n: { ...INHERIT_RELATION_LABEL_I18N },
      kind: GRAPH_INHERIT_KIND,
    });
    return { modelId: nid, inheritEdgeId: edgeId };
  }

  toMldgDocument(): MldgDocument {
    const doc = createEmptyMldgDocument();
    doc.engine_schema.models = this._models.map((m) => ({ ...m }));
    doc.engine_schema.relations = this._relations.map((r) => ({ ...r }));
    doc.designer_layout.models = Array.from(this._layoutByModelId.values()).map((l) => ({ ...l }));
    if (this._layers.length > 0) {
      doc.designer_layout.layers = this._layers.map((l) => ({ ...l }));
    }
    const model_layers: Record<string, string[]> = {};
    for (const [nid, set] of this._nodeToLayers) {
      if (set.size > 0) {
        model_layers[nid] = [...set];
      }
    }
    if (Object.keys(model_layers).length > 0) {
      doc.designer_layout.model_layers = model_layers;
    }
    const relation_layers: Record<string, string[]> = {};
    for (const [rid, set] of this._relationToLayers) {
      if (set.size > 0) {
        relation_layers[rid] = [...set];
      }
    }
    if (Object.keys(relation_layers).length > 0) {
      doc.designer_layout.relation_layers = relation_layers;
    }
    doc.designer_layout.layer_tree = this.cloneTree(this._layerTreeRoots);
    return doc;
  }

  loadMldgDocument(doc: MldgDocument): void {
    this._models = doc.engine_schema.models.map((m) => ({ ...m }));
    this._relations = doc.engine_schema.relations.map((r) => ({ ...r }));
    this._layoutByModelId.clear();
    this._nodeToLayers.clear();
    this._relationToLayers.clear();
    this._autoRelationToLayers.clear();
    for (const m of doc.designer_layout.models) {
      this._layoutByModelId.set(m.uuid, { ...m });
    }
    this._layers = (doc.designer_layout.layers ?? []).map((l) => ({ ...l }));
    if (doc.designer_layout.layer_tree && doc.designer_layout.layer_tree.length > 0) {
      this._layerTreeRoots = normalizeLayerTreeRoots(doc.designer_layout.layer_tree);
      this.resyncLayersFromTree();
    }
    const ml = doc.designer_layout.model_layers ?? {};
    for (const [nid, lids] of Object.entries(ml)) {
      this.syncNodeLayerIndex(nid, lids);
    }
    const rl = doc.designer_layout.relation_layers ?? {};
    for (const [rid, lids] of Object.entries(rl)) {
      this.syncRelationLayerIndex(rid, lids);
    }
    for (const relation of this._relations) {
      if (!this._relationToLayers.has(relation.id)) {
        this.syncRelationLayerIndex(relation.id, [LAYER_DEFAULT_PAGE_ID]);
        this.syncTreeMembersForRelation(relation.id, [LAYER_DEFAULT_PAGE_ID]);
      }
    }
    this.rebuildAutoRelationLayers();
    this.emit();
  }

  private rebuildLayerMembershipFromTree(): void {
    this.walkTree((node) => {
      if (node.kind !== 'page') {
        return;
      }
      for (const modelId of node.memberModelIds) {
        const set = this._nodeToLayers.get(modelId) ?? new Set<string>();
        set.add(node.id);
        this._nodeToLayers.set(modelId, set);
      }
      for (const relationId of node.memberRelationIds ?? []) {
        const set = this._relationToLayers.get(relationId) ?? new Set<string>();
        set.add(node.id);
        this._relationToLayers.set(relationId, set);
      }
    });
  }

  /**
   * 从设计器库 catalog 行 hydration 后一次性装入画布（无 mldg 快照时使用）。
   */
  loadHydratedGraph(
    models: readonly EngineModelNode[],
    relations: readonly EngineRelationEdge[],
    layouts: readonly DesignerModelLayout[],
    designerLayout?: DesignerLayout,
  ): void {
    this._models = models.map((m) => ({
      ...m,
      props_objects_array: m.props_objects_array.map((p) => ({ ...p })),
    }));
    this._relations = relations.map((r) => ({ ...r }));
    this._layoutByModelId.clear();
    this._nodeToLayers.clear();
    this._relationToLayers.clear();
    this._autoRelationToLayers.clear();
    if (designerLayout?.layer_tree && designerLayout.layer_tree.length > 0) {
      this._layerTreeRoots = normalizeLayerTreeRoots(designerLayout.layer_tree);
      this.resyncLayersFromTree();
      this.rebuildLayerMembershipFromTree();
    } else {
      this._layerTreeRoots = createDefaultLayerTree();
      this.resyncLayersFromTree();
    }
    for (const layout of layouts) {
      this._layoutByModelId.set(layout.uuid, { ...layout });
    }
    const ml = designerLayout?.model_layers ?? {};
    for (const [nid, lids] of Object.entries(ml)) {
      this.syncNodeLayerIndex(nid, lids);
      this.syncTreeMembersForNode(nid, lids);
    }
    const rl = designerLayout?.relation_layers ?? {};
    for (const [rid, lids] of Object.entries(rl)) {
      this.syncRelationLayerIndex(rid, lids);
      this.syncTreeMembersForRelation(rid, lids);
    }
    for (const model of this._models) {
      if (!this._nodeToLayers.has(model.id)) {
        this.syncNodeLayerIndex(model.id, [LAYER_DEFAULT_PAGE_ID]);
        this.syncTreeMembersForNode(model.id, [LAYER_DEFAULT_PAGE_ID]);
      }
    }
    for (const relation of this._relations) {
      if (!this._relationToLayers.has(relation.id)) {
        this.syncRelationLayerIndex(relation.id, [LAYER_DEFAULT_PAGE_ID]);
        this.syncTreeMembersForRelation(relation.id, [LAYER_DEFAULT_PAGE_ID]);
      }
    }
    this.rebuildAutoRelationLayers();
    this.emit();
  }

  /** 事务回滚用深快照（pull 失败时恢复画布）。 */
  snapshotForTransaction(): MldgDocument {
    return structuredClone(this.toMldgDocument());
  }

  /**
   * 发送前将图谱转为引擎可识别的模型-关系结构，再 UTF-8 流化，经 SDK 加密通道写入元数据行。
   * `libraryCode` 是业务库逻辑标签（= `sys_data_asset_map.code`），用于在设计器专属库内
   * 隔离多业务库快照。
   */
  async pushGraphToEngine(client: RemoteModelDBClient, libraryCode: string): Promise<void> {
    const doc = this.toMldgDocument();
    extractEngineModelRelationPayload(doc);
    const bytes = serializeMldgDocumentToUint8Array(doc);
    await pushDesignerSnapshot(client, bytes, libraryCode);
  }

  /**
   * 加载业务库画布：优先 mldg 快照，否则从设计器 catalog 行 hydration。
   */
  async loadLibraryCanvas(
    client: RemoteModelDBClient,
    libraryCode: string,
    catalog?: ManagementCatalogResponse,
  ): Promise<void> {
    const before = this.snapshotForTransaction();
    try {
      await loadLibraryCanvasFromRows(client, this, libraryCode, catalog);
    } catch (e) {
      if (this._models.length === 0) {
        this.loadMldgDocument(before);
      }
      throw e;
    }
  }

  /**
   * 从引擎拉取指定业务库的最新快照；失败时恢复至拉取前内存状态，保证画布与引擎一致或显式报错。
   */
  async pullGraphFromEngine(client: RemoteModelDBClient, libraryCode: string): Promise<void> {
    const before = this.snapshotForTransaction();
    try {
      const bytes = await pullLatestDesignerSnapshot(client, libraryCode);
      const doc = parseMldgDocumentFromUint8Array(bytes);
      this.loadMldgDocument(doc);
    } catch (e) {
      this.loadMldgDocument(before);
      throw e;
    }
  }
}
