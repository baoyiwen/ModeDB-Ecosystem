/** 关系边画布元数据（序列化到 `EngineRelationEdge.canvas_meta_str`）。 */
export interface RelationCanvasMeta {
  /** 锁定后不可拖动弯曲控制点。 */
  locked?: boolean;
  /** 正向（source → target）二次贝塞尔控制点（世界坐标）。 */
  forward_bend?: { x: number; y: number };
  /** 逆向（target → source）二次贝塞尔控制点（世界坐标）。 */
  reverse_bend?: { x: number; y: number };
}

export function parseRelationCanvasMeta(raw?: string): RelationCanvasMeta {
  if (!raw?.trim()) {
    return {};
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') {
      return {};
    }
    const o = v as Record<string, unknown>;
    const out: RelationCanvasMeta = {};
    if (o.locked === true) {
      out.locked = true;
    }
    const fwd = o.forward_bend;
    if (fwd && typeof fwd === 'object' && typeof (fwd as { x?: unknown }).x === 'number') {
      out.forward_bend = { x: (fwd as { x: number }).x, y: (fwd as { y: number }).y };
    }
    const rev = o.reverse_bend;
    if (rev && typeof rev === 'object' && typeof (rev as { x?: unknown }).x === 'number') {
      out.reverse_bend = { x: (rev as { x: number }).x, y: (rev as { y: number }).y };
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeRelationCanvasMeta(meta: RelationCanvasMeta): string {
  return JSON.stringify(meta);
}
