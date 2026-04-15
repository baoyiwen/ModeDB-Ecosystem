import type { ModelRegistry, DataReader, IndexReader } from '@mode-db/common';
import type { HydratedEntity, HydrationContext } from './HydratedEntity.js';
import type { QueryChain } from './query.js';

export type NewQueryChainFn = (
  registry: ModelRegistry,
  indexReader: IndexReader,
  dataReader: DataReader,
  originModel: string,
  ids: readonly string[],
) => QueryChain;

/**
 * 单分组桶的运行时视图：聚合统计 + 组成员 + 可在此实例上再起 {@link QueryChain}。
 *
 * 与 {@link HydratedEntity} 一致提供 **`getData()`**（合并维度列与指标列，同 {@link AnalysisResult.asFlatTable} 单行语义），便于 UI 统一处理。
 */
export class GroupInstance {
  constructor(
    readonly dimensionKeys: readonly string[],
    readonly dimensionValues: readonly unknown[],
    private readonly aggregates: Readonly<Record<string, unknown>>,
    private readonly memberEntities: readonly HydratedEntity[],
    private readonly originModel: string,
    private readonly ctx: HydrationContext,
    private readonly newQueryChain: NewQueryChainFn,
  ) {}

  /** 与 {@link HydratedEntity.getModelName} 对齐：分组所在源模型名。 */
  getModelName(): string {
    return this.originModel;
  }

  /**
   * 维度值 + 聚合指标合并为平面对象（表格一行 / 卡片头）。
   */
  getData(): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < this.dimensionKeys.length; i++) {
      row[this.dimensionKeys[i]!] = this.dimensionValues[i];
    }
    for (const [k, v] of Object.entries(this.aggregates)) {
      row[k] = v;
    }
    return row;
  }

  /** 落入该桶的实体（已通过末端模型水合）。 */
  getEntities(): readonly HydratedEntity[] {
    return this.memberEntities;
  }

  /**
   * 以组成员 `_id` 为起点构造新的查询链（**`start: { kind: 'ids' }`**），可继续 `where` / `relate` / `execute`。
   */
  query(): QueryChain {
    const ids = this.memberEntities.map((e) => e.getData()._id);
    return this.newQueryChain(
      this.ctx.registry,
      this.ctx.indexReader,
      this.ctx.dataReader,
      this.originModel,
      ids,
    );
  }
}

export function isGroupInstance(x: unknown): x is GroupInstance {
  return x instanceof GroupInstance;
}
