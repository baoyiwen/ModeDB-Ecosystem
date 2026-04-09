import type { ModelRecord, RelationDefinition } from '../../common/types.js';
import type { ModelRegistry } from '../../common/registry.js';
import type { DataReader, IndexReader } from '../../common/provider.js';
import { RelationNotFoundError } from '../../common/errors.js';

type ResolvedDirection = 'forward' | 'reverse';

interface PendingHop {
  readonly relationName: string;
}

interface ResolvedRelation {
  readonly definition: RelationDefinition;
  readonly direction: ResolvedDirection;
}

/**
 * Chainable query over `.mld` / `.rid` data via {@link DataReader} + {@link IndexReader} only.
 */
export class QueryChain {
  private currentModel: string;
  private currentIds: string[];
  private readonly hops: PendingHop[] = [];

  constructor(
    private readonly registry: ModelRegistry,
    private readonly indexReader: IndexReader,
    private readonly dataReader: DataReader,
    startModel: string,
    startIds: string[],
  ) {
    this.currentModel = startModel;
    this.currentIds = startIds;
  }

  relate(relationName: string): this {
    this.hops.push({ relationName });
    return this;
  }

  async execute(): Promise<ModelRecord[]> {
    for (const hop of this.hops) {
      const resolved = this.resolveRelation(hop.relationName, this.currentModel);
      const nextIds = await this.collectNextIds(resolved, this.currentIds);

      this.currentModel =
        resolved.direction === 'forward' ? resolved.definition.target : resolved.definition.source;
      this.currentIds = nextIds;

      if (this.currentIds.length === 0) {
        return [];
      }
    }

    return this.dataReader.getByIds(this.currentModel, this.currentIds);
  }

  private resolveRelation(relationName: string, modelName: string): ResolvedRelation {
    const chain = this.registry.getInheritanceChain(modelName);

    for (const ancestor of chain) {
      const relations = this.registry.getRelationsOf(ancestor);

      for (const rel of relations) {
        if (rel.source === ancestor && rel.forward === relationName) {
          return { definition: rel, direction: 'forward' };
        }
        if (rel.target === ancestor && rel.reverse === relationName) {
          return { definition: rel, direction: 'reverse' };
        }
      }
    }

    throw new RelationNotFoundError(relationName, modelName);
  }

  private async collectNextIds(
    resolved: ResolvedRelation,
    currentIds: string[],
  ): Promise<string[]> {
    const nextSet = new Set<string>();

    const lookups = currentIds.map(async (id) => {
      const linked =
        resolved.direction === 'forward'
          ? await this.indexReader.getForward(resolved.definition, id)
          : await this.indexReader.getReverse(resolved.definition, id);

      for (const linkedId of linked) {
        nextSet.add(linkedId);
      }
    });

    await Promise.all(lookups);
    return [...nextSet];
  }
}
