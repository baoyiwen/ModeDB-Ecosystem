import type { DataManager } from './data-manager.js';

export type LayerManagerListener = () => void;

/**
 * 管理引擎 `sys_layers` 在画布侧的激活态与显隐；显隐由 {@link DataManager} 中图层行的 `isVisible` + 节点归属共同决定。
 */
export class LayerManager {
  private _activeLayerId: string | null = null;
  private readonly _listeners = new Set<LayerManagerListener>();

  constructor(private readonly data: DataManager) {}

  private emit(): void {
    for (const fn of this._listeners) {
      fn();
    }
  }

  subscribe(fn: LayerManagerListener): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  get activeLayerId(): string | null {
    return this._activeLayerId;
  }

  setActiveLayer(layerId: string | null): void {
    if (this._activeLayerId === layerId) {
      return;
    }
    this._activeLayerId = layerId;
    this.emit();
  }

  /**
   * 切换图层可见性；下属节点与经过该节点的关系在绘制阶段被过滤（见 {@link DataManager.getHiddenNodeIdsForLayerVisibility}）。
   */
  toggleLayer(layerId: string): void {
    this.data.toggleLayerVisibility(layerId);
  }

  /** 新建或拖入的节点可挂到当前激活图层（若存在）。 */
  assignNodeToActiveLayer(nodeId: string): void {
    const lid = this._activeLayerId;
    if (!lid) {
      return;
    }
    this.data.assignNodeToLayers(nodeId, [lid]);
  }

  getHiddenNodeIds(): Set<string> {
    return this.data.getHiddenNodeIdsForLayerVisibility();
  }
}
