import type { ModelRecord } from '../../common/types.js';
import type { ModelRegistry } from '../../common/registry.js';
import type { DataReader, IndexReader } from '../../common/provider.js';
import {
  HydratedEntity,
  type HydrationContext,
  type QueryExecuteOptions,
} from './HydratedEntity.js';
import {
  resolveRelationOnRegistry,
  targetModelName,
  type ResolvedRelation,
} from './relation-resolve.js';
import {
  cloneGroups,
  composeMatchers,
  emptyGroups,
  normalizeOperator,
  type AtomicPredicate,
  type RecordPredicate,
} from './query-filter.js';

export interface LocalFilterState {
  groups: AtomicPredicate[][];
  fns: RecordPredicate[];
}

function emptyLocal(): LocalFilterState {
  return { groups: emptyGroups(), fns: [] };
}

function cloneLocal(s: LocalFilterState): LocalFilterState {
  return { groups: cloneGroups(s.groups), fns: [...s.fns] };
}

/** 在 `relate(name, cb)` 回调中配置目标侧 where / filter / OR 组 */
export class RelateFilterBuilder {
  private readonly state = emptyLocal();

  where(field: string, operator: string, value: unknown): this {
    const op = normalizeOperator(operator);
    this.state.groups[this.state.groups.length - 1]!.push({ field, operator: op, value });
    return this;
  }

  and(field: string, operator: string, value: unknown): this {
    return this.where(field, operator, value);
  }

  or(): this {
    this.state.groups.push([]);
    return this;
  }

  filter(fn: RecordPredicate): this {
    this.state.fns.push(fn);
    return this;
  }

  _export(): LocalFilterState {
    return cloneLocal(this.state);
  }
}

export type QueryStartSpec =
  | { readonly kind: 'all' }
  | { readonly kind: 'ids'; readonly ids: readonly string[] };

interface HopPlan {
  readonly relationName: string;
  readonly sourceFilters: LocalFilterState;
  readonly targetFilters: LocalFilterState;
}

type OriginLoadHint =
  | { readonly kind: 'by_uuid'; readonly id: string }
  | { readonly kind: 'by_business_id'; readonly value: unknown };

/** 仅当单条件 `eq` 且字段为 `_id` 或 `id` 时做定点加载（避免非唯一字段只读到首行） */
function tryOptimizedOriginLoad(filters: LocalFilterState): OriginLoadHint | undefined {
  if (filters.fns.length > 0) {
    return undefined;
  }
  if (filters.groups.length !== 1) {
    return undefined;
  }
  const g = filters.groups[0]!;
  if (g.length !== 1) {
    return undefined;
  }
  const a = g[0]!;
  if (a.operator !== 'eq') {
    return undefined;
  }
  if (a.field === '_id') {
    return { kind: 'by_uuid', id: String(a.value) };
  }
  if (a.field === 'id') {
    return { kind: 'by_business_id', value: a.value };
  }
  return undefined;
}

/**
 * Lazy, chainable query over `.mld` / `.rid` with {@link where} / {@link filter} / {@link relate} target filters.
 */
export class QueryChain {
  private readonly hops: HopPlan[] = [];
  private leadingFilters: LocalFilterState = emptyLocal();
  private readonly originModel: string;
  private readonly start: QueryStartSpec;

  constructor(
    private readonly registry: ModelRegistry,
    private readonly indexReader: IndexReader,
    private readonly dataReader: DataReader,
    startModel: string,
    start: QueryStartSpec,
  ) {
    this.originModel = startModel;
    this.start = start;
  }

  where(field: string, operator: string, value: unknown): this {
    const op = normalizeOperator(operator);
    this.leadingFilters.groups[this.leadingFilters.groups.length - 1]!.push({
      field,
      operator: op,
      value,
    });
    return this;
  }

  and(field: string, operator: string, value: unknown): this {
    return this.where(field, operator, value);
  }

  or(): this {
    this.leadingFilters.groups.push([]);
    return this;
  }

  filter(fn: RecordPredicate): this {
    this.leadingFilters.fns.push(fn);
    return this;
  }

