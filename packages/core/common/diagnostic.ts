import { ValidationError, FileIOError, EngineError } from './errors.js';

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export type Severity = 'FATAL' | 'ERROR' | 'WARN';

// ---------------------------------------------------------------------------
// Error codes — named aliases + numeric identifiers
// ---------------------------------------------------------------------------

export type DiagnosticCode =
  | 'E1001'
  | 'E1002'
  | 'E1003'
  | 'E1004'
  | 'E1005'
  | 'E1006'
  | 'E1007'
  | 'E1008'
  | 'E1009'
  | 'E1010'
  | 'E1011'
  | 'E2005'
  | 'E3001'
  | 'E3002';

/**
 * Named aliases for the numeric codes — use these in application code
 * for readability: `ErrorCodes.SCHEMA_REQUIRED` instead of `'E1001'`.
 */
export const ErrorCodes = {
  SCHEMA_REQUIRED: 'E1001' as DiagnosticCode,
  SCHEMA_REQUIRED_EMPTY: 'E1002' as DiagnosticCode,
  TYPE_MISMATCH: 'E1003' as DiagnosticCode,
  UNKNOWN_TYPE: 'E1004' as DiagnosticCode,
  I18N_MISSING_LOCALE: 'E1005' as DiagnosticCode,
  COLOR_AUTO_COERCED: 'E1006' as DiagnosticCode,
  VO_NO_SYNC: 'E1007' as DiagnosticCode,
  IO_PERSISTENCE_FAIL: 'E1008' as DiagnosticCode,
  MODEL_NOT_REGISTERED: 'E1009' as DiagnosticCode,
  BATCH_ROW_FAIL: 'E1010' as DiagnosticCode,
  DEFAULT_INJECTED: 'E1011' as DiagnosticCode,
  SELF_REFERENTIAL_CYCLE: 'E2005' as DiagnosticCode,
  VALUE_RANGE_OVERFLOW: 'E3001' as DiagnosticCode,
  PHYSICAL_ADDRESS_CORRUPT: 'E3002' as DiagnosticCode,
} as const;

export interface CodeEntry {
  readonly severity: Severity;
  readonly en: string;
  readonly zh: string;
}

const CODE_REGISTRY: Record<DiagnosticCode, CodeEntry> = {
  E1001: {
    severity: 'ERROR',
    en: 'Field "{field}" is required but received {received}.',
    zh: '字段 "{field}" 为必填项，但收到了 {received}。',
  },
  E1002: {
    severity: 'ERROR',
    en: 'Field "{field}" is required but received an empty {type} value.',
    zh: '字段 "{field}" 为必填项，但收到了空的 {type} 值。',
  },
  E1003: {
    severity: 'ERROR',
    en: 'Field "{field}" expects {type} but received {received}.',
    zh: '字段 "{field}" 期望类型 {type}，但收到了 {received}。',
  },
  E1004: {
    severity: 'ERROR',
    en: 'Unknown DataType "{type}".',
    zh: '未知数据类型 "{type}"。',
  },
  E1005: {
    severity: 'ERROR',
    en: 'I18N field "{field}": pass an object like {{ zh: "..." }} or set currentLocale for auto-wrap.',
    zh: 'I18N 字段 "{field}"：请传入对象如 {{ zh: "..." }}，或设置 currentLocale 以自动包装。',
  },
  E1006: {
    severity: 'WARN',
    en: 'Color field "{field}" received non-standard format; auto-coerced to RGBA.',
    zh: '颜色字段 "{field}" 收到非标准格式，已自动修正为 RGBA。',
  },
  E1007: {
    severity: 'ERROR',
    en: 'ValueObject "{field}" has no sync callback — save() requires an authoring context.',
    zh: 'ValueObject "{field}" 没有同步回调 — save() 需要写入上下文。',
  },
  E1008: {
    severity: 'FATAL',
    en: 'Failed to write to disk: {detail}.',
    zh: '磁盘写入失败：{detail}。',
  },
  E1009: {
    severity: 'ERROR',
    en: 'Model "{model}" is not registered.',
    zh: '模型 "{model}" 未注册。',
  },
  E1010: {
    severity: 'ERROR',
    en: 'Batch row {index} failed validation: {detail}.',
    zh: '批量行 {index} 校验失败：{detail}。',
  },
  E1011: {
    severity: 'WARN',
    en: 'Field "{field}" default value injected ({default}).',
    zh: '字段 "{field}" 已注入默认值（{default}）。',
  },
  E2005: {
    severity: 'ERROR',
    en: 'Self-referential cycle detected on relation "{relation}": entity "{recordId}" links back to itself.',
    zh: '关系 "{relation}" 检测到自关联死循环：实体 "{recordId}" 链接回了自身。',
  },
  E3001: {
    severity: 'ERROR',
    en: 'Field "{field}" value {received} is out of allowed range.',
    zh: '字段 "{field}" 的值 {received} 超出允许范围。',
  },
  E3002: {
    severity: 'FATAL',
    en: 'Atlas vault is corrupted or undecodable ({phase}): {detail}.',
    zh: '图谱保险库损坏或无法解码（{phase}）：{detail}。',
  },
};

