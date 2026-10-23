import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type {
  ModelSchema,
  ModelRecord,
  DataReader,
  PathResolver,
  Diagnostic,
  VaultKeyMaterial,
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
  EngineLogger,
  isDeletedRecord,
} from '@mode-db/common';
import type { FieldMatchContext } from '../src/runtime/query-filter.js';
import { AtlasSingleVault } from './atlas-single-vault.js';

const SCHEMA_HEADER_KEY = '__schema__';

function compactModelRecords(records: readonly ModelRecord[]): ModelRecord[] {
  const byId = new Map<string, ModelRecord>();
  const order: string[] = [];
  for (const record of records) {
    if (!byId.has(record._id)) {
      order.push(record._id);
    }
    byId.set(record._id, record);
  }
  return order.map((id) => byId.get(id)!).filter((record) => !isDeletedRecord(record));
}

export interface ModelStorageVaultOptions {
  readonly vault: AtlasSingleVault;
  readonly vaultKey: VaultKeyMaterial;
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
   * (no plaintext JSON). Reads accept both plaintext JSON lines and obfuscated lines.
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
        this.vaultOptions.vaultKey,
      );
    }
  }

  private modelVaultKey(modelName: string): string {
    return AtlasSingleVault.modelKey(modelName);
  }

  /**
   * After **`alterModel`** adds optional fields, persisted rows may omit those keys. Merge missing
   * keys from the **current** in-memory schema so reads stay compatible (defaults applied when set).
   */
  private materializeRowForCurrentSchema(modelName: string, row: ModelRecord): ModelRecord {
    const schema = this.schemas.get(modelName);
    if (!schema) {
      return row;
    }
    const out = { ...(row as Record<string, unknown>) };
    for (const field of schema.fields) {
      if (Object.prototype.hasOwnProperty.call(out, field)) {
        continue;
      }
      const def = schema.fieldTypes.get(field);
      if (!def) {
        continue;
      }
      if (def.default !== undefined) {
        out[field] =
          typeof def.default === 'function' ? (def.default as () => unknown)() : def.default;
      } else if (!def.required) {
        out[field] = undefined;
      }
    }
    return out as ModelRecord;
  }

  private parseVaultModelLines(modelName: string): ModelRecord[] {
    const t0 = performance.now();
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
      results.push(this.materializeRowForCurrentSchema(modelName, obj as ModelRecord));
    }
    EngineLogger.instance.recordSeekScan(performance.now() - t0, `vault:${modelName}`, {
      blobChars: raw.length,
    });
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

  /**
   * Physically delete the model's persisted payload.
   *
   * - **Vault mode**: removes the `m:<name>` entry from {@link AtlasSingleVault} and
   *   `saveSync`s the vault so the atlas file on disk no longer contains the blob.
   * - **Split-file mode**: `unlink`s `<STORAGE_ROOT>/<atlas>/models/<name>.mld`.
   *
   * A missing target file is treated as a no-op (idempotent). Any other I/O failure is
   * wrapped in {@link FileIOError}. Call {@link unregisterSchema} separately to also
   * clear the in-memory schema.
   */
  async deleteModelData(modelName: string): Promise<void> {
    if (this.vault) {
      this.vault.delete(this.modelVaultKey(modelName));
      this.persistVaultSync();
      return;
    }
    const filePath = this.paths.modelDataPath(modelName);
    try {
      await unlink(filePath);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return;
      }
      throw new FileIOError(`Failed to delete "${modelName}" data file`, filePath, { cause: err });
    }
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
        return compactModelRecords(this.parseVaultModelLines(modelName));
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
      const seekT0 = performance.now();
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
          results.push(this.materializeRowForCurrentSchema(modelName, parsed.record));
        }
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          EngineLogger.instance.recordSeekScan(
            performance.now() - seekT0,
            `splitfile:${modelName}`,
            {
              op: 'getAll',
            },
          );
          return [];
        }
        throw new FileIOError(`Failed to read records from "${modelName}"`, filePath, {
          cause: err,
        });
      }

      EngineLogger.instance.recordSeekScan(performance.now() - seekT0, `splitfile:${modelName}`, {
        op: 'getAll',
        rows: results.length,
      });
      return compactModelRecords(results);
    });
  }

  async scanModelRecords(
    modelName: string,
    visitor: (record: ModelRecord) => void | Promise<void>,
  ): Promise<void> {
    this.resolveSchema(modelName);
    if (this.vault) {
      const rows = compactModelRecords(this.parseVaultModelLines(modelName));
      for (const r of rows) {
        await visitor(r);
      }
      return;
    }

    const filePath = this.filePath(modelName);
    await DiskAdapter.timedStreamRead(`ModelStorage.scanModelRecords:${modelName}`, async () => {
      const seekT0 = performance.now();
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
          results.push(this.materializeRowForCurrentSchema(modelName, parsed.record));
        }
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          EngineLogger.instance.recordSeekScan(
            performance.now() - seekT0,
            `splitfile:${modelName}`,
            {
              op: 'scanModelRecords',
            },
          );
          return;
        }
        throw new FileIOError(`Failed to scan records from "${modelName}"`, filePath, {
          cause: err,
        });
      }
      for (const record of compactModelRecords(results)) {
        await visitor(record);
      }
      EngineLogger.instance.recordSeekScan(performance.now() - seekT0, `splitfile:${modelName}`, {
        op: 'scanModelRecords',
      });
    });
  }

  async getByIds(modelName: string, ids: string[]): Promise<ModelRecord[]> {
    this.resolveSchema(modelName);

    if (ids.length === 0) {
      return [];
    }

    if (this.vault) {
      const target = new Set(ids);
      return compactModelRecords(this.parseVaultModelLines(modelName)).filter((r) =>
        target.has(r._id),
      );
    }

    const byId = new Map((await this.getAll(modelName)).map((record) => [record._id, record]));
    return ids
      .map((id) => byId.get(id))
      .filter((record): record is ModelRecord => record !== undefined);
  }

  async findFirstByFieldEq(
    modelName: string,
    field: string,
    value: unknown,
  ): Promise<ModelRecord | undefined> {
    this.resolveSchema(modelName);
    if (this.vault) {
      for (const record of compactModelRecords(this.parseVaultModelLines(modelName))) {
        const v = (record as Record<string, unknown>)[field];
        if (v === value) {
          return record;
        }
      }
      return undefined;
    }

    return (await this.getAll(modelName)).find(
      (record) => (record as Record<string, unknown>)[field] === value,
    );
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

  /** Resolve the per-model `.mld` path in split-file layout; vault mode returns the atlas vault path. */
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
