import type {
  ModelRecord,
  FieldTypeDef,
  ModelRegistry,
  DataReader,
  IndexReader,
} from '@mode-db/common';
import {
  resolveRelationOnRegistry,
  targetModelName,
  type ResolvedRelation,
} from './relation-resolve.js';
import {
  type ValueObject,
  createValueObject,
  type ValueSyncFn,
  InternalVault,
} from '@mode-db/common';

export type RelationEmptyReason =
  | 'NOT_REGISTERED'
  | 'NO_LINK_IN_INDEX'
  | 'FILTERED_OUT_ORPHAN'
  | 'FILTERED_OUT_WHERE';

/**
 * 关系边在用户 API 上的**粗粒度溯源**（与 {@link getRelateDiagnostic} 细因配合）。
 * - **SUCCESS**：至少有一条子实体
 * - **NO_LINK**：索引中无连线（`.rid` 无边）
 * - **FILTERED_OUT**：谓词筛空、源实体未过跳前过滤、或索引/数据不一致（幽灵 id）
 * - **NOT_REG**：关系未注册
 */
export type RelationTraceStatus = 'SUCCESS' | 'NO_LINK' | 'FILTERED_OUT' | 'NOT_REG';

export interface RelateDiagnostic {
  readonly reason: RelationEmptyReason;
  readonly message: string;
  readonly failedPredicate?: Record<string, unknown>;
}

/** When set, {@link HydratedEntity.getValue} resolves pointers; {@link HydratedEntity.getData} still returns decoded plaintext. */
export interface MemoryShadowOptions {
  readonly vault: InternalVault;
}

export interface HydrationContext {
  readonly registry: ModelRegistry;
  readonly indexReader: IndexReader;
  readonly dataReader: DataReader;
  /** Optional sync callback for write-through from ValueObject.update(). */
  readonly valueSyncFn?: ValueSyncFn;
  /** Optional in-memory field pointerization (see {@link MemoryShadowOptions}). */
  readonly memoryShadow?: MemoryShadowOptions;
}

const VAULT_META_FIELDS = new Set(['_id', '_createdAt', '__deleted']);

function pointerizeRecord<T extends ModelRecord>(row: T, vault: InternalVault): T {
  const out = { ...row } as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    if (VAULT_META_FIELDS.has(key)) {
      continue;
    }
    const v = out[key];
    if (v === undefined) {
      continue;
    }
    out[key] = vault.put(v);
  }
  return out as T;
}

function reasonToTraceStatus(reason: RelationEmptyReason): RelationTraceStatus {
  switch (reason) {
    case 'NOT_REGISTERED':
      return 'NOT_REG';
    case 'NO_LINK_IN_INDEX':
      return 'NO_LINK';
    case 'FILTERED_OUT_ORPHAN':
    case 'FILTERED_OUT_WHERE':
      return 'FILTERED_OUT';
    default: {
      const _e: never = reason;
      return _e;
    }
  }
}

/** 可 JSON 序列化的实体树快照（Web / 3D 管线缓存友好） */
export interface HydratedEntitySnapshot {
  readonly model: string;
  readonly data: Record<string, unknown>;
  readonly relates?: Record<string, HydratedEntitySnapshot[]>;
  readonly relationStatus?: Record<string, RelationTraceStatus>;
}

/**
 * 查询结果封装：原始行 + 嵌套关联 + 关系溯源状态 + 可选诊断详情。
 *
 * 分组模式下 **`wrapGroups`** 时，链式末端返回 {@link GroupInstance}[]；其与实体行一致提供 **`getData()`**，便于列表/卡片组件统一渲染。
 */
export class HydratedEntity<T extends ModelRecord = ModelRecord> {
  private readonly relates = new Map<string, HydratedEntity[]>();
  private readonly diagnostics = new Map<string, RelateDiagnostic>();
  private readonly relationStatus = new Map<string, RelationTraceStatus>();
  private _valueCache: Map<string, ValueObject> | undefined;
  /**
   * Shallow row for {@link getValue} / internal use: with memory shadow, user fields may be
   * `m_addr_*` pointers; {@link getData} always returns {@link materializeRow}-style plaintext.
   */
  private readonly displayRow: T;

  constructor(
    row: T,
    private readonly modelName: string,
    private readonly ctx: HydrationContext,
  ) {
    const vault = ctx.memoryShadow?.vault;
    this.displayRow = vault ? pointerizeRecord({ ...row } as T, vault) : ({ ...row } as T);
  }

  getModelName(): string {
    return this.modelName;
  }

  /**
   * Return the raw record data as a plain JSON object (decoded field values, never vault pointers).
   *
   * When `deep` is `true` (default), nested {@link HydratedEntity} children
   * from `.relates` are recursively flattened into the output under a
   * `relates` key — mirroring {@link toNested} but always returning the
   * raw record (no ValueObject wrappers).
   */
  getData(deep?: boolean): T {
    return this._getDataGuarded(deep === true, new Set());
  }

