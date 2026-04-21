/** 解析 #rrggbb */
export function normalizeHex(hex: string | undefined, fallback: string): string {
  const t = (hex ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(t)) {
    return t.toLowerCase();
  }
  return fallback;
}

/** 相对背景取可读文字色（WCAG 感知亮度近似） */
export function contrastTextOnHex(hex: string): string {
  const h = normalizeHex(hex, '#2563eb').slice(1);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.55 ? '#0f172a' : '#f8fafc';
}
