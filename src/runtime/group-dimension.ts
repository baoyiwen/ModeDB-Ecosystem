import type { ModelRegistry } from '@mode-db/common';
import { RelationNotFoundError } from '@mode-db/common';
import { resolveRelationOnRegistry } from './relation-resolve.js';

export type ParsedGroupDimension =
  | { readonly kind: 'direct'; readonly field: string }
  | { readonly kind: 'relation'; readonly relation: string; readonly pathOnTarget: string[] };

/**
 * 解析 `groupBy` / 透视维度路径：`year` 为本地字段；`in_zone.label` 为关系 + 目标字段路径。
 */
export function parseGroupDimension(
  field: string,
  registry: ModelRegistry,
  modelName: string,
): ParsedGroupDimension {
  const parts = field.split('.');
  if (parts.length === 1) {
    return { kind: 'direct', field: parts[0]! };
  }
  const head = parts[0]!;
  try {
    resolveRelationOnRegistry(registry, head, modelName);
  } catch (e) {
    if (e instanceof RelationNotFoundError) {
      return { kind: 'direct', field };
    }
    throw e;
  }
  const rest = parts.slice(1);
  if (rest.length === 0) {
    throw new Error(`groupBy path "${field}" must include a field after relation "${head}"`);
  }
  return { kind: 'relation', relation: head, pathOnTarget: rest };
}

export function readFieldPathSync(obj: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** 嵌套树对象键：与 {@link DataPivot} / bucket 键一致。 */
export function pivotSegmentKey(v: unknown): string {
  if (v === null || v === undefined) {
    return String(v);
  }
  if (typeof v === 'object') {
    return JSON.stringify(v);
  }
  return String(v);
}
