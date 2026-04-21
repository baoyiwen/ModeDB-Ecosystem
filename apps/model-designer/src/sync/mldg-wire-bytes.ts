import type { MldgDocument } from '../types/mldg-document.js';
import { parseMldgJson } from '../persistence/mldg-json.js';
import { encodeUtf8 } from '../persistence/mldg-binary.js';

/**
 * 将双域 JSON 稳定序列化为 UTF-8 字节流（发送前经 SDK 加密通道传输）。
 * 禁止 Node Buffer。
 */
export function serializeMldgDocumentToUint8Array(doc: MldgDocument): Uint8Array {
  const stable = {
    format: doc.format,
    version: doc.version,
    engine_schema: {
      models: doc.engine_schema.models.map((m) => ({ ...m })),
      relations: doc.engine_schema.relations.map((r) => ({ ...r })),
    },
    designer_layout: {
      models: doc.designer_layout.models.map((m) => ({ ...m })),
      ...(doc.designer_layout.viewport !== undefined
        ? { viewport: { ...doc.designer_layout.viewport } }
        : {}),
    },
  };
  const text = `${JSON.stringify(stable)}\n`;
  return encodeUtf8(text);
}

export function parseMldgDocumentFromUint8Array(bytes: Uint8Array): MldgDocument {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return parseMldgJson(text);
}
