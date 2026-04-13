import { ModelRegistry } from '../common/registry.js';
import { RegistryError } from '../common/errors.js';
import type { PathResolver } from '../src/common/PathResolver.js';
import type { ModelStorage } from './storage.js';
import type { RelationIndexer } from './indexer.js';
import type { PersistenceManager } from './persistence-manager.js';
import { ModelEntity } from './entity.js';
import { RelationEntity } from './relation-entity.js';

/**
 * Authoring registry: same definitions as {@link ModelRegistry}, plus Active Record handles.
 *
 * Use `registry.model('Pump')` / `registry.relation('located_in')` instead of raw `getModel` JSON.
 */
export class AtlasRegistry extends ModelRegistry {
  private readonly _modelHandles = new Map<string, ModelEntity>();

  constructor(
    private readonly _storage: ModelStorage,
    private readonly _indexer: RelationIndexer,
    private readonly _paths: PathResolver,
    private readonly _persistence: PersistenceManager,
  ) {
    super();
  }

  /**
   * Active Record handle for a registered model (schema, insert, query chain, bind).
   * Handles are cached so each model shares one write-behind buffer reference.
   */
  model(name: string): ModelEntity {
    let h = this._modelHandles.get(name);
    if (h) {
      return h;
    }
    if (!this.getModel(name)) {
      throw new RegistryError(`Model "${name}" is not registered.`);
    }
    h = new ModelEntity(name, this, this._storage, this._indexer, this._paths, this._persistence);
    this._modelHandles.set(name, h);
    return h;
  }

  /**
   * Active Record handle for a relation protocol (bind / unlink / stats by forward or reverse label).
   */
  relation(label: string): RelationEntity {
    const def = this.findRelationByLabel(label);
    if (!def) {
      throw new RegistryError(
        `Relation "${label}" is not registered (checked both forward and reverse).`,
      );
    }
    return new RelationEntity(def, this, this._indexer, this._paths, this._persistence);
  }
}
