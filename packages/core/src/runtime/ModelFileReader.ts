import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ModelSchema, ModelRecord, DataReader, PathResolver } from '@mode-db/common';
import { ModelNotRegisteredError, FileIOError, parseMldLine } from '@mode-db/common';

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

    return results;
  }

  async scanModelRecords(
    modelName: string,
    visitor: (record: ModelRecord) => void | Promise<void>,
  ): Promise<void> {
    this.resolveSchema(modelName);
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
        await visitor(parsed.record);
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
      throw new FileIOError(`Failed to read records from "${modelName}"`, filePath, { cause: err });
    }

    return undefined;
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
