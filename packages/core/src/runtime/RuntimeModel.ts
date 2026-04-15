import type {
  ModelDefinition,
  RelationDefinition,
  ModelRecord,
  ModelRegistry,
  DataReader,
  IndexReader,
  SmartCache,
} from '@mode-db/common';
import { QueryChain } from './query.js';
import type { FieldMatchContext } from './query-filter.js';
import type { MemoryShadowOptions } from './HydratedEntity.js';
/**
 * Read-only model view: query / all / schema introspection only.
 */
export class RuntimeModel {
  readonly name: string;
  protected fieldContext: FieldMatchContext | undefined;
  protected memoryShadow: MemoryShadowOptions | undefined;
  protected smartCache: SmartCache | undefined;

  constructor(
    name: string,
    protected readonly registry: ModelRegistry,
    protected readonly dataReader: DataReader,
    protected readonly indexReader: IndexReader,
    fieldContext?: FieldMatchContext,
    memoryShadow?: MemoryShadowOptions,
    smartCache?: SmartCache,
  ) {
    this.name = name;
    this.fieldContext = fieldContext;
    this.memoryShadow = memoryShadow;
    this.smartCache = smartCache;
  }

  getSchema(): ModelDefinition {
    const def = this.registry.getModel(this.name);
    if (!def) {
      throw new Error(`Model "${this.name}" is not registered.`);
    }
    return def;
  }

  getAncestors(): string[] {
    return this.registry.getInheritanceChain(this.name).slice(1);
  }

  /**
   * @param ids 省略或 `undefined` 表示从该模型**全表**起步（再结合 {@link QueryChain.where} 等缩小）。
   */
  query<M extends Record<string, unknown> = Record<string, unknown>>(
    ids?: readonly string[],
  ): QueryChain<M, 'rows'> {
    if (ids === undefined) {
      return new QueryChain(
        this.registry,
        this.indexReader,
        this.dataReader,
        this.name,
        {
          kind: 'all',
        },
        this.fieldContext,
        this.memoryShadow,
        this.smartCache,
      );
    }
    return new QueryChain(
      this.registry,
      this.indexReader,
      this.dataReader,
      this.name,
      {
        kind: 'ids',
        ids: [...ids],
      },
      this.fieldContext,
      this.memoryShadow,
      this.smartCache,
    );
  }

  find<M extends Record<string, unknown> = Record<string, unknown>>(
    ids: string[],
  ): QueryChain<M, 'rows'> {
    return this.query(ids);
  }

  async all(): Promise<ModelRecord[]> {
    return this.dataReader.getAll(this.name);
  }

  get parentId(): string | null {
    return this.getSchema().parentId;
  }

  get fields(): ReadonlySet<string> {
    return this.getSchema().fields;
  }

  getInheritanceChain(): string[] {
    return this.registry.getInheritanceChain(this.name);
  }

  getAvailableRelations(): RuntimeAvailableRelation[] {
    const chain = this.registry.getInheritanceChain(this.name);
    const result: RuntimeAvailableRelation[] = [];
    const seen = new Set<string>();

    for (const ancestor of chain) {
      const rels = this.registry.getRelationsOf(ancestor);
      for (const rel of rels) {
        const key = `${rel.source}::${rel.target}::${rel.forward}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        if (rel.source === ancestor) {
          result.push({ relation: rel, via: ancestor, direction: 'forward' });
        }
        if (rel.target === ancestor) {
          result.push({ relation: rel, via: ancestor, direction: 'reverse' });
        }
      }
    }
    return result;
  }
}

export interface RuntimeAvailableRelation {
  readonly relation: RelationDefinition;
  readonly via: string;
  readonly direction: 'forward' | 'reverse';
}
