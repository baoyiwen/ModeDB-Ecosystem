import { HydratedEntity } from '../runtime/HydratedEntity.js';
import { isAnalysisResult } from '../runtime/transform-engine.js';
import { isPaginatedExecuteResult } from '../runtime/query.js';
import { GroupInstance } from '../runtime/group-instance.js';

/** JSON-safe execute result for wire transport. */
export type WireExecuteResultJson =
  | {
      readonly kind: 'rows';
      readonly rows: readonly { readonly model: string; readonly data: Record<string, unknown> }[];
    }
  | {
      readonly kind: 'analysis';
      readonly dimensionKeys: readonly string[];
      readonly shape: 'flat';
      readonly rows: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: 'paginated';
      readonly page: number;
      readonly total: number;
      readonly limit: number;
      readonly pageCount: number;
      readonly items: WireExecuteResultJson;
    };

function serializeRows(rows: HydratedEntity[]): WireExecuteResultJson {
  return {
    kind: 'rows',
    rows: rows.map((h) => ({
      model: h.getModelName(),
      data: h.getData(true) as Record<string, unknown>,
    })),
  };
}

export function serializeExecuteResultForWire(result: unknown): WireExecuteResultJson {
  if (isPaginatedExecuteResult(result)) {
    return {
      kind: 'paginated',
      page: result.page,
      total: result.total,
      limit: result.limit,
      pageCount: result.pageCount,
      items: serializeExecuteResultForWire(result.items),
    };
  }
  if (Array.isArray(result)) {
    if (result.length === 0) {
      return { kind: 'rows', rows: [] };
    }
    if (result[0] instanceof HydratedEntity) {
      return serializeRows(result as HydratedEntity[]);
    }
    if (result[0] instanceof GroupInstance) {
      throw new Error('Wire serialize: GroupInstance[] is not supported in this version.');
    }
  }
  if (isAnalysisResult(result)) {
    return {
      kind: 'analysis',
      dimensionKeys: result.dimensionKeys,
      shape: 'flat',
      rows: [...result.asFlatTable()] as Record<string, unknown>[],
    };
  }
  throw new Error(`Wire serialize: unsupported execute result type ${typeof result}`);
}
