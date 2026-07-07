import type {
  ModelDefinition,
  RelationDefinition,
  RelationLogic,
  RelationSelfLoopPolicy,
  MatchPredicate,
} from './types.js';
import type { FieldTypeDef } from './data-types.js';
import {
  DuplicateModelError,
  ParentNotFoundError,
  DuplicateRelationError,
  RelationModelNotFoundError,
  RegistryError,
} from './errors.js';
import { assertFlatGraphSegment } from './atlas-segments.js';

/**
 * Composite key for the relation uniqueness index.
 * Encodes a directed model pair as `"source::target"`.
 */
function pairKey(source: string, target: string): string {
  return `${source}::${target}`;
}

/**
 * Central registry for model definitions and relation definitions.
 *
 * Supports the skeleton-first pattern: models and relations can be registered
 * with minimal information and completed later via update methods.
 */
export class ModelRegistry {
  private readonly models = new Map<string, ModelDefinition>();
  private readonly relations: RelationDefinition[] = [];

  /**
   * Set of all relation labels already used for each directed model pair.
   * Key: `"source::target"`, Value: set of label strings (both fwd and rev).
   */
  private readonly pairLabels = new Map<string, Set<string>>();

  /**
   * Register a new model. Supports skeleton-first: `fields` defaults to an
   * empty set and can be filled in later via {@link updateModelFields}.
   *
   * @param name - Unique model name.
   * @param fields - Property names this model persists. Defaults to empty.
   * @param parentId - Optional parent model name (inheritance-lock applies).
   * @returns The {@link ModelDefinition}.
   * @throws {DuplicateModelError} If a model with the same name already exists.
   * @throws {ParentNotFoundError} If `parentId` is specified but not registered.
   */
  registerModel(
    name: string,
    fields: ReadonlySet<string> = new Set(),
    parentId: string | null = null,
    fieldTypes: Map<string, FieldTypeDef> = new Map(),
  ): ModelDefinition {
    assertFlatGraphSegment(name, 'model name');
    if (parentId !== null) {
      assertFlatGraphSegment(parentId, 'parent model id');
    }

    if (this.models.has(name)) {
      throw new DuplicateModelError(name);
    }

    if (parentId !== null && !this.models.has(parentId)) {
      throw new ParentNotFoundError(name, parentId);
    }

    const definition: ModelDefinition = { name, parentId, fields, fieldTypes };
    this.models.set(name, definition);
    return definition;
  }

  /**
   * Register a relation between two models. Supports skeleton-first:
   * `logic` and `matchOn` default to `null` and can be filled in later
   * via {@link updateRelationLogic}.
   *
   * @param source - Name of the source model (must be registered).
   * @param target - Name of the target model (must be registered).
   * @param forward - Label describing the source->target direction.
   * @param reverse - Label describing the target->source direction.
   * @param logic - Cardinality logic, or `null` for deferred completion.
   * @param matchOn - Attribute-equality predicate, or `null` for deferred.
   * @returns The {@link RelationDefinition}.
   * @throws {RelationModelNotFoundError} If source or target model is not registered.
   * @throws {DuplicateRelationError} If any label conflicts with existing labels on this pair.
   */
  registerRelation(
    source: string,
    target: string,
    forward: string,
    reverse: string,
    logic: RelationLogic | null = null,
    matchOn: MatchPredicate | null = null,
    selfLoopPolicy: RelationSelfLoopPolicy = 'deny',
  ): RelationDefinition {
    assertFlatGraphSegment(source, 'relation source model');
    assertFlatGraphSegment(target, 'relation target model');
    assertFlatGraphSegment(forward, 'relation forward label');
    assertFlatGraphSegment(reverse, 'relation reverse label');

    const label = `${source} -[${forward}]-> ${target}`;

    if (!this.models.has(source)) {
      throw new RelationModelNotFoundError(label, source);
    }
    if (!this.models.has(target)) {
      throw new RelationModelNotFoundError(label, target);
    }

    if (forward === reverse) {
      throw new DuplicateRelationError(
        `Forward label "${forward}" and reverse label "${reverse}" must be different.`,
      );
    }

    const key = pairKey(source, target);
    const existing = this.pairLabels.get(key) ?? new Set<string>();

    if (existing.has(forward)) {
      throw new DuplicateRelationError(
        `Label "${forward}" is already used on the pair (${source}, ${target}).`,
      );
    }
    if (existing.has(reverse)) {
      throw new DuplicateRelationError(
        `Label "${reverse}" is already used on the pair (${source}, ${target}).`,
      );
    }

    existing.add(forward);
    existing.add(reverse);
    this.pairLabels.set(key, existing);

    const definition: RelationDefinition = {
      source,
      target,
      forward,
      reverse,
      logic,
      matchOn,
      selfLoopPolicy,
    };
    this.relations.push(definition);
    return definition;
  }

  /**
   * Replace the field set of an already-registered model (deferred completion).
   *
   * @param name - The model name.
   * @param fields - The new field set.
   * @throws {RegistryError} If the model is not registered.
   */
  updateModelFields(
    name: string,
    fields: ReadonlySet<string>,
    fieldTypes?: Map<string, FieldTypeDef>,
  ): void {
    const model = this.models.get(name);
    if (!model) {
      throw new RegistryError(`Cannot update fields: model "${name}" is not registered.`);
    }
    model.fields = fields;
    if (fieldTypes !== undefined) {
      model.fieldTypes = fieldTypes;
    }
  }

