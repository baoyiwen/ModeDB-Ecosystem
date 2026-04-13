import { mkdir, appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from './diagnostic.js';

export type EngineLogLevel = 'INFO' | 'WARN' | 'ERROR';

/**
 * Process-wide rolling file logger under an atlas directory (`<atlas>/logs/engine.log`).
 * Optional bridge from {@link DiagnosticCenter} attaches here.
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
  private maxBytes = 5_000_000;
  private chain: Promise<void> = Promise.resolve();
  private diagUnsub: (() => void) | undefined;

  /**
   * Prepare log directory. Safe to call multiple times (last wins for active directory).
   */
  configure(opts: { atlasRoot: string; maxFileBytes?: number }): void {
    this.logDir = join(opts.atlasRoot, 'logs');
    if (opts.maxFileBytes !== undefined && opts.maxFileBytes > 1024) {
      this.maxBytes = opts.maxFileBytes;
    }
  }

  /** Subscribe to {@link DiagnosticCenter.onDiagnostic} once and write ERROR/FATAL/WARN lines. */
  attachDiagnosticBridge(subscribe: (fn: (d: Diagnostic) => void) => () => void): void {
    if (this.diagUnsub) {
      return;
    }
    this.diagUnsub = subscribe((d: Diagnostic) => {
      const level: EngineLogLevel =
        d.severity === 'FATAL' ? 'ERROR' : d.severity === 'WARN' ? 'WARN' : 'ERROR';
      const line = `[${level}] [${d.code}] ${new Date(d.timestamp).toISOString()} ${d.message}\n`;
      void this.enqueue(() => this.appendRaw(line));
    });
  }

  detachDiagnosticBridge(): void {
    this.diagUnsub?.();
    this.diagUnsub = undefined;
  }

  info(message: string, detail?: unknown): void {
    const line = this.formatLine('INFO', message, detail);
    void this.enqueue(() => this.appendRaw(line));
  }

  warn(message: string, detail?: unknown): void {
    const line = this.formatLine('WARN', message, detail);
    void this.enqueue(() => this.appendRaw(line));
  }

  error(message: string, detail?: unknown): void {
    const line = this.formatLine('ERROR', message, detail);
    void this.enqueue(() => this.appendRaw(line));
  }

  private formatLine(level: EngineLogLevel, message: string, detail?: unknown): string {
    const ts = new Date().toISOString();
    const extra =
      detail !== undefined
        ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
        : '';
    return `[${ts}] [${level}] ${message}${extra}\n`;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(task).catch(() => {
      /* never break the chain */
    });
    return this.chain;
  }

  private logFilePath(): string {
    if (!this.logDir) {
      throw new Error('EngineLogger.configure({ atlasRoot }) must be called before logging.');
    }
    return join(this.logDir, 'engine.log');
  }

  private async appendRaw(line: string): Promise<void> {
    if (!this.logDir) {
      return;
    }
    await mkdir(this.logDir, { recursive: true });
    const path = this.logFilePath();
    try {
      const st = await stat(path);
      if (st.size + line.length > this.maxBytes) {
        const rotated = join(this.logDir, 'engine.log.1');
        try {
          await rename(path, rotated);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* no file yet */
    }
    await appendFile(path, line, 'utf-8');
  }
}
