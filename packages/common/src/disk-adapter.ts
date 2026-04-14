import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { EngineLogger } from './engine-logger.js';

/**
 * Centralized timed disk I/O for optimization telemetry ({@link EngineLogger} aggregates).
 */
export const DiskAdapter = {
  async read(path: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    const t0 = performance.now();
    const data = (await readFile(path, encoding)) as string;
    const ms = performance.now() - t0;
    const bytes = Buffer.byteLength(data, 'utf8');
    EngineLogger.instance.recordDiskRead(ms, bytes, 'read');
    return data;
  },

  async writeFile(
    path: string,
    data: string | Uint8Array,
    encoding: BufferEncoding = 'utf-8',
  ): Promise<void> {
    const t0 = performance.now();
    await writeFile(path, data, encoding);
    const ms = performance.now() - t0;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, encoding) : data.byteLength;
    EngineLogger.instance.recordDiskWrite(ms, bytes, 'writeFile');
  },

  async appendFile(
    path: string,
    data: string | Uint8Array,
    encoding: BufferEncoding = 'utf-8',
  ): Promise<void> {
    const t0 = performance.now();
    await appendFile(path, data, encoding);
    const ms = performance.now() - t0;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, encoding) : data.byteLength;
    EngineLogger.instance.recordDiskWrite(ms, bytes, 'appendFile');
  },

  readFileSync(path: string): Buffer {
    const t0 = performance.now();
    const buf = readFileSync(path);
    const ms = performance.now() - t0;
    EngineLogger.instance.recordDiskRead(ms, buf.length, 'readFileSync');
    return buf;
  },

  writeFileSync(path: string, data: Buffer | string): void {
    const t0 = performance.now();
    writeFileSync(path, data);
    const ms = performance.now() - t0;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
    EngineLogger.instance.recordDiskWrite(ms, bytes, 'writeFileSync');
  },

  /** Time a streaming read path (e.g. `.mld` line scan) as one disk-read sample. */
  async timedStreamRead<T>(context: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      EngineLogger.instance.recordDiskRead(performance.now() - t0, undefined, context);
    }
  },
};
