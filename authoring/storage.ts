import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ModelSchema, ModelRecord } from '../common/types.js';
import type { DataReader } from '../common/provider.js';
import type { PathResolver } from '../src/common/PathResolver.js';
import { ModelNotRegisteredError, FileIOError } from '../common/errors.js';
import { validateFieldValue, coerceI18NValue, type FieldTypeDef } from '../common/data-types.js';
import type { FieldMatchContext } from '../src/runtime/query-filter.js';

const SCHEMA_HEADER_KEY = '__schema__';

function isSchemaHeaderLine(line: string): boolean {
  return line.startsWith(`{"${SCHEMA_HEADER_KEY}":`);
}

function buildSchemaHeaderLine(schema: ModelSchema): string {
  const ft: Record<string, { type: string; required?: boolean; unit?: string }> = {};
  for (const [k, v] of schema.fieldTypes) {
    const entry: { type: string; required?: boolean; unit?: string } = {
      type: v.type,
    };
    if (v.required) {
      entry.required = v.required;
    }
    if (v.unit) {
      entry.unit = v.unit;
    }
    ft[k] = entry;
  }
  const header = {
    [SCHEMA_HEADER_KEY]: {
      fields: [...schema.fields].sort(),
      ...(Object.keys(ft).length > 0 ? { fieldTypes: ft } : {}),
    },
  };
  return JSON.stringify(header);
}

/**
 * Physical storage layer for model data.
 *
 * All paths come from `PathResolver` — no hard-coded directories.
 * Model files: `<STORAGE_ROOT>/<atlas>/models/{modelName}.mld`.
 * Records are append-only; every line is a self-contained JSON object
 * containing only schema-declared fields plus engine metadata (`_id`, `_createdAt`).
 *
 * Implements {@link DataReader} so the runtime layer can consume read
 * operations without access to write methods.
 */
export class ModelStorage implements DataReader {
  private readonly schemas = new Map<string, ModelSchema>();
  /** Current locale for I18N auto-wrap on insert; set by AuthoringEngine. */
  locale: string | undefined;

  constructor(private readonly paths: PathResolver) {}

  registerSchema(schema: ModelSchema): void {
    if (this.schemas.has(schema.name)) {
      return;
    }
    this.schemas.set(schema.name, {
      name: schema.name,
      fields: schema.fields,
      fieldTypes: schema.fieldTypes ?? new Map(),
    });
  }

  updateSchema(
    name: string,
    fields: ReadonlySet<string>,
    fieldTypes?: Map<string, FieldTypeDef>,
  ): void {
    const schema = this.schemas.get(name);
    if (!schema) {
      throw new ModelNotRegisteredError(name);
    }
    schema.fields = fields;
    if (fieldTypes !== undefined) {
      schema.fieldTypes = fieldTypes;
    }
  }

  /** Retrieve the in-memory schema for a model (used by persistence layer for schema header). */
  getSchema(modelName: string): ModelSchema | undefined {
    return this.schemas.get(modelName);
  }

  /** Build a FieldMatchContext from the current locale (used by ModelEntity for query threading). */
  get fieldContext(): FieldMatchContext | undefined {
    if (!this.locale) {
      return undefined;
    }
    return { locale: this.locale };
  }

  /**
   * Build one persisted row (UUID + timestamp + schema-filtered fields) without writing to disk.
   * Used by the authoring persistence layer for buffered inserts.
   */
  prepareInsert(modelName: string, data: Record<string, unknown>): ModelRecord {
    const schema = this.resolveSchema(modelName);
    const clean = this.sanitize(data, schema);
    return {
      _id: randomUUID(),
      _createdAt: new Date().toISOString(),
      ...clean,
    };
  }