  relate(relationName: string, targetSetup?: (b: RelateFilterBuilder) => void): this {
    let targetFilters = emptyLocal();
    if (targetSetup) {
      const b = new RelateFilterBuilder();
      targetSetup(b);
      targetFilters = b._export();
    }
    this.hops.push({
      relationName,
      sourceFilters: cloneLocal(this.leadingFilters),
      targetFilters,
    });
    this.leadingFilters = emptyLocal();
    return this;
  }

  async execute(options?: QueryExecuteOptions): Promise<HydratedEntity[]> {
    if (options?.includeRelates) {
      return this.executeWithRelates();
    }
    return this.executeFlat();
  }

  private ctx(): HydrationContext {
    return {
      registry: this.registry,
      indexReader: this.indexReader,
      dataReader: this.dataReader,
    };
  }

  /** 起点模型：ids 或全表；若首 hop 的 source 为单字段 eq，可走流式首行匹配 */
  private async loadOriginRecords(firstHopSource: LocalFilterState): Promise<ModelRecord[]> {
    if (this.start.kind === 'ids') {
      if (this.start.ids.length === 0) {
        return [];
      }
      return this.dataReader.getByIds(this.originModel, [...this.start.ids]);
    }

    const hint = tryOptimizedOriginLoad(firstHopSource);
    if (hint?.kind === 'by_uuid') {
      const rows = await this.dataReader.getByIds(this.originModel, [hint.id]);
      const m = composeMatchers(firstHopSource.groups, firstHopSource.fns);
      return rows.filter(m);
    }
    if (hint?.kind === 'by_business_id' && this.dataReader.findFirstByFieldEq) {
      const hit = await this.dataReader.findFirstByFieldEq(this.originModel, 'id', hint.value);
      if (!hit) {
        return [];
      }
      const m = composeMatchers(firstHopSource.groups, firstHopSource.fns);
      return m(hit) ? [hit] : [];
    }

    return this.dataReader.getAll(this.originModel);
  }

  private async loadOriginRecordsNoHop(): Promise<ModelRecord[]> {
    if (this.start.kind === 'ids') {
      if (this.start.ids.length === 0) {
        return [];
      }
      return this.dataReader.getByIds(this.originModel, [...this.start.ids]);
    }

    const hint = tryOptimizedOriginLoad(this.leadingFilters);
    if (hint?.kind === 'by_uuid') {
      const rows = await this.dataReader.getByIds(this.originModel, [hint.id]);
      const m = composeMatchers(this.leadingFilters.groups, this.leadingFilters.fns);
      return rows.filter(m);
    }
    if (hint?.kind === 'by_business_id' && this.dataReader.findFirstByFieldEq) {
      const hit = await this.dataReader.findFirstByFieldEq(this.originModel, 'id', hint.value);
      if (!hit) {
        return [];
      }
      const m = composeMatchers(this.leadingFilters.groups, this.leadingFilters.fns);
      return m(hit) ? [hit] : [];
    }

    return this.dataReader.getAll(this.originModel);
  }

  private async executeFlat(): Promise<HydratedEntity[]> {
    const c = this.ctx();

    if (this.hops.length === 0) {
      let records = await this.loadOriginRecordsNoHop();
      records = records.filter(
        composeMatchers(this.leadingFilters.groups, this.leadingFilters.fns),
      );
      return records.map((r) => new HydratedEntity(r, this.originModel, c));
    }

    let model = this.originModel;
    let records = await this.loadOriginRecords(this.hops[0]!.sourceFilters);
    records = records.filter(
      composeMatchers(this.hops[0]!.sourceFilters.groups, this.hops[0]!.sourceFilters.fns),
    );
    if (records.length === 0) {
      return [];
    }

    for (let i = 0; i < this.hops.length; i++) {
      const hop = this.hops[i]!;
      if (i > 0) {
        records = records.filter(composeMatchers(hop.sourceFilters.groups, hop.sourceFilters.fns));
        if (records.length === 0) {
          return [];
        }
      }

      const resolved = resolveRelationOnRegistry(this.registry, hop.relationName, model);
      const nextModel = targetModelName(resolved);
      const nextIds = await this.collectNextIds(resolved, records);
      if (nextIds.length === 0) {
        return [];
      }

      records = await this.dataReader.getByIds(nextModel, nextIds);
      records = records.filter(composeMatchers(hop.targetFilters.groups, hop.targetFilters.fns));
      if (records.length === 0) {
        return [];
      }
      model = nextModel;
    }

    records = records.filter(composeMatchers(this.leadingFilters.groups, this.leadingFilters.fns));
    return records.map((r) => new HydratedEntity(r, model, c));
  }