// ---------------------------------------------------------------------------
// Diagnostic (single issue)
// ---------------------------------------------------------------------------

export interface DiagnosticContext {
  readonly model?: string;
  readonly recordId?: string;
  readonly field?: string;
  readonly rowIndex?: number;
  [key: string]: unknown;
}

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  readonly message: string;
  readonly context: DiagnosticContext;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// ValidationReport (batch result)
// ---------------------------------------------------------------------------

export interface RowResult<T = unknown> {
  readonly index: number;
  readonly success: boolean;
  readonly data?: T;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ValidationReportSummary {
  readonly total: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly errorCodes: readonly DiagnosticCode[];
  readonly hasFatal: boolean;
}

export interface ValidationReportJSON {
  readonly ok: boolean;
  readonly summary: ValidationReportSummary;
  readonly rows: ReadonlyArray<{
    index: number;
    success: boolean;
    diagnostics: ReadonlyArray<{ code: DiagnosticCode; severity: Severity; message: string }>;
  }>;
  readonly globalDiagnostics: ReadonlyArray<{
    code: DiagnosticCode;
    severity: Severity;
    message: string;
  }>;
}

export class ValidationReport<T = unknown> {
  private readonly _rows: RowResult<T>[] = [];
  private readonly _global: Diagnostic[] = [];

  addRow(result: RowResult<T>): void {
    this._rows.push(result);
  }

  addGlobal(d: Diagnostic): void {
    this._global.push(d);
  }

  /**
   * Streaming entry point: append a diagnostic to the global list.
   * Alias for {@link addGlobal} — matches the `report.report(entry)` pattern
   * requested for pipeline-style collection.
   */
  report(entry: Diagnostic): void {
    this._global.push(entry);
  }

  get rows(): readonly RowResult<T>[] {
    return this._rows;
  }

  get globalDiagnostics(): readonly Diagnostic[] {
    return this._global;
  }

  get succeeded(): readonly RowResult<T>[] {
    return this._rows.filter((r) => r.success);
  }

  get failed(): readonly RowResult<T>[] {
    return this._rows.filter((r) => !r.success);
  }

  get successCount(): number {
    return this._rows.filter((r) => r.success).length;
  }

  get failureCount(): number {
    return this._rows.filter((r) => !r.success).length;
  }

  /** @deprecated Use {@link successCount}. */
  get totalSucceeded(): number {
    return this.successCount;
  }

  /** @deprecated Use {@link failureCount}. */
  get totalFailed(): number {
    return this.failureCount;
  }

  get ok(): boolean {
    return this.failureCount === 0 && this._global.every((d) => d.severity !== 'FATAL');
  }

  get hasWarnings(): boolean {
    return (
      this._global.some((d) => d.severity === 'WARN') ||
      this._rows.some((r) => r.diagnostics.some((d) => d.severity === 'WARN'))
    );
  }

  /** Returns `true` when every row succeeded and no FATAL globals exist. */
  isAllSuccess(): boolean {
    return this.ok;
  }

  /** Structured summary for logging / dashboards. */
  getSummary(): ValidationReportSummary {
    const allDiags = this.allDiagnostics();
    const codeSet = new Set<DiagnosticCode>();
    let hasFatal = false;
    for (const d of allDiags) {
      codeSet.add(d.code);
      if (d.severity === 'FATAL') {
        hasFatal = true;
      }
    }
    return {
      total: this._rows.length,
      successCount: this.successCount,
      failureCount: this.failureCount,
      errorCodes: [...codeSet],
      hasFatal,
    };
  }

  /** Serializable JSON snapshot (strips data payloads for safe transport). */
  exportAsJSON(): ValidationReportJSON {
    const mapDiag = (d: Diagnostic) => ({
      code: d.code,
      severity: d.severity,
      message: d.message,
    });
    return {
      ok: this.ok,
      summary: this.getSummary(),
      rows: this._rows.map((r) => ({
        index: r.index,
        success: r.success,
        diagnostics: r.diagnostics.map(mapDiag),
      })),
      globalDiagnostics: this._global.map(mapDiag),
    };
  }

