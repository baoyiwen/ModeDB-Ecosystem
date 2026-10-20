import type { ModelRecord, FieldTypeDef } from '@mode-db/common';

/** 支持的标量比较与集合操作符 */
export type ScalarOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'between';

/** Optional context for I18N-aware field resolution during query matching. */
export interface FieldMatchContext {
  readonly fieldTypes?: ReadonlyMap<string, FieldTypeDef>;
  readonly locale?: string;
}

/** 单字段条件（参与 AND/OR 组） */
export interface AtomicPredicate {
  readonly field: string;
  readonly operator: ScalarOperator;
  readonly value: unknown;
}

/** 逻辑组合：每组内部 AND，组与组之间 OR */
export type PredicateGroups = readonly (readonly AtomicPredicate[])[];

const OP_ALIASES: Record<string, ScalarOperator> = {
  '=': 'eq',
  '==': 'eq',
  '!=': 'neq',
  '<>': 'neq',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};

export function normalizeOperator(op: string): ScalarOperator {
  const k = op.trim().toLowerCase();
  if (k in OP_ALIASES) {
    return OP_ALIASES[k]!;
  }
  if (
    k === 'eq' ||
    k === 'neq' ||
    k === 'gt' ||
    k === 'gte' ||
    k === 'lt' ||
    k === 'lte' ||
    k === 'like' ||
    k === 'in' ||
    k === 'between'
  ) {
    return k;
  }
  throw new Error(`Unsupported query operator: "${op}"`);
}

function num(x: unknown): number | null {
  if (typeof x === 'number' && !Number.isNaN(x)) {
    return x;
  }
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function bool(x: unknown): boolean | null {
  if (typeof x === 'boolean') {
    return x;
  }
  if (typeof x === 'string') {
    const s = x.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') {
      return true;
    }
    if (s === 'false' || s === '0' || s === 'no') {
      return false;
    }
  }
  if (typeof x === 'number') {
    if (x === 1) {
      return true;
    }
    if (x === 0) {
      return false;
    }
  }
  return null;
}

function scalarEquals(actual: unknown, expected: unknown, fieldType?: FieldTypeDef): boolean {
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return (
      (actual === null || actual === undefined) && (expected === null || expected === undefined)
    );
  }
  if (!fieldType) {
    return actual === expected;
  }

  switch (fieldType.type) {
    case 'Number':
    case 'Int': {
      const a = num(actual);
      const b = num(expected);
      return a !== null && b !== null && a === b;
    }
    case 'Boolean': {
      const a = bool(actual);
      const b = bool(expected);
      return a !== null && b !== null && a === b;
    }
    case 'String':
    case 'I18N':
    case 'Color':
      return String(actual ?? '') === String(expected ?? '');
    case 'DateTime': {
      const a = typeof actual === 'string' ? Date.parse(actual) : NaN;
      const b = typeof expected === 'string' ? Date.parse(expected) : NaN;
      return Number.isFinite(a) && Number.isFinite(b) && a === b;
    }
    case 'JSON':
    case 'Unit':
      return actual === expected;
    default: {
      const _ex: never = fieldType.type;
      return _ex;
    }
  }
}

export function matchesAtomic(
  rec: ModelRecord,
  p: AtomicPredicate,
  ctx?: FieldMatchContext,
): boolean {
  const row = rec as Record<string, unknown>;
  let actual = row[p.field];
  let fieldType = ctx?.fieldTypes?.get(p.field);
  const localePath = /^(.+)\.([a-z]{2}(?:-[A-Za-z]{2,4})?)$/.exec(p.field);
  if (!fieldType && localePath && ctx?.fieldTypes?.get(localePath[1]!)?.type === 'I18N') {
    const map = row[localePath[1]!];
    actual =
      map !== null && typeof map === 'object' && Object.hasOwn(map, localePath[2]!)
        ? (map as Record<string, unknown>)[localePath[2]!]
        : undefined;
    fieldType = { type: 'String' };
  }
  const comparable = (value: unknown): number | null => {
    if (fieldType?.type !== 'DateTime') {
      return num(value);
    }
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  };

  if (
    ctx?.locale &&
    fieldType?.type === 'I18N' &&
    actual !== null &&
    actual !== undefined &&
    typeof actual === 'object' &&
    !Array.isArray(actual)
  ) {
    actual = (actual as Record<string, unknown>)[ctx.locale];
  }

  switch (p.operator) {
    case 'eq':
      return scalarEquals(actual, p.value, fieldType);
    case 'neq':
      return !scalarEquals(actual, p.value, fieldType);
    case 'gt': {
      const a = comparable(actual);
      const b = comparable(p.value);
      return a !== null && b !== null && a > b;
    }
    case 'gte': {
      const a = comparable(actual);
      const b = comparable(p.value);
      return a !== null && b !== null && a >= b;
    }
    case 'lt': {
      const a = comparable(actual);
      const b = comparable(p.value);
      return a !== null && b !== null && a < b;
    }
    case 'lte': {
      const a = comparable(actual);
      const b = comparable(p.value);
      return a !== null && b !== null && a <= b;
    }
    case 'like': {
      const s = String(actual ?? '');
      const raw = String(p.value ?? '');
      if (raw.includes('%')) {
        const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
        return new RegExp(`^${esc}$`, 'i').test(s);
      }
      return s.includes(raw);
    }
    case 'in':
      return (
        Array.isArray(p.value) &&
        (p.value as unknown[]).some((v) => scalarEquals(actual, v, fieldType))
      );
    case 'between': {
      if (!Array.isArray(p.value) || (p.value as unknown[]).length !== 2) {
        return false;
      }
      const a = comparable(actual);
      const lo = comparable((p.value as unknown[])[0]);
      const hi = comparable((p.value as unknown[])[1]);
      return a !== null && lo !== null && hi !== null && a >= lo && a <= hi;
    }
    default: {
      const _ex: never = p.operator;
      return _ex;
    }
  }
}

/** 组内 AND，组间 OR；空组列表视为恒真 */
export function matchesPredicateGroups(
  groups: PredicateGroups,
  rec: ModelRecord,
  ctx?: FieldMatchContext,
): boolean {
  if (groups.length === 0) {
    return true;
  }
  return groups.some((g) => g.every((atom) => matchesAtomic(rec, atom, ctx)));
}

export type RecordPredicate = (rec: ModelRecord) => boolean;

export function composeMatchers(
  groups: PredicateGroups,
  customFns: readonly RecordPredicate[],
): RecordPredicate {
  return (rec) => matchesPredicateGroups(groups, rec) && customFns.every((fn) => fn(rec));
}

export function emptyGroups(): AtomicPredicate[][] {
  return [[]];
}

export function cloneGroups(g: AtomicPredicate[][]): AtomicPredicate[][] {
  return g.map((gr) => [...gr]);
}

/** 可执行过滤状态：组内 AND，组间 OR；另附自定义谓词（与所有组 AND） */
export interface LocalFilterState {
  groups: AtomicPredicate[][];
  fns: RecordPredicate[];
}

export function emptyLocal(): LocalFilterState {
  return { groups: emptyGroups(), fns: [] };
}

export function cloneLocal(s: LocalFilterState): LocalFilterState {
  return { groups: cloneGroups(s.groups), fns: [...s.fns] };
}
