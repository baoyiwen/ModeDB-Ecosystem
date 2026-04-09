/**
 * Base error for all engine failures.
 */
export class EngineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EngineError';
  }
}

/**
 * Thrown when a path or identifier would escape the current atlas directory sandbox.
 */
export class AtlasIsolationError extends EngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AtlasIsolationError';
  }
}

/**
 * Thrown when `atlas-manifest.json` is missing, invalid, or fails checksum / atlas binding.
 */
export class AtlasManifestError extends EngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AtlasManifestError';
  }
}

// ---------------------------------------------------------------------------
// Storage errors
// ---------------------------------------------------------------------------

/**
 * Base error for all storage-layer failures.
 */
export class StorageError extends EngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageError';
  }
}

/**
 * Thrown when an operation references a model that has no registered schema.
 */
export class ModelNotRegisteredError extends StorageError {
  constructor(modelName: string) {
    super(
      `Model "${modelName}" is not registered. Register a schema before performing operations.`,
    );
    this.name = 'ModelNotRegisteredError';
  }
}

/**
 * Thrown when a file-system operation (read/write/mkdir) fails.
 */
export class FileIOError extends StorageError {
  constructor(
    message: string,
    public readonly filePath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FileIOError';
  }
}

// ---------------------------------------------------------------------------
// Registry errors
// ---------------------------------------------------------------------------

/**
 * Base error for all registry-layer failures.
 */
export class RegistryError extends EngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RegistryError';
  }
}

/**
 * Thrown when attempting to register a model whose name is already taken.
 */
export class DuplicateModelError extends RegistryError {
  constructor(modelName: string) {
    super(`Model "${modelName}" is already registered.`);
    this.name = 'DuplicateModelError';
  }
}

/**
 * Thrown when a model references a parent that does not exist in the registry.
 */
export class ParentNotFoundError extends RegistryError {
  constructor(modelName: string, parentId: string) {
    super(`Cannot register model "${modelName}": parent model "${parentId}" does not exist.`);
    this.name = 'ParentNotFoundError';
  }
}

/**
 * Thrown when a relation registration violates uniqueness constraints.
 */
export class DuplicateRelationError extends RegistryError {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateRelationError';
  }
}

/**
 * Thrown when a relation references a model that does not exist.
 */
export class RelationModelNotFoundError extends RegistryError {
  constructor(relationLabel: string, modelName: string) {
    super(`Cannot register relation "${relationLabel}": model "${modelName}" does not exist.`);
    this.name = 'RelationModelNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Indexer errors
// ---------------------------------------------------------------------------

/**
 * Base error for all indexer-layer failures.
 */
export class IndexerError extends EngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IndexerError';
  }
}

// ---------------------------------------------------------------------------
// Query errors
// ---------------------------------------------------------------------------

/**
 * Base error for all query-layer failures.
 */
export class QueryError extends EngineError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'QueryError';
  }
}

/**
 * Thrown when a relation label cannot be resolved against the current model
 * or any of its ancestors.
 */
export class RelationNotFoundError extends QueryError {
  constructor(relationName: string, modelName: string) {
    super(`Relation "${relationName}" not found on model "${modelName}" or any of its ancestors.`);
    this.name = 'RelationNotFoundError';
  }
}