  /** Flatten all diagnostics (global + per-row) in order. */
  allDiagnostics(): readonly Diagnostic[] {
    const all: Diagnostic[] = [...this._global];
    for (const row of this._rows) {
      all.push(...row.diagnostics);
    }
    return all;
  }

  /** Convenience: all ERROR/FATAL diagnostics. */
  errors(): readonly Diagnostic[] {
    return this.allDiagnostics().filter((d) => d.severity === 'ERROR' || d.severity === 'FATAL');
  }

  /** Convenience: all WARN diagnostics. */
  warnings(): readonly Diagnostic[] {
    return this.allDiagnostics().filter((d) => d.severity === 'WARN');
  }
}

// ---------------------------------------------------------------------------
// DiagnosticCenter
// ---------------------------------------------------------------------------

export type DiagnosticLocale = 'en' | 'zh';

export class DiagnosticCenter {
  private static _locale: DiagnosticLocale = 'en';
  private static readonly _listeners: Array<(d: Diagnostic) => void> = [];

  static get locale(): DiagnosticLocale {
    return DiagnosticCenter._locale;
  }

  static set locale(l: DiagnosticLocale) {
    DiagnosticCenter._locale = l;
  }

  /** Subscribe to every diagnostic emitted (useful for logging / telemetry). */
  static onDiagnostic(fn: (d: Diagnostic) => void): () => void {
    DiagnosticCenter._listeners.push(fn);
    return () => {
      const idx = DiagnosticCenter._listeners.indexOf(fn);
      if (idx >= 0) {
        DiagnosticCenter._listeners.splice(idx, 1);
      }
    };
  }

  /** Look up a code's registry entry. */
  static getCodeEntry(code: DiagnosticCode): CodeEntry {
    return CODE_REGISTRY[code];
  }

  /** All registered codes (for tooling / docs). */
  static get codes(): ReadonlyArray<DiagnosticCode> {
    return Object.keys(CODE_REGISTRY) as DiagnosticCode[];
  }

  /**
   * Build a {@link Diagnostic} and optionally throw.
   *
   * - `mode: 'throw'` (default): creates the diagnostic, notifies listeners, then throws.
   * - `mode: 'collect'`: creates the diagnostic, notifies listeners, pushes to `target` if given, returns it.
   *
   * `severityOverride` allows callers to escalate/downgrade the default severity for a code.
   */
  static report(
    code: DiagnosticCode,
    ctx: DiagnosticContext,
    mode: 'throw' | 'collect' = 'throw',
    target?: Diagnostic[],
    severityOverride?: Severity,
  ): Diagnostic {
    const entry = CODE_REGISTRY[code];
    const message = DiagnosticCenter.interpolate(
      DiagnosticCenter._locale === 'zh' ? entry.zh : entry.en,
      ctx,
    );
    const d: Diagnostic = {
      code,
      severity: severityOverride ?? entry.severity,
      message,
      context: ctx,
      timestamp: Date.now(),
    };

    for (const fn of DiagnosticCenter._listeners) {
      try {
        fn(d);
      } catch {
        /* listener errors must not break the engine */
      }
    }

    if (target) {
      target.push(d);
    }

    if (mode === 'throw') {
      DiagnosticCenter.throwForDiagnostic(d);
    }

    return d;
  }

  /**
   * Create a diagnostic without throwing or notifying listeners.
   * Useful for building reports row-by-row.
   */
  static create(code: DiagnosticCode, ctx: DiagnosticContext): Diagnostic {
    const entry = CODE_REGISTRY[code];
    const message = DiagnosticCenter.interpolate(
      DiagnosticCenter._locale === 'zh' ? entry.zh : entry.en,
      ctx,
    );
    return {
      code,
      severity: entry.severity,
      message,
      context: ctx,
      timestamp: Date.now(),
    };
  }

  /** Convert a Diagnostic to the appropriate engine Error subclass. */
  static toError(d: Diagnostic): EngineError {
    if (d.severity === 'FATAL') {
      if (d.context.filePath) {
        return new FileIOError(d.message, d.context.filePath as string);
      }
      return new EngineError(d.message);
    }
    return new ValidationError(d.message);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private static interpolate(template: string, ctx: DiagnosticContext): string {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => {
      const val = ctx[key];
      if (val === undefined || val === null) {
        return `<${key}>`;
      }
      return String(val);
    });
  }

  private static throwForDiagnostic(d: Diagnostic): never {
    throw DiagnosticCenter.toError(d);
  }
}
