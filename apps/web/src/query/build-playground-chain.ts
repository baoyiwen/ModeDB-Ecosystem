import type { RemoteModelDBClient, RemoteQueryChain } from '@mode-db/sdk';
import type { QueryFilterAtom, QueryFormConfig } from './query-form-types.js';

/** Parsed from JSON; validated at runtime when the engine executes the query. */
type ComputeSpec = Record<string, unknown>;

function parseIds(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseFilters(json: string): QueryFilterAtom[] {
  const trimmed = json.trim();
  if (!trimmed || trimmed === '[]') {
    return [];
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Filters must be a JSON array of { field, op, value } objects.');
  }
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Filter[${index}] must be an object.`);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.field !== 'string' || rec.field.trim() === '') {
      throw new Error(`Filter[${index}] requires a non-empty "field".`);
    }
    if (typeof rec.op !== 'string' || rec.op.trim() === '') {
      throw new Error(`Filter[${index}] requires "op" (eq, neq, gt, like, in, …).`);
    }
    if (!('value' in rec)) {
      throw new Error(`Filter[${index}] requires "value".`);
    }
    return { field: rec.field.trim(), op: rec.op.trim(), value: rec.value };
  });
}

function parseGroupBy(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseCompute(json: string): ComputeSpec | null {
  const trimmed = json.trim();
  if (!trimmed || trimmed === '{}') {
    return null;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Compute must be a JSON object, e.g. { "amount": "sum", "id": "count" }.');
  }
  return parsed as ComputeSpec;
}

function parseOptionalInt(raw: string): number | undefined {
  const t = raw.trim();
  if (!t) {
    return undefined;
  }
  const n = Number(t);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number: "${raw}"`);
  }
  return Math.floor(n);
}

/**
 * 根据演练场表单配置构建远程查询链（wire-safe：仅 where / relate / group / children 等）。
 */
export function buildPlaygroundQueryChain(
  wire: RemoteModelDBClient,
  modelName: string,
  config: QueryFormConfig,
): RemoteQueryChain {
  const ids = parseIds(config.startIds);
  let chain: RemoteQueryChain =
    ids.length > 0 ? wire.model(modelName).query(ids) : wire.model(modelName).query();

  for (const filter of parseFilters(config.filtersJson)) {
    chain = chain.where(filter.field, filter.op, filter.value);
  }

  const rel = config.relationForward.trim();
  if (rel) {
    switch (config.hopKind) {
      case 'relate':
        chain = chain.relate(rel) as RemoteQueryChain;
        break;
      case 'group':
        chain = chain.group(rel) as RemoteQueryChain;
        break;
      case 'children':
        chain = chain.children(rel, { depth: config.maxDepth }) as RemoteQueryChain;
        break;
      case 'recursive':
        chain = chain.relateRecursive(rel, { maxDepth: config.maxDepth }) as RemoteQueryChain;
        break;
      default:
        break;
    }
  }

  if (config.resultMode === 'analysis') {
    const dimensions = parseGroupBy(config.groupBy);
    if (dimensions.length > 0) {
      chain = chain.groupBy(dimensions) as RemoteQueryChain;
    }
    const compute = parseCompute(config.computeJson);
    if (compute && Object.keys(compute).length > 0) {
      chain = chain.compute(compute as unknown as Parameters<RemoteQueryChain['compute']>[0]);
    }
  }

  const limit = parseOptionalInt(config.limit);
  if (limit !== undefined && limit > 0) {
    chain = chain.limit(limit);
  }
  const page = parseOptionalInt(config.page);
  if (page !== undefined && page >= 0) {
    chain = chain.page(page);
  }

  return chain;
}

export function buildQueryExecuteOptions(config: QueryFormConfig): {
  includeRelates?: boolean;
  limit?: number;
  page?: number;
} {
  const opts: { includeRelates?: boolean; limit?: number; page?: number } = {};
  if (config.includeRelates) {
    opts.includeRelates = true;
  }
  const limit = parseOptionalInt(config.limit);
  if (limit !== undefined && limit > 0) {
    opts.limit = limit;
  }
  const page = parseOptionalInt(config.page);
  if (page !== undefined && page >= 0) {
    opts.page = page;
  }
  return opts;
}
