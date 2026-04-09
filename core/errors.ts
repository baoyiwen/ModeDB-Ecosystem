/**
 * Base error for all storage-layer failures.
 */
export class StorageError extends Error {
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
