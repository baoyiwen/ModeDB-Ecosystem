import type { ModelSchema, ModelRecord } from '../../common/types.js';
import type { DataReader } from '../../common/provider.js';
import type { PathResolver } from '../common/PathResolver.js';
import { ModelNotRegisteredError, FileIOError } from '../../common/errors.js';
import { AtlasSingleVault } from '../../authoring/atlas-single-vault.js';

const SCHEMA_HEADER_KEY = '__schema__';

/**
 * Read-only model access backed by an in-memory {@link AtlasSingleVault} (runtime `connect`).
 */
export class VaultModelFileReader implements DataReader {
  private readonly schemas = new Map<string, ModelSchema>();

  constructor(
    private readonly paths: PathResolver,
    private readonly vault: AtlasSingleVault,
  ) {}

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

  async getAll(modelName: string): Promise<ModelRecord[]> {
    this.resolveSchema(modelName);
    return this.parseModelBlob(modelName);
  }

  async scanModelRecords(
    modelName: string,
    visitor: (record: ModelRecord) => void | Promise<void>,
  ): Promise<void> {
    const rows = await this.getAll(modelName);
    for (const r of rows) {
      await visitor(r);
    }
  }

  async getByIds(modelName: string, ids: string[]): Promise<ModelRecord[]> {
    if (ids.length === 0) {
      return [];
    }
    const target = new Set(ids);
    const all = await this.getAll(modelName);
    return all.filter((r) => target.has(r._id));
  }

  async findFirstByFieldEq(
    modelName: string,
    field: string,
    value: unknown,
  ): Promise<ModelRecord | undefined> {
    const all = await this.getAll(modelName);
    for (const record of all) {
      const v = (record as Record<string, unknown>)[field];
      if (v === value) {
        return record;
      }
    }
    return undefined;
  }

  private parseModelBlob(modelName: string): ModelRecord[] {
    const raw = this.vault.get(AtlasSingleVault.modelKey(modelName)) ?? '';
    const results: ModelRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch (err) {
        throw new FileIOError(
          `Corrupt model blob in vault for "${modelName}"`,
          this.paths.atlasSingleVaultPath(),
          {
            cause: err,
          },
        );
      }
      if (SCHEMA_HEADER_KEY in obj) {
        continue;
      }
      results.push(obj as ModelRecord);
    }
    return results;
  }

  private resolveSchema(modelName: string): ModelSchema {
    const schema = this.schemas.get(modelName);
    if (!schema) {
      throw new ModelNotRegisteredError(modelName);
    }
    return schema;
  }
}