  /** Append JSON lines to the model `.mld` file (used by flush / direct insert). */
  async appendRecordsToDisk(modelName: string, records: readonly ModelRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const schema = this.resolveSchema(modelName);
    const filePath = this.filePath(modelName);
    await this.ensureDir();

    const isNew = !existsSync(filePath) || statSync(filePath).size === 0;
    let body = '';
    if (isNew) {
      body += buildSchemaHeaderLine(schema) + '\n';
    }
    for (const r of records) {
      body += JSON.stringify(r) + '\n';
    }
    try {
      await appendFile(filePath, body, 'utf-8');
    } catch (err) {
      throw new FileIOError(`Failed to write record(s) to "${modelName}"`, filePath, {
        cause: err,
      });
    }
  }

  /**
   * Atomically rewrite the entire `.mld` file with the given rows (used by flush to compact
   * tombstoned records out of the persisted file). Prepends a `__schema__` header line.
   */
  async rewriteRecordsToDisk(modelName: string, records: readonly ModelRecord[]): Promise<void> {
    const schema = this.resolveSchema(modelName);
    const filePath = this.filePath(modelName);
    await this.ensureDir();
    let body = buildSchemaHeaderLine(schema) + '\n';
    for (const r of records) {
      body += JSON.stringify(r) + '\n';
    }
    try {
      await writeFile(filePath, body, 'utf-8');
    } catch (err) {
      throw new FileIOError(`Failed to rewrite "${modelName}"`, filePath, { cause: err });
    }
  }

  /** Direct disk insert (bypasses the authoring write buffer). */
  async insert(modelName: string, data: Record<string, unknown>): Promise<ModelRecord> {
    const record = this.prepareInsert(modelName, data);
    await this.appendRecordsToDisk(modelName, [record]);
    return record;
  }

  async getAll(modelName: string): Promise<ModelRecord[]> {
    this.resolveSchema(modelName);
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
        const trimmed = line.trim();
        if (trimmed.length === 0 || isSchemaHeaderLine(trimmed)) {
          continue;
        }
        results.push(JSON.parse(trimmed) as ModelRecord);
      }
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return [];
      }
      throw new FileIOError(`Failed to read records from "${modelName}"`, filePath, { cause: err });
    }

    return results;
  }

  async scanModelRecords(
    modelName: string,
    visitor: (record: ModelRecord) => void | Promise<void>,
  ): Promise<void> {
    this.resolveSchema(modelName);
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
        const trimmed = line.trim();
        if (trimmed.length === 0 || isSchemaHeaderLine(trimmed)) {
          continue;
        }
        const record = JSON.parse(trimmed) as ModelRecord;
        await visitor(record);
      }
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return;
      }
      throw new FileIOError(`Failed to scan records from "${modelName}"`, filePath, { cause: err });
    }
  }

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
        if (trimmed.length === 0 || isSchemaHeaderLine(trimmed)) {
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

  async findFirstByFieldEq(
    modelName: string,
    field: string,
    value: unknown,
  ): Promise<ModelRecord | undefined> {
    this.resolveSchema(modelName);
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
        const trimmed = line.trim();
        if (trimmed.length === 0 || isSchemaHeaderLine(trimmed)) {
          continue;
        }
        const record = JSON.parse(trimmed) as ModelRecord;
        const v = (record as Record<string, unknown>)[field];
        if (v === value) {
          return record;
        }
      }
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return undefined;
      }
      throw new FileIOError(`Failed to read records from "${modelName}"`, filePath, { cause: err });
    }

    return undefined;
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

  private sanitize(data: Record<string, unknown>, schema: ModelSchema): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      if (schema.fields.has(key)) {
        let value = data[key];
        const def = schema.fieldTypes.get(key);
        if (def) {
          validateFieldValue(key, value, def, this.locale);
          value = coerceI18NValue(value, def, this.locale);
        }
        clean[key] = value;
      }
    }
    return clean;
  }

  private filePath(modelName: string): string {
    return this.paths.modelDataPath(modelName);
  }

  private dirReady = false;

  private async ensureDir(): Promise<void> {
    if (this.dirReady) {
      return;
    }
    await mkdir(this.paths.modelsDir(), { recursive: true });
    this.dirReady = true;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