  /** {@link getData} 的内部实现：`path` 记录当前 DFS 祖先链，防止共享/环状引用导致无限递归（多对多兄弟重复仍保留）。 */
  private _getDataGuarded(deep: boolean, path: Set<HydratedEntity>): T {
    const materialized = this.materializeRow();
    if (!deep) {
      return materialized;
    }
    const base = { ...materialized } as Record<string, unknown>;
    if (this.relates.size > 0 && !path.has(this)) {
      path.add(this);
      const rel: Record<string, Record<string, unknown>[]> = {};
      for (const [k, v] of this.relates) {
        rel[k] = v.map((c) => c._getDataGuarded(true, path) as Record<string, unknown>);
      }
      base['relates'] = rel;
      path.delete(this);
    }
    return base as T;
  }

  /**
   * Returns the row with real field values (resolves {@link InternalVault} pointers).
   * Predicates, pivots, and relate walking use this internally; {@link getData} delegates here for the row payload.
   */
  materializeRow(): T {
    const vault = this.ctx.memoryShadow?.vault;
    if (!vault) {
      return { ...this.displayRow } as T;
    }
    const out = { ...this.displayRow } as Record<string, unknown>;
    for (const key of Object.keys(out)) {
      const cell = out[key];
      if (InternalVault.isVaultPointer(cell)) {
        out[key] = vault.resolve(cell);
      }
    }
    return out as T;
  }

  /**
   * Return a typed {@link ValueObject} wrapper for the given field.
   *
   * The wrapper provides type-specific helpers (e.g. `I18NValue.get(lang)`,
   * `ColorValue.toHex()`, `UnitValue.convertTo(unit)`) and a `.update()`
   * method that writes through to the model buffer when a sync callback
   * is available.
   *
   * For fields without a registered DataType, a `JsonValue` wrapper is returned.
   */
  getValue(fieldName: string): ValueObject | undefined {
    const cell = (this.displayRow as Record<string, unknown>)[fieldName];
    if (cell === undefined) {
      return undefined;
    }
    let raw: unknown = cell;
    if (InternalVault.isVaultPointer(cell) && this.ctx.memoryShadow?.vault) {
      raw = this.ctx.memoryShadow.vault.resolve(cell);
    }

    if (!this._valueCache) {
      this._valueCache = new Map();
    }
    const cached = this._valueCache.get(fieldName);
    if (cached) {
      return cached;
    }

    const modelDef = this.ctx.registry.getModel(this.modelName);
    const typeDef: FieldTypeDef = modelDef?.fieldTypes.get(fieldName) ?? { type: 'JSON' };
    const vo = createValueObject(fieldName, raw, typeDef, this.ctx.valueSyncFn);
    vo._diagCtx = { model: this.modelName, recordId: this.displayRow._id, field: fieldName };
    this._valueCache.set(fieldName, vo);
    return vo;
  }

  getRelates(): ReadonlyMap<string, HydratedEntity[]> {
    return this.relates;
  }

  getRelate(name: string): HydratedEntity[] {
    return this.relates.get(name) ?? [];
  }

  /**
   * 关系边的粗粒度状态；与 {@link getRelateDiagnostic} 的细因一一对应维护。
   */
  getRelationStatus(name: string): RelationTraceStatus | undefined {
    return this.relationStatus.get(name);
  }

  getRelationStatuses(): ReadonlyMap<string, RelationTraceStatus> {
    return this.relationStatus;
  }

