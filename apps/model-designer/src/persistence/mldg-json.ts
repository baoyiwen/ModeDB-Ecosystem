import type { MldgDocument } from '../types/mldg-document.js';

/** 解析 .mldg JSON；兼容 `designer_config` 别名 */
export function parseMldgJson(text: string): MldgDocument {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const layout =
    (raw.designer_layout as MldgDocument['designer_layout'] | undefined) ??
    (raw.designer_config as MldgDocument['designer_layout'] | undefined);
  if (!raw.engine_schema || !layout) {
    throw new Error('INVALID_MLDG');
  }
  return {
    format: 'mldg',
    version: String(raw.version ?? '1.0.0'),
    engine_schema: raw.engine_schema as MldgDocument['engine_schema'],
    designer_layout: layout,
  };
}

export function stringifyMldg(doc: MldgDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
