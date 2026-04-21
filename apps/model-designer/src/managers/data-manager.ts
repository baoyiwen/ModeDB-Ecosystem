import type { RemoteModelDBClient } from '@mode-db/sdk';
import type { DesignerLayerRow, DesignerModelLayout } from '../types/designer-layout.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { MldgDocument } from '../types/mldg-document.js';
import { createEmptyMldgDocument } from '../types/mldg-document.js';
import type { PropObject } from '../types/prop-object.js';
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
  private readonly _listeners = new Set<DataListener>();

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
    this.emit();
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
    this.emit();
  }

  addRelation(edge: EngineRelationEdge): void {
    this._relations.push(edge);
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

  createChildModel(parentId: string, at: { x: number; y: number }): string | undefined {
    const parent = this._models.find((m) => m.id === parentId);
    if (!parent) {
      return undefined;
    }
    const nid = newId();
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
    return nid;
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