  getRelateDiagnostic(name: string): RelateDiagnostic | undefined {
    return this.diagnostics.get(name);
  }

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
      this._setDiagnostic(relationName, d);
      this._setRelate(relationName, []);
      return d;
    }

    const nextModel = targetModelName(resolved);
    const id = this.displayRow._id;
    const linked =
      resolved.direction === 'forward'
        ? await this.ctx.indexReader.getForward(resolved.definition, id)
        : await this.ctx.indexReader.getReverse(resolved.definition, id);

    if (linked.length === 0) {
      const d: RelateDiagnostic = {
        reason: 'NO_LINK_IN_INDEX',
        message: `Relation "${relationName}" is registered but index has no edges for _id "${id}" on "${this.modelName}".`,
      };
      this._setDiagnostic(relationName, d);
      this._setRelate(relationName, []);
      return d;
    }

    const records = await this.ctx.dataReader.getByIds(nextModel, linked);
    const children = records.map((r) => new HydratedEntity(r, nextModel, this.ctx));
    this._setRelate(relationName, children);

    if (records.length < linked.length) {
      const missing = linked.filter((lid) => !records.some((r) => r._id === lid));
      const d: RelateDiagnostic = {
        reason: 'FILTERED_OUT_ORPHAN',
        message: `Index listed ${linked.length} id(s) but only ${records.length} row(s) in "${nextModel}.mld"; missing _id: ${missing.join(', ')}.`,
      };
      this._setDiagnostic(relationName, d);
      return d;
    }

    return undefined;
  }

  toNested(): Record<string, unknown> {
    return this._toNestedGuarded(new Set());
  }

  private _toNestedGuarded(path: Set<HydratedEntity>): Record<string, unknown> {
    const data = this.getData() as Record<string, unknown>;
    const out: Record<string, unknown> = { ...data };
    if (this.relates.size > 0 && !path.has(this)) {
      path.add(this);
      const rel: Record<string, unknown[]> = {};
      for (const [k, v] of this.relates) {
        rel[k] = v.map((c) => c._toNestedGuarded(path));
      }
      out['relates'] = rel;
      path.delete(this);
    }
    return out;
  }

  /**
   * 轻量拓扑快照：纯 JSON、无函数、无 HydrationContext；便于前端 / 3D 缓存加载。
   */
  toSnapshot(): HydratedEntitySnapshot {
    return this._toSnapshotGuarded(new Set());
  }

  private _toSnapshotGuarded(path: Set<HydratedEntity>): HydratedEntitySnapshot {
    const data = this.getData() as Record<string, unknown>;
    const snap: {
      model: string;
      data: Record<string, unknown>;
      relates?: Record<string, HydratedEntitySnapshot[]>;
      relationStatus?: Record<string, RelationTraceStatus>;
    } = { model: this.modelName, data: { ...data } };
    if (this.relates.size > 0 && !path.has(this)) {
      path.add(this);
      const rel: Record<string, HydratedEntitySnapshot[]> = {};
      for (const [k, v] of this.relates) {
        rel[k] = v.map((c) => c._toSnapshotGuarded(path));
      }
      snap.relates = rel;
      path.delete(this);
    }
    const st: Record<string, RelationTraceStatus> = {};
    for (const [k, v] of this.relationStatus) {
      st[k] = v;
    }
    if (Object.keys(st).length > 0) {
      snap.relationStatus = st;
    }
    return snap;
  }

  /** 所有关系槽位下的子实体（按插入顺序合并）；树形查询通常只有一个自关联槽位。 */
  private childEntities(): HydratedEntity[] {
    const out: HydratedEntity[] = [];
    for (const v of this.relates.values()) {
      out.push(...v);
    }
    return out;
  }

  /**
   * 将以本实体为根的子树**展平**为有序实体数组（含自身）。
   * 一对一链时即「上下游」强顺序；`dfs`（默认）为前序，`bfs` 为层序。多对多被多个父引用的子节点会按其在树中的出现各计一次。
   */
  flatten(options?: { readonly order?: 'dfs' | 'bfs' }): HydratedEntity[] {
    const order = options?.order ?? 'dfs';
    const out: HydratedEntity[] = [];
    if (order === 'bfs') {
      const seen = new Set<HydratedEntity>();
      let level: HydratedEntity[] = [this];
      while (level.length > 0) {
        const next: HydratedEntity[] = [];
        for (const e of level) {
          out.push(e);
          if (seen.has(e)) {
            continue;
          }
          seen.add(e);
          next.push(...e.childEntities());
        }
        level = next;
      }
      return out;
    }
    const path = new Set<HydratedEntity>();
    const visit = (e: HydratedEntity): void => {
      out.push(e);
      if (path.has(e)) {
        return;
      }
      path.add(e);
      for (const child of e.childEntities()) {
        visit(child);
      }
      path.delete(e);
    };
    visit(this);
    return out;
  }

  /**
   * 将以本实体为根的子树**聚合为一棵树**：返回纯 JSON，子节点置于 `childrenKey`（默认 `children`）字段下。
   */
  toTree(options?: { readonly childrenKey?: string }): Record<string, unknown> {
    return this._toTreeGuarded(options?.childrenKey ?? 'children', new Set());
  }

  private _toTreeGuarded(childrenKey: string, path: Set<HydratedEntity>): Record<string, unknown> {
    const out = { ...(this.getData() as Record<string, unknown>) };
    const kids = this.childEntities();
    if (kids.length > 0 && !path.has(this)) {
      path.add(this);
      out[childrenKey] = kids.map((c) => c._toTreeGuarded(childrenKey, path));
      path.delete(this);
    }
    return out;
  }

  /** @internal */
  _setRelate(name: string, children: HydratedEntity[]): void {
    this.relates.set(name, children);
    if (children.length > 0) {
      const d = this.diagnostics.get(name);
      if (d?.reason === 'FILTERED_OUT_ORPHAN') {
        this.relationStatus.set(name, 'FILTERED_OUT');
      } else {
        this.relationStatus.set(name, 'SUCCESS');
      }
      return;
    }
    if (!this.diagnostics.has(name)) {
      this.relationStatus.delete(name);
    }
  }

  /** @internal */
  _setDiagnostic(name: string, d: RelateDiagnostic): void {
    this.diagnostics.set(name, d);
    this.relationStatus.set(name, reasonToTraceStatus(d.reason));
  }
}

export type { QueryExecuteOptions } from '@mode-db/shared';
