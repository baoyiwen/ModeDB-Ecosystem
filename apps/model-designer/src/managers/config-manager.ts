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

export interface ConfigManagerSnapshot {
  gridEnabled: boolean;
  gridSize: number;
  snapToGrid: boolean;
  longPressMs: number;
  themes: ThemePalette[];
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
    };
  }
}