  /**
   * Update the logic and optionally the matchOn predicate of a relation
   * identified by its forward label (deferred completion).
   *
   * @param forwardName - The forward label of the relation to update.
   * @param logic - The new cardinality logic.
   * @param matchOn - Optional new match predicate.
   * @throws {RegistryError} If no relation with the given forward label exists.
   */
  updateRelationLogic(
    forwardName: string,
    logic: RelationLogic,
    matchOn?: MatchPredicate,
    selfLoopPolicy?: RelationSelfLoopPolicy,
  ): void {
    const rel = this.findRelationByForward(forwardName);
    if (!rel) {
      throw new RegistryError(
        `Cannot update logic: relation with forward label "${forwardName}" not found.`,
      );
    }
    rel.logic = logic;
    if (matchOn !== undefined) {
      rel.matchOn = matchOn;
    }
    if (selfLoopPolicy !== undefined) {
      rel.selfLoopPolicy = selfLoopPolicy;
    }
  }

  /**
   * Look up a registered model by name.
   *
   * @param name - The model name.
   * @returns The model definition, or `undefined` if not registered.
   */
  getModel(name: string): ModelDefinition | undefined {
    return this.models.get(name);
  }

  /**
   * All registered models (unordered). Used for atlas manifest export.
   */
  getModelDefinitions(): readonly ModelDefinition[] {
    return [...this.models.values()];
  }

  /**
   * Return all registered relations.
   */
  getRelations(): readonly RelationDefinition[] {
    return this.relations;
  }

  /**
   * Return all relations where the given model is the source or target.
   *
   * @param modelName - The model to query relations for.
   * @returns Array of matching relation definitions.
   */
  getRelationsOf(modelName: string): RelationDefinition[] {
    return this.relations.filter((r) => r.source === modelName || r.target === modelName);
  }

  /**
   * Resolve the full inheritance chain for a model, from the model itself
   * up to the root ancestor.
   *
   * @param modelName - The starting model name.
   * @returns Array of model names ordered `[self, parent, grandparent, …, root]`.
   * @throws {Error} If `modelName` is not registered.
   * @throws {Error} If a cycle is detected in the inheritance chain.
   */
  getInheritanceChain(modelName: string): string[] {
    const chain: string[] = [];
    const visited = new Set<string>();
    let current: string | null = modelName;

    while (current !== null) {
      if (visited.has(current)) {
        throw new Error(
          `Inheritance cycle detected: "${current}" appears twice in the chain [${chain.join(' → ')}].`,
        );
      }

      const model = this.models.get(current);
      if (!model) {
        if (chain.length === 0) {
          throw new Error(`Model "${current}" is not registered.`);
        }
        throw new Error(
          `Broken inheritance chain: model "${current}" (parent of "${chain.at(-1)}") is not registered.`,
        );
      }

      visited.add(current);
      chain.push(current);
      current = model.parentId;
    }

    return chain;
  }

  /**
   * Return all model names that are descendants of `modelName` (children,
   * grandchildren, etc.) plus `modelName` itself.
   *
   * Useful for inheritance-aware file scanning — a relation registered on a
   * parent model needs to also scan data files of all child models.
   */
  getDescendantsInclusive(modelName: string): string[] {
    const result: string[] = [modelName];
    const queue = [modelName];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [name, def] of this.models) {
        if (def.parentId === current) {
          result.push(name);
          queue.push(name);
        }
      }
    }
    return result;
  }

  /**
   * Find a relation by either its forward or reverse label.
   *
   * This enables the bidirectional symmetry requirement: looking up
   * `'located_in'` and `'contains_equip'` returns the same definition.
   *
   * @param label - A forward or reverse relation label.
   * @returns The matching definition, or `undefined`.
   */
  findRelationByLabel(label: string): RelationDefinition | undefined {
    return this.relations.find((r) => r.forward === label || r.reverse === label);
  }

  /**
   * Remove a relation definition (inverse of {@link registerRelation}).
   * Does not touch on-disk indices; callers must clear vault / `.rid` files separately.
   */
  unregisterRelation(def: RelationDefinition): void {
    const idx = this.relations.indexOf(def);
    if (idx === -1) {
      return;
    }
    this.relations.splice(idx, 1);
    const key = pairKey(def.source, def.target);
    const labels = this.pairLabels.get(key);
    if (labels) {
      labels.delete(def.forward);
      labels.delete(def.reverse);
      if (labels.size === 0) {
        this.pairLabels.delete(key);
      }
    }
  }

  /**
   * Remove a model definition. Relations touching this model must be removed first.
   */
  unregisterModel(name: string): void {
    assertFlatGraphSegment(name, 'model name');
    if (!this.models.has(name)) {
      throw new RegistryError(`Cannot unregister: model "${name}" is not registered.`);
    }
    const touching = this.getRelationsOf(name);
    if (touching.length > 0) {
      throw new RegistryError(
        `Cannot unregister model "${name}": ${touching.length} relation(s) still reference it.`,
      );
    }
    for (const def of this.models.values()) {
      if (def.parentId === name) {
        throw new RegistryError(
          `Cannot unregister model "${name}": child model "${def.name}" still has parentId "${name}".`,
        );
      }
    }
    this.models.delete(name);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private findRelationByForward(forwardName: string): RelationDefinition | undefined {
    return this.relations.find((r) => r.forward === forwardName);
  }
}
