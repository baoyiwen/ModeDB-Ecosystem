import type { ModelRecord } from '../../common/types.js';
import type { ModelRegistry } from '../../common/registry.js';
import type { DataReader, IndexReader } from '../../common/provider.js';
import {
  resolveRelationOnRegistry,
  targetModelName,
  type ResolvedRelation,
} from './relation-resolve.js';

export type RelationEmptyReason =
  | 'NOT_REGISTERED'
  | 'NO_LINK_IN_INDEX'
  /** 索引有边但 `.mld` 缺行（幽灵 id） */
  | 'FILTERED_OUT_ORPHAN'
  /** 关联行已加载，但被 where / filter 全部筛掉 */
  | 'FILTERED_OUT_WHERE';

export interface RelateDiagnostic {
  readonly reason: RelationEmptyReason;
  readonly message: string;
}

export interface HydrationContext {
  readonly registry: ModelRegistry;
  readonly indexReader: IndexReader;
  readonly dataReader: DataReader;
}

/**
 * Wrapped query row: raw `.mld` payload plus optional nested relates and empty-relation diagnostics.
 */
export class HydratedEntity {
  private readonly relates = new Map<string, HydratedEntity[]>();
  private readonly diagnostics = new Map<string, RelateDiagnostic>();

  constructor(
    private readonly record: ModelRecord,
    private readonly modelName: string,
    private readonly ctx: HydrationContext,
  ) {}

  getModelName(): string {
    return this.modelName;
  }

  getData(): ModelRecord {
    return this.record;
  }

  /** All relation → children populated for this query (see {@link QueryExecuteOptions.includeRelates}). */
  getRelates(): ReadonlyMap<string, HydratedEntity[]> {
    return this.relates;
  }

  getRelate(name: string): HydratedEntity[] {
    return this.relates.get(name) ?? [];
  }

  /**
   * When {@link getRelate} is empty, explains why (if known). For lazy resolution use {@link explainRelate}.
   */
  getRelateDiagnostic(name: string): RelateDiagnostic | undefined {
    return this.diagnostics.get(name);
  }

  /**
   * Deep empty-reason trace: resolves registry + index + `.mld` hydration, caches {@link getRelate} on success.
   */
  async explainRelate(relationName: string): Promise<RelateDiagnostic | undefined> {
    if (this.diagnostics.has(relationName)) {
      return this.diagnostics.get(relationName);
    }

    const cached = this.relates.get(relationName);
    if (cached !== undefined && cached.length > 0) {
      return undefined;
    }

    let resolved: ResolvedRelation;
    try {
      resolved = resolveRelationOnRegistry(this.ctx.registry, relationName, this.modelName);
    } catch {
      const d: RelateDiagnostic = {
        reason: 'NOT_REGISTERED',
        message: `Relation "${relationName}" is not available on model "${this.modelName}" (inheritance chain).`,
      };
      this.diagnostics.set(relationName, d);
      this.relates.set(relationName, []);
      return d;
    }

    const nextModel = targetModelName(resolved);
    const id = this.record._id;
    const linked =
      resolved.direction === 'forward'
        ? await this.ctx.indexReader.getForward(resolved.definition, id)
        : await this.ctx.indexReader.getReverse(resolved.definition, id);

    if (linked.length === 0) {
      const d: RelateDiagnostic = {
        reason: 'NO_LINK_IN_INDEX',
        message: `Relation "${relationName}" is registered but index has no edges for _id "${id}" on "${this.modelName}".`,
      };
      this.diagnostics.set(relationName, d);
      this.relates.set(relationName, []);
      return d;
    }

    const records = await this.ctx.dataReader.getByIds(nextModel, linked);
    const children = records.map((r) => new HydratedEntity(r, nextModel, this.ctx));
    this.relates.set(relationName, children);

    if (records.length < linked.length) {
      const missing = linked.filter((lid) => !records.some((r) => r._id === lid));
      const d: RelateDiagnostic = {
        reason: 'FILTERED_OUT_ORPHAN',
        message: `Index listed ${linked.length} id(s) but only ${records.length} row(s) in "${nextModel}.mld"; missing _id: ${missing.join(', ')}.`,
      };
      this.diagnostics.set(relationName, d);
      return d;
    }

    return undefined;
  }

  /**
   * Cascading plain object: serializable snapshot for logging / APIs.
   */
  toNested(): Record<string, unknown> {
    const data = this.getData() as Record<string, unknown>;
    const out: Record<string, unknown> = { ...data };
    if (this.relates.size > 0) {
      const rel: Record<string, unknown[]> = {};
      for (const [k, v] of this.relates) {
        rel[k] = v.map((c) => c.toNested());
      }
      out['relates'] = rel;
    }
    return out;
  }

  /** @internal */
  _setRelate(name: string, children: HydratedEntity[]): void {
    this.relates.set(name, children);
  }

  /** @internal */
  _setDiagnostic(name: string, d: RelateDiagnostic): void {
    this.diagnostics.set(name, d);
  }
}

export interface QueryExecuteOptions {
  /** When true, {@link QueryChain.execute} returns root entities with nested {@link HydratedEntity} per hop. */
  readonly includeRelates?: boolean;
}
