import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type {
  ModelSchema,
  ModelRecord,
  DataReader,
  PathResolver,
  Diagnostic,
} from '@mode-db/common';
import {
  ModelNotRegisteredError,
  FileIOError,
  validateFieldValue,
  coerceI18NValue,
  type FieldTypeDef,
  encodeMldLine,
  parseMldLine,
  DiskAdapter,
} from '@mode-db/common';
import type { FieldMatchContext } from '../src/runtime/query-filter.js';
import { AtlasSingleVault } from './atlas-single-vault.js';

const SCHEMA_HEADER_KEY = '__schema__';

export interface ModelStorageVaultOptions {
  readonly vault: AtlasSingleVault;
  readonly vaultSecret: string;
}

function buildSchemaHeaderLine(schema: ModelSchema): string {
  const ft: Record<string, { type: string; required?: boolean; unit?: string; default?: unknown }> =
    {};
  for (const [k, v] of schema.fieldTypes) {
    const entry: { type: string; required?: boolean; unit?: string; default?: unknown } = {
      type: v.type,
    };
    if (v.required) {
      entry.required = v.required;
    }
    if (v.unit) {
      entry.unit = v.unit;
    }
    if (v.default !== undefined) {
      entry.default = v.default;
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
  /**
   * When true, `.mld` data and schema header lines are written with {@link encodeMldLine}
   * (no plaintext JSON). Reads accept both legacy plain lines and obfuscated lines.
   */
  shadowDiskEncoding = false;

  private readonly vaultOptions?: ModelStorageVaultOptions;

  constructor(
    private readonly paths: PathResolver,
    vaultOptions?: ModelStorageVaultOptions,
  ) {
    this.vaultOptions = vaultOptions;
  }

  private get vault(): AtlasSingleVault | undefined {
    return this.vaultOptions?.vault;
  }

  private persistVaultSync(): void {
    if (this.vaultOptions) {
      this.vaultOptions.vault.saveSync(
        this.paths.atlasSingleVaultPath(),
        this.vaultOptions.vaultSecret,
      );
    }
  }

  private modelVaultKey(modelName: string): string {
    return AtlasSingleVault.modelKey(modelName);
  }

  private parseVaultModelLines(modelName: string): ModelRecord[] {
    const raw = this.vault!.get(this.modelVaultKey(modelName)) ?? '';
    const results: ModelRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (SCHEMA_HEADER_KEY in obj) {
        continue;
      }
      results.push(obj as ModelRecord);
    }
    return results;
  }

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

  /** Remove in-memory schema (e.g. after {@link AuthoringEngine.dropModel}). */
  unregisterSchema(modelName: string): void {
    this.schemas.delete(modelName);
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
   *
   * When `diagnostics` is provided, validation errors are collected instead of thrown.
   */
  prepareInsert(
    modelName: string,
    data: Record<string, unknown>,
    diagnostics?: Diagnostic[],
  ): ModelRecord {
    const schema = this.resolveSchema(modelName);
    const clean = this.sanitize(data, schema, diagnostics);
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
    if (this.vault) {
      const key = this.modelVaultKey(modelName);
      let body = this.vault.get(key) ?? '';
      const isNew = body.trim().length === 0;
      if (isNew) {
        body = buildSchemaHeaderLine(schema) + '\n';
      }
      for (const r of records) {
        body += JSON.stringify(r) + '\n';
      }
      this.vault.set(key, body);
      this.persistVaultSync();
      return;
    }

    const filePath = this.filePath(modelName);
    await this.ensureDir();

    const isNew = !existsSync(filePath) || statSync(filePath).size === 0;
    let body = '';
    if (isNew) {
      const headerObj = JSON.parse(buildSchemaHeaderLine(schema)) as Record<string, unknown>;
      body += encodeMldLine(headerObj, this.shadowDiskEncoding) + '\n';
    }
    for (const r of records) {
      body += encodeMldLine(r, this.shadowDiskEncoding) + '\n';
    }
    try {
      await DiskAdapter.appendFile(filePath, body, 'utf-8');
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
    if (this.vault) {
      const headerObj = JSON.parse(buildSchemaHeaderLine(schema)) as Record<string, unknown>;
      let body = JSON.stringify(headerObj) + '\n';
      for (const r of records) {
        body += JSON.stringify(r) + '\n';
      }
      this.vault.set(this.modelVaultKey(modelName), body);
      this.persistVaultSync();
      return;
    }

    const filePath = this.filePath(modelName);
    await this.ensureDir();
    const headerObj = JSON.parse(buildSchemaHeaderLine(schema)) as Record<string, unknown>;
    let body = encodeMldLine(headerObj, this.shadowDiskEncoding) + '\n';
    for (const r of records) {
      body += encodeMldLine(r, this.shadowDiskEncoding) + '\n';
    }
    try {
      await DiskAdapter.writeFile(filePath, body, 'utf-8');
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
    if (this.vault) {
      try {
        return this.parseVaultModelLines(modelName);
      } catch (err) {
        throw new FileIOError(
          `Failed to read vault model "${modelName}"`,
          this.paths.atlasSingleVaultPath(),
          {
            cause: err,
          },
        );
      }
    }

    const filePath = this.filePath(modelName);
    return DiskAdapter.timedStreamRead(`ModelStorage.getAll:${modelName}`, async () => {
      const results: ModelRecord[] = [];
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
          const parsed = parseMldLine(trimmed);
          if (!parsed || parsed.kind === 'header') {
            continue;
          }
          results.push(parsed.record);
        }
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          return [];
        }
        throw new FileIOError(`Failed to read records from "${modelName}"`, filePath, {
          cause: err,
        });
      }

      return results;
    });
  }

  async scanModelRecords(
    modelName: string,
    visitor: (record: ModelRecord) => void | Promise<void>,
  ): Promise<void> {
    this.resolveSchema(modelName);
    if (this.vault) {
      const rows = this.parseVaultModelLines(modelName);
      for (const r of rows) {
        await visitor(r);
      }
      return;
    }

    const filePath = this.filePath(modelName);
    await DiskAdapter.timedStreamRead(`ModelStorage.scanModelRecords:${modelName}`, async () => {
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
          const parsed = parseMldLine(trimmed);
          if (!parsed || parsed.kind === 'header') {
            continue;
          }
          await visitor(parsed.record);
        }
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          return;
        }
        throw new FileIOError(`Failed to scan records from "${modelName}"`, filePath, {
          cause: err,
        });
      }
    });
  }

  async getByIds(modelName: string, ids: string[]): Promise<ModelRecord[]> {
    this.resolveSchema(modelName);

    if (ids.length === 0) {
      return [];
    }

    if (this.vault) {
      const target = new Set(ids);
      return this.parseVaultModelLines(modelName).filter((r) => target.has(r._id));
    }

    const target = new Set(ids);
    const filePath = this.filePath(modelName);
    return DiskAdapter.timedStreamRead(`ModelStorage.getByIds:${modelName}`, async () => {
      const results: ModelRecord[] = [];
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
          const parsed = parseMldLine(trimmed);
          if (!parsed || parsed.kind === 'header') {
            continue;
          }

          const record = parsed.record;
          if (target.has(record._id)) {
            results.push(record);
            target.delete(record._id);
          }
        }
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          return [];
        }
        throw new FileIOError(`Failed to read records from "${modelName}"`, filePath, {
          cause: err,
        });
      }

      return results;
    });
  }

  async findFirstByFieldEq(
    modelName: string,
    field: string,
    value: unknown,
  ): Promise<ModelRecord | undefined> {
    this.resolveSchema(modelName);
    if (this.vault) {
      for (const record of this.parseVaultModelLines(modelName)) {
        const v = (record as Record<string, unknown>)[field];
        if (v === value) {
          return record;
        }
      }
      return undefined;
    }

    const filePath = this.filePath(modelName);
    return DiskAdapter.timedStreamRead(`ModelStorage.findFirstByFieldEq:${modelName}`, async () => {
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
          const parsed = parseMldLine(trimmed);
          if (!parsed || parsed.kind === 'header') {
            continue;
          }
          const record = parsed.record;
          const v = (record as Record<string, unknown>)[field];
          if (v === value) {
            return record;
          }
        }
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          return undefined;
        }
        throw new FileIOError(`Failed to read records from "${modelName}"`, filePath, {
          cause: err,
        });
      }

      return undefined;
    });
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

  private sanitize(
    data: Record<string, unknown>,
    schema: ModelSchema,
    diagnostics?: Diagnostic[],
  ): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    const valOpts = diagnostics
      ? { locale: this.locale, diagnostics, model: schema.name }
      : this.locale;
    for (const key of Object.keys(data)) {
      if (schema.fields.has(key)) {
        let value = data[key];
        const def = schema.fieldTypes.get(key);
        if (def) {
          if ((value === undefined || value === null) && def.default !== undefined) {
            value =
              typeof def.default === 'function' ? (def.default as () => unknown)() : def.default;
          }
          validateFieldValue(key, value, def, valOpts);
          value = coerceI18NValue(value, def, this.locale);
        }
        clean[key] = value;
      }
    }
    for (const [key, def] of schema.fieldTypes) {
      if (!(key in clean) && def.default !== undefined) {
        let value: unknown =
          typeof def.default === 'function' ? (def.default as () => unknown)() : def.default;
        validateFieldValue(key, value, def, valOpts);
        value = coerceI18NValue(value, def, this.locale);
        clean[key] = value;
      } else if (!(key in clean) && def.required) {
        validateFieldValue(key, undefined, def, valOpts);
      }
    }
    return clean;
  }

  /** Resolve the `.mld` file path for a model (legacy); vault mode returns the atlas vault path. */
  filePath(modelName: string): string {
    if (this.vault) {
      return this.paths.atlasSingleVaultPath();
    }
    return this.paths.modelDataPath(modelName);
  }

  private dirReady = false;

  private async ensureDir(): Promise<void> {
    if (this.vault) {
      return;
    }
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
