import type { PivotDocument, PivotPageInfo, PivotSource } from '../types.js';
import { normalizePivotResult } from '../normalizer.js';

type ModelPivotSource = Extract<PivotSource, { readonly kind: 'model' }>;

export interface PivotModelQueryOptions {
  readonly client: PivotModelQueryClient;
  readonly source: ModelPivotSource;
  /** Model properties allowed in the viewer; relation children can use their relation key. */
  readonly fieldPolicy?: PivotModelFieldPolicy;
  readonly page?: number;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface PivotModelFieldPolicy {
  readonly fields: readonly string[];
  readonly relatedFields?: Readonly<Record<string, readonly string[]>>;
  readonly relatedPolicies?: Readonly<Record<string, PivotModelFieldPolicy>>;
}

/** Minimal client surface used by Pivot so the source adapter stays testable. */
export interface PivotModelQueryClient {
  model(name: string): {
    query(): {
      execute(options?: {
        readonly includeRelates?: boolean;
        readonly page?: number;
        readonly cursor?: string | null;
        readonly limit?: number;
      }): Promise<unknown>;
    };
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowFromResult(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const getData = value.getData;
  if (typeof getData === 'function') {
    const data = getData.call(value);
    return isRecord(data) ? data : undefined;
  }
  return value;
}

function rowsFromResult(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(rowFromResult).filter((row): row is Readonly<Record<string, unknown>> => !!row);
}

function filterModelRow(
  row: Readonly<Record<string, unknown>>,
  policy: PivotModelFieldPolicy,
  ancestors: ReadonlySet<unknown> = new Set(),
  depth = 0,
): Readonly<Record<string, unknown>> {
  const fields = new Set(policy.fields);
  const filtered: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      filtered[field] = row[field];
    }
  }
  const relates = row.relates;
  if (isRecord(relates) && !ancestors.has(row) && depth < 64) {
    const path = new Set(ancestors);
    path.add(row);
    const filteredRelates: Record<string, unknown> = {};
    for (const [relationName, children] of Object.entries(relates)) {
      if (!Array.isArray(children)) {
        continue;
      }
      const childPolicy = policy.relatedPolicies?.[relationName];
      if (policy.relatedPolicies && !childPolicy) continue;
      const childFields = policy.relatedFields?.[relationName] ?? [];
      filteredRelates[relationName] = children
        .filter(isRecord)
        .map((child) =>
          filterModelRow(
            child,
            childPolicy ?? { fields: childFields, relatedFields: policy.relatedFields },
            path,
            depth + 1,
          ),
        );
    }
    if (Object.keys(filteredRelates).length > 0) {
      filtered.relates = filteredRelates;
    }
  }
  return filtered;
}

function pageFromResult(
  result: unknown,
  options: Pick<PivotModelQueryOptions, 'page' | 'cursor' | 'limit'>,
): { rows: readonly Readonly<Record<string, unknown>>[]; page: PivotPageInfo } {
  if (!isRecord(result) || !('items' in result)) {
    return {
      rows: rowsFromResult(result),
      page: {
        mode: 'none',
      },
    };
  }

  const rawItems = result.items;
  const mode = options.cursor !== undefined ? 'cursor' : 'offset';
  return {
    rows: rowsFromResult(rawItems),
    page: {
      mode,
      ...(typeof result.page === 'number' ? { page: result.page } : {}),
      ...(typeof result.total === 'number' ? { total: result.total } : {}),
      ...(typeof result.pageCount === 'number' ? { pageCount: result.pageCount } : {}),
      ...(typeof result.nextCursor === 'string' && result.nextCursor
        ? { nextCursor: result.nextCursor }
        : {}),
    },
  };
}

/** Execute one model query and normalize its rows for Pivot views. */
export async function queryModelPivot(options: PivotModelQueryOptions): Promise<PivotDocument> {
  const query = options.client.model(options.source.modelName).query();
  const executeOptions = {
    includeRelates: true,
    ...(options.page !== undefined ? { page: options.page } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  };
  const result = await query.execute(executeOptions);
  const normalized = pageFromResult(result, options);
  const policy = options.fieldPolicy;
  const rows = policy ? normalized.rows.map((row) => filterModelRow(row, policy)) : normalized.rows;
  return normalizePivotResult({
    source: options.source,
    rows,
    page: normalized.page,
  });
}