  private async executeWithRelates(): Promise<HydratedEntity[]> {
    const c = this.ctx();

    if (this.hops.length === 0) {
      let records = await this.loadOriginRecordsNoHop();
      records = records.filter(
        composeMatchers(this.leadingFilters.groups, this.leadingFilters.fns),
      );
      return records.map((r) => new HydratedEntity(r, this.originModel, c));
    }

    const model = this.originModel;
    let records = await this.loadOriginRecords(this.hops[0]!.sourceFilters);
    records = records.filter(
      composeMatchers(this.hops[0]!.sourceFilters.groups, this.hops[0]!.sourceFilters.fns),
    );
    if (records.length === 0) {
      return [];
    }

    const roots = records.map((r) => new HydratedEntity(r, model, c));
    let frontier: HydratedEntity[] = roots;
    let frontierModel = model;

    for (let hi = 0; hi < this.hops.length; hi++) {
      const hop = this.hops[hi]!;
      const resolved = resolveRelationOnRegistry(this.registry, hop.relationName, frontierModel);
      const nextModel = targetModelName(resolved);
      const targetMatcher = composeMatchers(hop.targetFilters.groups, hop.targetFilters.fns);
      const nextFrontier: HydratedEntity[] = [];

      for (const entity of frontier) {
        const srcRec = entity.getData();

        if (hi > 0) {
          const okSource = composeMatchers(hop.sourceFilters.groups, hop.sourceFilters.fns)(srcRec);
          if (!okSource) {
            entity._setRelate(hop.relationName, []);
            entity._setDiagnostic(hop.relationName, {
              reason: 'FILTERED_OUT_WHERE',
              message: `Source on "${frontierModel}" did not match filters before "${hop.relationName}".`,
            });
            continue;
          }
        }

        const id = srcRec._id;
        const linked = await this.linkedIds(resolved, id);

        if (linked.length === 0) {
          entity._setRelate(hop.relationName, []);
          entity._setDiagnostic(hop.relationName, {
            reason: 'NO_LINK_IN_INDEX',
            message: `No edges in .rid for "${frontierModel}" _id "${id}" via "${hop.relationName}".`,
          });
          continue;
        }

        const childRecords = await this.dataReader.getByIds(nextModel, linked);
        const orphan = childRecords.length < linked.length;

        if (orphan) {
          const missing = linked.filter((lid) => !childRecords.some((rec) => rec._id === lid));
          entity._setDiagnostic(hop.relationName, {
            reason: 'FILTERED_OUT_ORPHAN',
            message: `Index listed ${linked.length} id(s) for "${hop.relationName}" but only ${childRecords.length} row(s) in "${nextModel}.mld"; missing _id: ${missing.join(', ')}.`,
          });
        }

        const passed = childRecords.filter(targetMatcher);
        if (passed.length === 0) {
          if (!orphan) {
            entity._setDiagnostic(hop.relationName, {
              reason: 'FILTERED_OUT_WHERE',
              message: `All linked "${nextModel}" rows were removed by target filters on "${hop.relationName}".`,
            });
          }
          entity._setRelate(hop.relationName, []);
          continue;
        }

        const children = passed.map((r) => new HydratedEntity(r, nextModel, c));
        entity._setRelate(hop.relationName, children);
        nextFrontier.push(...children);
      }

      frontier = nextFrontier;
      frontierModel = nextModel;
    }

    return roots;
  }

  private async linkedIds(resolved: ResolvedRelation, id: string): Promise<string[]> {
    return resolved.direction === 'forward'
      ? this.indexReader.getForward(resolved.definition, id)
      : this.indexReader.getReverse(resolved.definition, id);
  }

  private async collectNextIds(
    resolved: ResolvedRelation,
    records: ModelRecord[],
  ): Promise<string[]> {
    const nextSet = new Set<string>();
    for (const rec of records) {
      const linked = await this.linkedIds(resolved, rec._id);
      for (const linkedId of linked) {
        nextSet.add(linkedId);
      }
    }
    return [...nextSet];
  }
}

export type { QueryExecuteOptions } from './HydratedEntity.js';
