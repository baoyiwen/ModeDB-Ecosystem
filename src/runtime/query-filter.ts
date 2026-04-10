import type { ModelRecord } from '../../common/types.js';

/** 支持的标量比较与集合操作符 */
export type ScalarOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'between';

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

export function matchesAtomic(rec: ModelRecord, p: AtomicPredicate): boolean {
  const row = rec as Record<string, unknown>;
  const actual = row[p.field];

  switch (p.operator) {
    case 'eq':
      return actual === p.value;
    case 'neq':
      return actual !== p.value;
    case 'gt': {
      const a = num(actual);
      const b = num(p.value);
      return a !== null && b !== null && a > b;
    }
    case 'gte': {
      const a = num(actual);
      const b = num(p.value);
      return a !== null && b !== null && a >= b;
    }
    case 'lt': {
      const a = num(actual);
      const b = num(p.value);
      return a !== null && b !== null && a < b;
    }
    case 'lte': {
      const a = num(actual);
      const b = num(p.value);
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
      return Array.isArray(p.value) && (p.value as unknown[]).some((v) => v === actual);
    case 'between': {
      if (!Array.isArray(p.value) || (p.value as unknown[]).length !== 2) {
        return false;
      }
      const a = num(actual);
      const lo = num((p.value as unknown[])[0]);
      const hi = num((p.value as unknown[])[1]);
      return a !== null && lo !== null && hi !== null && a >= lo && a <= hi;
    }
    default: {
      const _ex: never = p.operator;
      return _ex;
    }
  }
}

/** 组内 AND，组间 OR；空组列表视为恒真 */
export function matchesPredicateGroups(groups: PredicateGroups, rec: ModelRecord): boolean {
  if (groups.length === 0) {
    return true;
  }
  return groups.some((g) => g.every((atom) => matchesAtomic(rec, atom)));
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
