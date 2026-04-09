import { createReadStream } from 'node:fs';
import { mkdir, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelSchema, ModelRecord } from './types.js';
import { ModelNotRegisteredError, FileIOError } from './errors.js';

const DATA_ROOT = join(process.cwd(), 'data', 'models');

/**
 * Physical storage layer for model data.
 *
 * Each model is persisted as a JSONL file (`data/models/{modelName}.mld`).
 * Records are append-only; every line is a self-contained JSON object
 * containing only schema-declared fields plus engine metadata (`_id`, `_createdAt`).
 */
export class ModelStorage {
  private readonly schemas = new Map<string, ModelSchema>();

  /**
   * Register a model schema so the storage layer knows which fields to persist.
   *
   * @param schema - The model schema definition.
   * @throws {Error} If a schema with the same name is already registered.
   */
  registerSchema(schema: ModelSchema): void {
    if (this.schemas.has(schema.name)) {
      throw new Error(`Schema "${schema.name}" is already registered.`);
    }
    this.schemas.set(schema.name, schema);
  }

  /**
   * Append a new record to the model's `.mld` file.
   *
   * The data is sanitized against the registered schema — only declared fields
   * are persisted, enforcing model purity. An `_id` (UUIDv4) and `_createdAt`
   * (ISO-8601) are generated automatically.
   *
   * @param modelName - Name of the registered model.
   * @param data - Raw data object. Unknown fields are silently stripped.
   * @returns The persisted record including generated metadata.
   * @throws {ModelNotRegisteredError} If `modelName` has no registered schema.
   * @throws {FileIOError} If the write operation fails.
   */
  async insert(modelName: string, data: Record<string, unknown>): Promise<ModelRecord> {
    const schema = this.resolveSchema(modelName);
    const clean = this.sanitize(data, schema);

    const record: ModelRecord = {
      _id: randomUUID(),
      _createdAt: new Date().toISOString(),
      ...clean,
    };

    const filePath = this.filePath(modelName);
    await this.ensureDir();

    try {
      await appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      throw new FileIOError(`Failed to write record to "${modelName}"`, filePath, { cause: err });
    }

    return record;
  }

  /**
   * Retrieve records by their IDs using streaming line-by-line reads.
   *
   * Only matching records are loaded into memory, keeping the footprint
   * proportional to the result set rather than the file size.
   *
   * @param modelName - Name of the registered model.
   * @param ids - Array of `_id` values to look up.
   * @returns Array of matching records (order not guaranteed).
   * @throws {ModelNotRegisteredError} If `modelName` has no registered schema.
   * @throws {FileIOError} If the file cannot be read.
   */
  async getByIds(modelName: string, ids: string[]): Promise<ModelRecord[]> {
    this.resolveSchema(modelName);

    if (ids.length === 0) {
      return [];
    }

    const target = new Set(ids);
    const results: ModelRecord[] = [];
    const filePath = this.filePath(modelName);

    let stream: ReturnType<typeof createReadStream> | undefined;
    try {
      stream = createReadStream(filePath, 'utf-8');
    } catch (err) {
      throw new FileIOError(`Failed to open "${modelName}" data file`, filePath, { cause: err });
    }

    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (target.size === 0) {
          break;
        }

        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        const record = JSON.parse(trimmed) as ModelRecord;
        if (target.has(record._id)) {
          results.push(record);
          target.delete(record._id);
        }
      }
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return [];
      }
      throw new FileIOError(`Failed to read records from "${modelName}"`, filePath, { cause: err });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveSchema(modelName: string): ModelSchema {
    const schema = this.schemas.get(modelName);
    if (!schema) {
      throw new ModelNotRegisteredError(modelName);
    }
    return schema;
  }

  /** Strip any key not declared in the schema's field set. */
  private sanitize(data: Record<string, unknown>, schema: ModelSchema): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      if (schema.fields.has(key)) {
        clean[key] = data[key];
      }
    }
    return clean;
  }

  private filePath(modelName: string): string {
    return join(DATA_ROOT, `${modelName}.mld`);
  }

  private dirReady = false;

  private async ensureDir(): Promise<void> {
    if (this.dirReady) {
      return;
    }
    await mkdir(DATA_ROOT, { recursive: true });
    this.dirReady = true;
  }
}

/** Type guard for Node.js system errors that carry a `code` property. */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
