import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ModelSchema, ModelRecord, DataReader, PathResolver } from '@mode-db/common';
import {
  ModelNotRegisteredError,
  FileIOError,
  isDeletedRecord,
  parseMldLine,
} from '@mode-db/common';

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

/**
 * Read-only `.mld` access for the client runtime (no writes, no mkdir).
 */
export class ModelFileReader implements DataReader {
  private readonly schemas = new Map<string, ModelSchema>();

  constructor(private readonly paths: PathResolver) {}

  registerSchema(schema: ModelSchema): void {
    if (this.schemas.has(schema.name)) {
      return;
    }
    this.schemas.set(schema.name, schema);
  }

  async getAll(modelName: string): Promise<ModelRecord[]> {
    this.resolveSchema(modelName);
    const results: ModelRecord[] = [];
    const filePath = this.paths.modelDataPath(modelName);

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
      throw new FileIOError(`Failed to read records from "${modelName}"`, filePath, { cause: err });
    }

    return compactModelRecords(results);
  }

  async scanModelRecords(
    modelName: string,
    visitor: (record: ModelRecord) => void | Promise<void>,
  ): Promise<void> {
    this.resolveSchema(modelName);
    const rows = await this.getAll(modelName);
    for (const row of rows) {
      await visitor(row);
    }
  }

  async getByIds(modelName: string, ids: string[]): Promise<ModelRecord[]> {
    this.resolveSchema(modelName);

    if (ids.length === 0) {
      return [];
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
    return (await this.getAll(modelName)).find(
      (record) => (record as Record<string, unknown>)[field] === value,
    );
  }

  private resolveSchema(modelName: string): ModelSchema {
    const schema = this.schemas.get(modelName);
    if (!schema) {
      throw new ModelNotRegisteredError(modelName);
    }
    return schema;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
