/**
 * 主题（外观）：浅灰白基调 + 可选主题色（accent）。
 *
 * - 单一可调 CSS 变量 `--designer-accent`，连同派生的 `--designer-accent-soft` /
 *   `--designer-accent-glow`，由本管理器写入 `documentElement` 上的内联样式覆盖
 *   `designer-shell.css` 中的默认值。
 * - accent 写入 `localStorage`（与 `I18nManager` 同一存储约束：仅 UI 偏好，不持久化图谱）。
 */
const STORAGE_KEY = 'model-designer:accent';

export interface AccentPreset {
  readonly id: string;
  readonly color: string;
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'indigo', color: '#6366f1' },
  { id: 'violet', color: '#8b5cf6' },
  { id: 'sky', color: '#0ea5e9' },
  { id: 'teal', color: '#14b8a6' },
  { id: 'emerald', color: '#10b981' },
  { id: 'amber', color: '#f59e0b' },
  { id: 'rose', color: '#f43f5e' },
  { id: 'slate', color: '#475569' },
] as const;

const DEFAULT_ACCENT = ACCENT_PRESETS[0].color;

export type AppearanceListener = () => void;

function normalizeHex(input: string): string | null {
  let v = input.trim();
  if (!v.startsWith('#')) {
    v = `#${v}`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    return v.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const r = v[1];
    const g = v[2];
    const b = v[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function readStored(): string | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return normalizeHex(raw);
  } catch {
    return null;
  }
}

function writeStored(color: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, color);
  } catch {
    /* ignore quota / privacy errors */
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class AppearanceManager {
  private _accent: string;
  private readonly _listeners = new Set<AppearanceListener>();

  constructor() {
    this._accent = readStored() ?? DEFAULT_ACCENT;
    this.applyToDocument();
  }

  get accent(): string {
    return this._accent;
  }

  get presets(): readonly AccentPreset[] {
    return ACCENT_PRESETS;
  }

  setAccent(input: string): void {
    const normalized = normalizeHex(input);
    if (!normalized || normalized === this._accent) {
      return;
    }
    this._accent = normalized;
    writeStored(normalized);
    this.applyToDocument();
    for (const fn of this._listeners) {
      fn();
    }
  }

  subscribe(fn: AppearanceListener): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  private applyToDocument(): void {
    if (typeof document === 'undefined') {
      return;
    }
    const root = document.documentElement.style;
    root.setProperty('--designer-accent', this._accent);
    root.setProperty('--designer-accent-soft', hexToRgba(this._accent, 0.18));
    root.setProperty('--designer-accent-glow', hexToRgba(this._accent, 0.38));
  }
}
