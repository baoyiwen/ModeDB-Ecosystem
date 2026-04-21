import type { RemoteModelDBClient } from '@mode-db/sdk';
import type { DesignerLayerRow, DesignerModelLayout } from '../types/designer-layout.js';
import type { LayerTreeNode } from '../types/layer-tree.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { MldgDocument } from '../types/mldg-document.js';
import { createEmptyMldgDocument } from '../types/mldg-document.js';
import type { PropObject } from '../types/prop-object.js';
import { GRAPH_INHERIT_KIND } from '../config/graph-edge-kinds.js';
import { extractEngineModelRelationPayload } from '../sync/engine-model-relation.js';
import {
  parseMldgDocumentFromUint8Array,
  serializeMldgDocumentToUint8Array,
} from '../sync/mldg-wire-bytes.js';
import { pullLatestDesignerSnapshot, pushDesignerSnapshot } from '../sync/sdk-designer-sync.js';

export type DataListener = () => void;

function newId(): string {
  return crypto.randomUUID();
}

const DEFAULT_PAGE_ID = 'page-main';
const DEFAULT_GROUP_ID = 'group-root';

function createDefaultLayerTree(): LayerTreeNode[] {
  return [
    {
      id: DEFAULT_GROUP_ID,
      kind: 'group',
      label: 'Root',
      isVisible: true,
      sort: 0,
      memberModelIds: [],
      children: [
        {
          id: DEFAULT_PAGE_ID,
          kind: 'page',
          label: 'Main',
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
  private _layerTreeRoots: LayerTreeNode[] = createDefaultLayerTree();
  private readonly _listeners = new Set<DataListener>();

  constructor() {
    this.resyncLayersFromTree();
  }

  /** 切换逻辑库后清空画布与层级树（新会话）。 */
  resetToNewLibrary(): void {
    this._models = [];
    this._relations = [];
    this._layoutByModelId.clear();
    this._nodeToLayers.clear();
    this._layerTreeRoots = createDefaultLayerTree();
    this.resyncLayersFromTree();
    this.emit();
  }

  get layerTreeRoots(): readonly LayerTreeNode[] {
    return this._layerTreeRoots;
  }

  get defaultPageLayerId(): string {
    return DEFAULT_PAGE_ID;
  }

  private cloneTree(nodes: readonly LayerTreeNode[]): LayerTreeNode[] {
    return nodes.map((n) => ({
      ...n,
      children: n.kind === 'group' ? this.cloneTree(n.children) : [],
      memberModelIds: n.kind === 'page' ? [...n.memberModelIds] : [],
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
    this._layerTreeRoots = this.cloneTree(roots);
    this.resyncLayersFromTree();
    this.emit();
  }

  addLayerGroup(parentId: string | null, label: string): string {
    const id = newId();
    const node: LayerTreeNode = {
      id,
      kind: 'group',
      label,
      isVisible: true,
      sort: this._layerTreeRoots.length,
      memberModelIds: [],
      children: [],
    };
    if (parentId === null) {
      this._layerTreeRoots.push(node);
    } else {
      const parent = this.findTreeNode(parentId);
      if (!parent || parent.kind !== 'group') {
        return id;
      }
      parent.children.push(node);
    }
    this.resyncLayersFromTree();
    this.emit();
    return id;
  }

  addLayerPage(parentGroupId: string, label: string): string {
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

  assignModelToPage(modelId: string, pageId: string): void {
    this.assignNodeToLayers(modelId, [pageId]);
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

  getLayersForNode(nodeId: string): readonly string[] {
    const s = this._nodeToLayers.get(nodeId);
    return s ? [...s] : [];
  }

  /**
   * 未归属任何图层的节点始终绘制；已归属的节点仅当其至少所属图层之一 `isVisible` 时绘制。
   */
  getHiddenNodeIdsForLayerVisibility(): Set<string> {
    const hidden = new Set<string>();
    const layerVisible = (id: string): boolean => {
      const l = this._layers.find((x) => x.id === id);
      return l?.isVisible ?? false;
    };
    for (const m of this._models) {
      const ls = this._nodeToLayers.get(m.id);
      if (!ls || ls.size === 0) {
        continue;
      }
      let anyVis = false;
      for (const lid of ls) {
        if (layerVisible(lid)) {
          anyVis = true;
          break;
        }
      }
      if (!anyVis) {
        hidden.add(m.id);
      }
    }
    return hidden;
  }

  getLayout(modelId: string): DesignerModelLayout | undefined {
    return this._layoutByModelId.get(modelId);
  }

  setLayout(layout: DesignerModelLayout): void {
    this._layoutByModelId.set(layout.uuid, layout);
    this.emit();
  }

  upsertModel(node: EngineModelNode, layout?: Partial<DesignerModelLayout>): void {
    const idx = this._models.findIndex((m) => m.id === node.id);
    if (idx >= 0) {
      this._models[idx] = node;
    } else {
      this._models.push(node);
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
      }
    });
    this.emit();
  }

  addRelation(edge: EngineRelationEdge): void {
    this._relations.push(edge);
    this.emit();
  }

  removeRelation(id: string): void {
    this._relations = this._relations.filter((r) => r.id !== id);
    this.emit();
  }

  updateRelation(edgeId: string, patch: Partial<EngineRelationEdge>): void {
    const r = this._relations.find((x) => x.id === edgeId);
    if (!r) {
      return;
    }
    Object.assign(r, patch);
    this.emit();
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
    const clone: EngineModelNode = {
      id: nid,
      model_name: `${src.model_name}_copy`,
      parent_id: src.parent_id,
      props_objects_array: clonedProps,
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
    const child: EngineModelNode = {
      id: nid,
      model_name: `${parent.model_name}_child`,
      parent_id: parentId,
      props_objects_array: [],
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
    this.addRelation({
      id: edgeId,
      source_model_id: parentId,
      target_model_id: nid,
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
    doc.designer_layout.layer_tree = this.cloneTree(this._layerTreeRoots);
    return doc;
  }

  loadMldgDocument(doc: MldgDocument): void {
    this._models = doc.engine_schema.models.map((m) => ({ ...m }));
    this._relations = doc.engine_schema.relations.map((r) => ({ ...r }));
    this._layoutByModelId.clear();
    this._nodeToLayers.clear();
    for (const m of doc.designer_layout.models) {
      this._layoutByModelId.set(m.uuid, { ...m });
    }
    this._layers = (doc.designer_layout.layers ?? []).map((l) => ({ ...l }));
    if (doc.designer_layout.layer_tree && doc.designer_layout.layer_tree.length > 0) {
      this._layerTreeRoots = this.cloneTree(doc.designer_layout.layer_tree);
      this.resyncLayersFromTree();
    }
    const ml = doc.designer_layout.model_layers ?? {};
    for (const [nid, lids] of Object.entries(ml)) {
      this.syncNodeLayerIndex(nid, lids);
    }
    this.emit();
  }

  /** 事务回滚用深快照（pull 失败时恢复画布）。 */
  snapshotForTransaction(): MldgDocument {
    return structuredClone(this.toMldgDocument());
  }

  /**
   * 发送前将图谱转为引擎可识别的模型-关系结构，再 UTF-8 流化，经 SDK 加密通道写入元数据行。
   */
  async pushGraphToEngine(client: RemoteModelDBClient): Promise<void> {
    const doc = this.toMldgDocument();
    extractEngineModelRelationPayload(doc);
    const bytes = serializeMldgDocumentToUint8Array(doc);
    await pushDesignerSnapshot(client, bytes);
  }

  /**
   * 从引擎拉取最新快照；失败时恢复至拉取前内存状态，保证画布与引擎一致或显式报错。
   */
  async pullGraphFromEngine(client: RemoteModelDBClient): Promise<void> {
    const before = this.snapshotForTransaction();
    try {
      const bytes = await pullLatestDesignerSnapshot(client);
      const doc = parseMldgDocumentFromUint8Array(bytes);
      this.loadMldgDocument(doc);
    } catch (e) {
      this.loadMldgDocument(before);
      throw e;
    }
  }
}
