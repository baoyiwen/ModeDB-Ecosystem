import type { ModelDefinition, RelationDefinition, ModelRecord } from '../../common/types.js';
import type { ModelRegistry } from '../../common/registry.js';
import type { DataReader, IndexReader } from '../../common/provider.js';
import { QueryChain } from './query.js';

/**
 * Read-only model view: query / all / schema introspection only.
 */
export class RuntimeModel {
  readonly name: string;

  constructor(
    name: string,
    protected readonly registry: ModelRegistry,
    protected readonly dataReader: DataReader,
    protected readonly indexReader: IndexReader,
  ) {
    this.name = name;
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

  query(ids: string[]): QueryChain {
    return new QueryChain(this.registry, this.indexReader, this.dataReader, this.name, ids);
  }

  find(ids: string[]): QueryChain {
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
