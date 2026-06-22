export interface ThemePalette {
  id: string;
  header: string;
  body: string;
  border: string;
  text: string;
}

const DEFAULT_THEMES: ThemePalette[] = [
  { id: 'default', header: '#2563eb', body: '#eff6ff', border: '#2563eb', text: '#ffffff' },
  { id: 'green', header: '#22c55e', body: '#f0fdf4', border: '#22c55e', text: '#ffffff' },
  { id: 'pink', header: '#ec4899', body: '#fdf2f8', border: '#ec4899', text: '#ffffff' },
  { id: 'coral', header: '#f97316', body: '#fff7ed', border: '#f97316', text: '#ffffff' },
  { id: 'cyan', header: '#06b6d4', body: '#ecfeff', border: '#06b6d4', text: '#ffffff' },
  { id: 'accent', header: '#7c3aed', body: '#f5f3ff', border: '#7c3aed', text: '#ffffff' },
];

import type { RemoteModelDBClient } from '@mode-db/sdk';

export type ConfigViewportListener = () => void;

export interface ConfigManagerSnapshot {
  gridEnabled: boolean;
  gridSize: number;
  snapToGrid: boolean;
  longPressMs: number;
  themes: ThemePalette[];
  viewportPanX: number;
  viewportPanY: number;
  viewportZoom: number;
  forceLayoutEnabled: boolean;
}

/**
 * 引擎连接参数占位、主题表、Canvas 渲染与交互参数。
 */
export class ConfigManager {
  private _gridEnabled = true;
  private _gridSize = 24;
  private _snapToGrid = true;
  private _longPressMs = 500;
  private readonly _themes: ThemePalette[] = [...DEFAULT_THEMES];
  private _remoteClient: RemoteModelDBClient | null = null;
  private _workspaceValidated = false;
  /** 当前打开的逻辑库（用于标题展示）。 */
  private _activeLibraryName: string | null = null;
  private _viewportPanX = 0;
  private _viewportPanY = 0;
  private _viewportZoom = 1;
  private _forceLayoutEnabled = false;
  private readonly _viewportListeners = new Set<ConfigViewportListener>();

  get gridEnabled(): boolean {
    return this._gridEnabled;
  }

  set gridEnabled(v: boolean) {
    this._gridEnabled = v;
  }

  get gridSize(): number {
    return this._gridSize;
  }

  set gridSize(v: number) {
    this._gridSize = Math.max(4, v);
  }

  get snapToGrid(): boolean {
    return this._snapToGrid;
  }

  set snapToGrid(v: boolean) {
    this._snapToGrid = v;
    this.emitViewport();
  }

  get longPressMs(): number {
    return this._longPressMs;
  }

  set longPressMs(v: number) {
    this._longPressMs = Math.max(100, v);
  }

  getThemes(): readonly ThemePalette[] {
    return this._themes;
  }

  getTheme(id: string): ThemePalette | undefined {
    return this._themes.find((t) => t.id === id);
  }

  get remoteClient(): RemoteModelDBClient | null {
    return this._remoteClient;
  }

  get workspaceReady(): boolean {
    return this._remoteClient !== null && this._workspaceValidated;
  }

  get activeLibraryName(): string | null {
    return this._activeLibraryName;
  }

  setActiveLibraryName(name: string | null): void {
    this._activeLibraryName = name;
  }

  get viewportPanX(): number {
    return this._viewportPanX;
  }

  get viewportPanY(): number {
    return this._viewportPanY;
  }

  get viewportZoom(): number {
    return this._viewportZoom;
  }

  get forceLayoutEnabled(): boolean {
    return this._forceLayoutEnabled;
  }

  set forceLayoutEnabled(v: boolean) {
    if (this._forceLayoutEnabled === v) {
      return;
    }
    this._forceLayoutEnabled = v;
    this.emitViewport();
  }

  setViewportPan(x: number, y: number): void {
    this._viewportPanX = x;
    this._viewportPanY = y;
    this.emitViewport();
  }

  addViewportPan(dx: number, dy: number): void {
    this._viewportPanX += dx;
    this._viewportPanY += dy;
    this.emitViewport();
  }

  setViewportZoom(z: number): void {
    this._viewportZoom = Math.min(4, Math.max(0.25, z));
    this.emitViewport();
  }

  /**
   * 以画布像素坐标 `(canvasX, canvasY)` 为锚点缩放（该点对应的世界坐标在缩放前后保持在屏上同一位置）。
   * 坐标系与 {@link paintScene} 中 `translate(pan)+scale(zoom)` 及指针 `clientToCanvas` 一致。
   */
  setViewportZoomAtCanvasPoint(canvasX: number, canvasY: number, nextZoom: number): void {
    const z0 = this._viewportZoom;
    const z1 = Math.min(4, Math.max(0.25, nextZoom));
    const wx = (canvasX - this._viewportPanX) / z0;
    const wy = (canvasY - this._viewportPanY) / z0;
    this._viewportPanX = canvasX - wx * z1;
    this._viewportPanY = canvasY - wy * z1;
    this._viewportZoom = z1;
    this.emitViewport();
  }

  resetViewport(): void {
    this._viewportPanX = 0;
    this._viewportPanY = 0;
    this._viewportZoom = 1;
    this.emitViewport();
  }

  subscribeViewport(fn: ConfigViewportListener): () => void {
    this._viewportListeners.add(fn);
    return () => {
      this._viewportListeners.delete(fn);
    };
  }

  private emitViewport(): void {
    for (const fn of this._viewportListeners) {
      fn();
    }
  }

  /**
   * 绑定 SDK 会话；重连前应由调用方 `close()` 旧客户端。
   */
  setRemoteClient(client: RemoteModelDBClient | null, workspaceValidated: boolean): void {
    this._remoteClient = client;
    this._workspaceValidated = workspaceValidated;
  }

  snapshot(): ConfigManagerSnapshot {
    return {
      gridEnabled: this._gridEnabled,
      gridSize: this._gridSize,
      snapToGrid: this._snapToGrid,
      longPressMs: this._longPressMs,
      themes: [...this._themes],
      viewportPanX: this._viewportPanX,
      viewportPanY: this._viewportPanY,
      viewportZoom: this._viewportZoom,
      forceLayoutEnabled: this._forceLayoutEnabled,
    };
  }
}
