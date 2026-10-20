import type {
  PivotDocument,
  PivotNode,
  PivotPathSegment,
  PivotResultInput,
  PivotRow,
} from './types.js';

function pathToken(path: readonly PivotPathSegment[]): string {
  return JSON.stringify(path);
}

function nodeId(rowIndex: number, path: readonly PivotPathSegment[]): string {
  return `row:${rowIndex}:${pathToken(path)}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldSegment(key: string): PivotPathSegment {
  return { key, kind: 'field' };
}

function indexSegment(index: number): PivotPathSegment {
  return { key: String(index), kind: 'index', index };
}

function normalizeValue(
  rowIndex: number,
  key: string,
  value: unknown,
  path: readonly PivotPathSegment[],
): PivotNode {
  if (Array.isArray(value)) {
    return {
      id: nodeId(rowIndex, path),
      key,
      kind: 'array',
      path,
      value,
      children: value.map((item, index) => {
        const childPath = [...path, indexSegment(index)];
        return normalizeValue(rowIndex, String(index), item, childPath);
      }),
    };
  }

  if (isRecord(value)) {
    return {
      id: nodeId(rowIndex, path),
      key,
      kind: 'object',
      path,
      value,
      children: Object.entries(value).map(([childKey, childValue]) => {
        const childPath = [...path, fieldSegment(childKey)];
        return normalizeValue(rowIndex, childKey, childValue, childPath);
      }),
    };
  }

  return {
    id: nodeId(rowIndex, path),
    key,
    kind: 'value',
    path,
    value,
    children: [],
  };
}

function normalizeRow(index: number, raw: Readonly<Record<string, unknown>>): PivotRow {
  const rootPath: readonly PivotPathSegment[] = [];
  const root: PivotNode = {
    id: nodeId(index, rootPath),
    key: `row-${index + 1}`,
    kind: 'record',
    path: rootPath,
    value: raw,
    children: Object.entries(raw).map(([key, value]) => {
      const path = [fieldSegment(key)];
      return normalizeValue(index, key, value, path);
    }),
  };

  return {
    index,
    id: `row:${index}`,
    raw,
    root,
  };
}

function normalizePage(page: Partial<PivotResultInput['page']> | undefined) {
  return {
    mode: page?.mode ?? 'none',
    ...(page?.page !== undefined ? { page: page.page } : {}),
    ...(page?.total !== undefined ? { total: page.total } : {}),
    ...(page?.pageCount !== undefined ? { pageCount: page.pageCount } : {}),
    ...(page?.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page?.limit !== undefined ? { limit: page.limit } : {}),
  } as PivotDocument['page'];
}

/** Normalize raw model or interface rows without changing their payload. */
export function normalizePivotResult(input: PivotResultInput): PivotDocument {
  const rows = input.rows.map((raw, index) => normalizeRow(index, raw));
  return {
    source: input.source,
    rows,
    rawRows: input.rows,
    page: normalizePage(input.page),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/** Return all leaf values in traversal order for a future table renderer. */
export function collectPivotLeafNodes(row: PivotRow): readonly PivotNode[] {
  const leaves: PivotNode[] = [];
  const visit = (node: PivotNode): void => {
    if (node.children.length === 0) {
      leaves.push(node);
      return;
    }
    node.children.forEach(visit);
  };
  row.root.children.forEach(visit);
  return leaves;
}
