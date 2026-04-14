import { mkdir, appendFile, rename, stat, unlink } from 'node:fs/promises';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic } from './diagnostic.js';

export type EngineLogLevel = 'INFO' | 'WARN' | 'ERROR';

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const ACTIVE_LOG = 'system.log';
const ACCESS_LOG = 'access.log';

function formatLocalTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatMetadata(detail: unknown): string {
  if (detail === undefined) {
    return '';
  }
  if (typeof detail === 'string') {
    return ` | ${detail}`;
  }
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const o = detail as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${k}: ${v}`);
      } else {
        parts.push(`${k}: ${JSON.stringify(v)}`);
      }
    }
    return parts.length ? ` | ${parts.join(' | ')}` : '';
  }
  return ` | ${JSON.stringify(detail)}`;
}

export interface EngineLoggerConfigureOptions {
  /**
   * Atlas directory: logs go to **`join(atlasRoot, 'logs')`** (authoring default).
   * Ignored when **`logDirectory`** is set.
   */
  readonly atlasRoot?: string;
  /**
   * Directory for **`system.log`** and **`access.log`** files directly (no extra **`/logs`** segment).
   */
  readonly logDirectory?: string;
  /** When true, append structured lines to **`access.log`** (QueryEngine / BinaryInterceptor / disk / HTTP). */
  readonly enableAccessLog?: boolean;
  readonly maxFileBytes?: number;
  readonly maxRotatedFiles?: number;
  readonly logEachDiskOp?: boolean;
  readonly logEachBinaryUnwrap?: boolean;
}

interface RunMetrics {
  diskReadCount: number;
  diskReadMs: number;
  diskWriteCount: number;
  diskWriteMs: number;
  binaryInterceptorCount: number;
  binaryInterceptorMs: number;
  handledRequestCount: number;
  handledRequestMs: number;
}

let processExitHooked = false;

/**
 * Rolling **`system.log`** under **`logDirectory`** or **`&lt;atlasRoot&gt;/logs`**;
 * optional **`access.log`** for request / query / transport profiling.
 */
export class EngineLogger {
  private static _instance: EngineLogger | undefined;

  static get instance(): EngineLogger {
    if (!EngineLogger._instance) {
      EngineLogger._instance = new EngineLogger();
    }
    return EngineLogger._instance;
  }

  private logDir: string | undefined;
  private maxBytes = DEFAULT_MAX_BYTES;
  private maxRotatedFiles = 10;
  private logEachDiskOp = false;
  private logEachBinaryUnwrap = false;
  private enableAccessLog = false;
  private chain: Promise<void> = Promise.resolve();
  private accessChain: Promise<void> = Promise.resolve();
  private diagUnsub: (() => void) | undefined;
  private runSummaryWritten = false;
  private readonly metrics: RunMetrics = {
    diskReadCount: 0,
    diskReadMs: 0,
    diskWriteCount: 0,
    diskWriteMs: 0,
    binaryInterceptorCount: 0,
    binaryInterceptorMs: 0,
    handledRequestCount: 0,
    handledRequestMs: 0,
  };

  /** True when **`access.log`** profiling is enabled (see **`configure`**). */
  isAccessLogEnabled(): boolean {
    return this.enableAccessLog && Boolean(this.logDir);
  }

  /**
   * Prepare log directory. Pass **`logDirectory`** (server) **or** **`atlasRoot`** (authoring **`…/logs`**).
   */
  configure(opts: EngineLoggerConfigureOptions): void {
    if (opts.logDirectory) {
      this.logDir = opts.logDirectory;
    } else if (opts.atlasRoot) {
      this.logDir = join(opts.atlasRoot, 'logs');
    } else {
      throw new Error('EngineLogger.configure: provide logDirectory and/or atlasRoot.');
    }
    mkdirSync(this.logDir, { recursive: true });
    this.maxBytes =
      opts.maxFileBytes !== undefined && opts.maxFileBytes > 1024
        ? opts.maxFileBytes
        : DEFAULT_MAX_BYTES;
    if (opts.maxRotatedFiles !== undefined && opts.maxRotatedFiles >= 1) {
      this.maxRotatedFiles = Math.min(opts.maxRotatedFiles, 50);
    }
    this.logEachDiskOp = Boolean(opts.logEachDiskOp);
    this.logEachBinaryUnwrap = Boolean(opts.logEachBinaryUnwrap);
    this.enableAccessLog = Boolean(opts.enableAccessLog);
    if (!processExitHooked) {
      processExitHooked = true;
      process.on('exit', () => {
        EngineLogger.instance.writeRunSummarySync();
      });
    }
  }

  attachDiagnosticBridge(subscribe: (fn: (d: Diagnostic) => void) => () => void): void {
    if (this.diagUnsub) {
      return;
    }
    this.diagUnsub = subscribe((d: Diagnostic) => {
      const level: EngineLogLevel =
        d.severity === 'FATAL' ? 'ERROR' : d.severity === 'WARN' ? 'WARN' : 'ERROR';
      const meta = { code: d.code, severity: d.severity, ts: d.timestamp };
      const line = this.formatLine(level, 'DiagnosticCenter', d.message, meta);
      void this.enqueue(() => this.appendRaw(line));
    });
  }

  detachDiagnosticBridge(): void {
    this.diagUnsub?.();
    this.diagUnsub = undefined;
  }

  info(message: string, detail?: unknown, module = 'Engine'): void {
    const line = this.formatLine('INFO', module, message, detail);
    void this.enqueue(() => this.appendRaw(line));
  }

  warn(message: string, detail?: unknown, module = 'Engine'): void {
    const line = this.formatLine('WARN', module, message, detail);
    void this.enqueue(() => this.appendRaw(line));
  }

  error(message: string, detail?: unknown, module = 'Engine'): void {
    const line = this.formatLine('ERROR', module, message, detail);
    void this.enqueue(() => this.appendRaw(line));
  }

  /** Structured **`access.log`** line (same bracket format as system log). */
  accessInfo(message: string, detail?: unknown, module = 'Access'): void {
    if (!this.enableAccessLog || !this.logDir) {
      return;
    }
    const line = this.formatLine('INFO', module, message, detail);
    void this.enqueueAccess(() => this.appendAccessRaw(line));
  }

  accessQueryEngineTask(ms: number, model: string, extra?: Record<string, unknown>): void {
    this.accessInfo(
      `Task Executed: ${ms.toFixed(2)}ms`,
      { model, cache: extra?.cache ?? 'n/a', ...extra },
      'QueryEngine',
    );
  }

  accessBinaryDecode(ms: number, bytesIn: number): void {
    this.accessInfo(`Decode: ${ms.toFixed(3)}ms`, { bytesIn }, 'BinaryInterceptor');
  }

  accessWriteGateExclusive(ms: number, queueLength: number, atlas: string): void {
    this.accessInfo(`Write block: ${ms.toFixed(2)}ms`, { queueLength, atlas }, 'DiskAdapter');
  }

  recordDiskRead(ms: number, bytes?: number, context = 'read'): void {
    this.metrics.diskReadCount += 1;
    this.metrics.diskReadMs += ms;
    if (this.logEachDiskOp && this.logDir) {
      const meta: Record<string, unknown> = { ms: Number(ms.toFixed(3)), kind: context };
      if (bytes !== undefined) {
        meta.bytes = bytes;
      }
      this.info(`Disk read completed`, meta, 'DiskAdapter');
    }
  }

  recordDiskWrite(ms: number, bytes?: number, context = 'write'): void {
    this.metrics.diskWriteCount += 1;
    this.metrics.diskWriteMs += ms;
    if (this.logEachDiskOp && this.logDir) {
      const meta: Record<string, unknown> = { ms: Number(ms.toFixed(3)), kind: context };
      if (bytes !== undefined) {
        meta.bytes = bytes;
      }
      this.info(`Disk write completed`, meta, 'DiskAdapter');
    }
  }

  recordBinaryInterceptor(ms: number, bytesIn?: number): void {
    this.metrics.binaryInterceptorCount += 1;
    this.metrics.binaryInterceptorMs += ms;
    if (this.logEachBinaryUnwrap && this.logDir) {
      const meta: Record<string, unknown> = { ms: Number(ms.toFixed(3)) };
      if (bytesIn !== undefined) {
        meta.bytesIn = bytesIn;
      }
      this.info(`Binary transport unwrap`, meta, 'BinaryInterceptor');
    }
    if (this.enableAccessLog && this.logDir) {
      this.accessBinaryDecode(ms, bytesIn ?? 0);
    }
  }

  recordHandledRequest(ms: number): void {
    this.metrics.handledRequestCount += 1;
    this.metrics.handledRequestMs += ms;
  }

  writeRunSummarySync(): void {
    if (this.runSummaryWritten || !this.logDir) {
      return;
    }
    this.runSummaryWritten = true;
    const m = this.metrics;
    const avgReq = m.handledRequestCount > 0 ? m.handledRequestMs / m.handledRequestCount : 0;
    const avgRead = m.diskReadCount > 0 ? m.diskReadMs / m.diskReadCount : 0;
    const avgWrite = m.diskWriteCount > 0 ? m.diskWriteMs / m.diskWriteCount : 0;
    const avgBin =
      m.binaryInterceptorCount > 0 ? m.binaryInterceptorMs / m.binaryInterceptorCount : 0;
    const line = this.formatLine('INFO', 'EngineLogger', 'Run summary (process exit)', {
      requests: m.handledRequestCount,
      avgRequestMs: Number(avgReq.toFixed(3)),
      diskReads: m.diskReadCount,
      avgDiskReadMs: Number(avgRead.toFixed(3)),
      diskWrites: m.diskWriteCount,
      avgDiskWriteMs: Number(avgWrite.toFixed(3)),
      binaryUnwraps: m.binaryInterceptorCount,
      avgBinaryUnwrapMs: Number(avgBin.toFixed(3)),
    });
    try {
      mkdirSync(this.logDir, { recursive: true });
      appendFileSync(join(this.logDir, ACTIVE_LOG), line, 'utf-8');
    } catch {
      /* ignore */
    }
    this.resetMetrics();
  }

  private resetMetrics(): void {
    this.metrics.diskReadCount = 0;
    this.metrics.diskReadMs = 0;
    this.metrics.diskWriteCount = 0;
    this.metrics.diskWriteMs = 0;
    this.metrics.binaryInterceptorCount = 0;
    this.metrics.binaryInterceptorMs = 0;
    this.metrics.handledRequestCount = 0;
    this.metrics.handledRequestMs = 0;
  }

  private formatLine(
    level: EngineLogLevel,
    module: string,
    message: string,
    detail?: unknown,
  ): string {
    const ts = formatLocalTimestamp(new Date());
    const meta = formatMetadata(detail);
    return `[${ts}] [${level}] [${module}] ${message}${meta}\n`;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task).catch(() => {
      /* never break the chain */
    });
    return this.chain;
  }

  private enqueueAccess(task: () => Promise<void>): Promise<void> {
    this.accessChain = this.accessChain.then(task).catch(() => {
      /* never break the chain */
    });
    return this.accessChain;
  }

  private activeLogPath(): string {
    if (!this.logDir) {
      throw new Error('EngineLogger.configure(...) must be called before logging.');
    }
    return join(this.logDir, ACTIVE_LOG);
  }

  private rotatedPath(i: number): string {
    if (!this.logDir) {
      throw new Error('EngineLogger not configured.');
    }
    return join(this.logDir, `system.${i}.log`);
  }

  private async rotateIfNeeded(lineByteLength: number): Promise<void> {
    if (!this.logDir) {
      return;
    }
    const path = this.activeLogPath();
    try {
      const st = await stat(path);
      if (st.size + lineByteLength <= this.maxBytes) {
        return;
      }
    } catch {
      return;
    }

    const n = this.maxRotatedFiles;
    await unlink(this.rotatedPath(n)).catch(() => {});
    for (let i = n - 1; i >= 1; i--) {
      const from = this.rotatedPath(i);
      const to = this.rotatedPath(i + 1);
      try {
        await rename(from, to);
      } catch {
        /* ignore missing */
      }
    }
    try {
      await rename(path, this.rotatedPath(1));
    } catch {
      /* ignore */
    }
  }

  private async appendRaw(line: string): Promise<void> {
    if (!this.logDir) {
      return;
    }
    await mkdir(this.logDir, { recursive: true });
    await this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
    const path = this.activeLogPath();
    await appendFile(path, line, 'utf-8');
  }

  private async appendAccessRaw(line: string): Promise<void> {
    if (!this.logDir) {
      return;
    }
    await mkdir(this.logDir, { recursive: true });
    await appendFile(join(this.logDir, ACCESS_LOG), line, 'utf-8');
  }
}
