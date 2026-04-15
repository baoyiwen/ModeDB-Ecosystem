import { ValidationError } from './errors.js';
import { DiagnosticCenter, type Diagnostic, type DiagnosticContext } from './diagnostic.js';

/**
 * Built-in data type constants for model field definitions.
 *
 * Use as shorthand strings (`'Int'`, `'I18N'`) or via the constant object
 * (`DataType.Int`, `DataType.I18N`) — both resolve to the same string literal union.
 */
export const DataType = {
  String: 'String',
  I18N: 'I18N',
  Number: 'Number',
  Int: 'Int',
  Boolean: 'Boolean',
  DateTime: 'DateTime',
  JSON: 'JSON',
  Color: 'Color',
  Unit: 'Unit',
} as const;

export type DataType = (typeof DataType)[keyof typeof DataType];

/**
 * Full type definition for a single field.
 *
 * - `required`: when `true`, null / undefined / semantically-empty values are rejected.
 * - `unit`: default unit string for `'Unit'` fields (e.g. `'m'`, `'kg'`).
 * - `default`: value injected on insert when the field is absent from user data.
 *   Evaluated once at definition time (not lazily); use `'JSON'` type for dynamic defaults.
 */
export interface FieldTypeDef {
  readonly type: DataType;
  readonly required?: boolean;
  readonly unit?: string;
  readonly default?: unknown;
}

/** Per-field type metadata map (field name → definition). */
export type FieldTypeMap = ReadonlyMap<string, FieldTypeDef>;

/** User-facing shorthand: either a bare type string or a full definition object. */
export type FieldDefInput = DataType | FieldTypeDef;

/** User-facing typed field specification: `{ age: 'Int', name: { type: 'I18N' } }`. */
export type FieldDefsRecord = Record<string, FieldDefInput>;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const VALID_TYPES = new Set<string>(Object.values(DataType));

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Normalize a user-supplied shorthand (`'Int'`) or full object (`{ type: 'Int' }`)
 * into a canonical {@link FieldTypeDef}.
 */
export function normalizeFieldDef(input: FieldDefInput): FieldTypeDef {
  if (typeof input === 'string') {
    if (!VALID_TYPES.has(input)) {
      throw new ValidationError(`Unknown DataType "${input}".`);
    }
    return { type: input };
  }
  if (!VALID_TYPES.has(input.type)) {
    throw new ValidationError(`Unknown DataType "${input.type}".`);
  }
  const def: FieldTypeDef = { type: input.type };
  if (input.required !== undefined) {
    (def as { required: boolean }).required = input.required;
  }
  if (input.unit !== undefined) {
    (def as { unit: string }).unit = input.unit;
  }
  if (input.default !== undefined) {
    (def as { default: unknown }).default = input.default;
  }
  return def;
}

/**
 * Convert a user-facing `Record<string, DataType | FieldTypeDef>` into
 * a `Set<string>` (field names) and a `Map<string, FieldTypeDef>` (type metadata).
 */
export function normalizeFieldDefs(defs: FieldDefsRecord): {
  fields: Set<string>;
  fieldTypes: Map<string, FieldTypeDef>;
} {
  const fields = new Set<string>();
  const fieldTypes = new Map<string, FieldTypeDef>();
  for (const [key, raw] of Object.entries(defs)) {
    fields.add(key);
    fieldTypes.set(key, normalizeFieldDef(raw));
  }
  return { fields, fieldTypes };
}

/**
 * Validate a single field value against its type definition.
 * Throws {@link ValidationError} on mismatch; returns silently on success.
 *
 * When `locale` is provided and the field is `I18N`, a plain string value is
 * acceptable (it will be auto-wrapped by the storage layer).
 */
/**
 * Returns `true` when `value` is semantically empty for the given DataType.
 * Used by {@link validateFieldValue} to enforce `required` constraints.
 */
export function isFieldValueEmpty(value: unknown, type: DataType): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  switch (type) {
    case 'String':
      return typeof value === 'string' && value.trim().length === 0;
    case 'I18N':
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return Object.keys(value as Record<string, unknown>).length === 0;
      }
      return typeof value === 'string' && value.trim().length === 0;
    case 'Color':
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const o = value as Record<string, unknown>;
        return typeof o.r !== 'number' || typeof o.g !== 'number' || typeof o.b !== 'number';
      }
      return typeof value === 'string' && value.trim().length === 0;
    case 'Unit':
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const o = value as Record<string, unknown>;
        return typeof o.value !== 'number' || Number.isNaN(o.value as number);
      }
      return true;
    default:
      return false;
  }
}

/**
 * Options for diagnostic-aware validation.
 * When `diagnostics` is provided, errors are collected instead of thrown.
 */
export interface ValidateFieldOptions {
  readonly locale?: string;
  readonly diagnostics?: Diagnostic[];
  readonly model?: string;
  readonly recordId?: string;
}

/**
 * Validate a single field value against its type definition.
 *
 * **Default (throw) mode**: throws {@link ValidationError} on mismatch.
 * **Collect mode**: when `options.diagnostics` is provided, pushes a
 * {@link Diagnostic} to the array instead of throwing, and returns `false`.
 *
 * @returns `true` when valid; `false` when invalid (collect mode only).
 */
export function validateFieldValue(
  field: string,
  value: unknown,
  def: FieldTypeDef,
  localeOrOpts?: string | ValidateFieldOptions,
): boolean {
  const opts: ValidateFieldOptions =
    typeof localeOrOpts === 'string' ? { locale: localeOrOpts } : (localeOrOpts ?? {});
  const { locale, diagnostics, model, recordId } = opts;
  const mode: 'throw' | 'collect' = diagnostics ? 'collect' : 'throw';

  const baseCtx: DiagnosticContext = { field, model, recordId, type: def.type };

  const fail = (
    code: Parameters<typeof DiagnosticCenter.report>[0],
    extra?: Record<string, unknown>,
  ): false => {
    DiagnosticCenter.report(code, { ...baseCtx, ...extra }, mode, diagnostics);
    return false;
  };

  if (value === null || value === undefined) {
    if (def.required) {
      return fail('E1001', { received: String(value) });
    }
    return true;
  }

  if (def.required && isFieldValueEmpty(value, def.type)) {
    return fail('E1002', {});
  }

  switch (def.type) {
    case 'String':
      if (typeof value !== 'string') {
        return fail('E1003', { received: typeof value });
      }
      break;

    case 'I18N':
      if (typeof value === 'string') {
        if (!locale) {
          return fail('E1005', {});
        }
      } else if (isPlainObject(value)) {
        for (const [k, v] of Object.entries(value)) {
          if (typeof k !== 'string' || typeof v !== 'string') {
            return fail('E1003', {
              received: `I18N key "${k}" has ${typeof v} value`,
            });
          }
        }
      } else {
        return fail('E1003', { received: typeof value });
      }
      break;

    case 'Number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return fail('E1003', {
          received: typeof value === 'number' ? 'NaN' : typeof value,
        });
      }
      break;

    case 'Int':
      if (typeof value !== 'number' || Number.isNaN(value) || !Number.isInteger(value)) {
        return fail('E1003', {
          received: typeof value === 'number' ? String(value) : typeof value,
        });
      }
      break;

    case 'Boolean':
      if (typeof value !== 'boolean') {
        return fail('E1003', { received: typeof value });
      }
      break;

    case 'DateTime':
      if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
        return fail('E1003', { received: JSON.stringify(value) });
      }
      break;

    case 'JSON':
      break;

    case 'Color':
      if (typeof value === 'string') {
        if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
          return fail('E1003', { received: `invalid hex "${value}"` });
        }
      } else if (isPlainObject(value)) {
        const o = value as Record<string, unknown>;
        if (typeof o.r !== 'number' || typeof o.g !== 'number' || typeof o.b !== 'number') {
          return fail('E1003', { received: 'Color {r,g,b,a?} with non-numeric channels' });
        }
      } else {
        return fail('E1003', { received: typeof value });
      }
      break;

    case 'Unit':
      if (!isPlainObject(value)) {
        return fail('E1003', { received: typeof value });
      }
      {
        const o = value as Record<string, unknown>;
        if (typeof o.value !== 'number' || Number.isNaN(o.value)) {
          return fail('E1003', { received: 'Unit.value is not a finite number' });
        }
        if (typeof o.unit !== 'string') {
          return fail('E1003', { received: 'Unit.unit is not a string' });
        }
      }
      break;

    default: {
      const _exhaustive: never = def.type;
      return fail('E1004', { type: _exhaustive });
    }
  }
  return true;
}

/**
 * Coerce an I18N field value: if the user passed a plain string and a locale is set,
 * wrap it as `{ [locale]: value }`. Returns the value unchanged otherwise.
 */
export function coerceI18NValue(
  value: unknown,
  def: FieldTypeDef,
  locale: string | undefined,
): unknown {
  if (def.type === 'I18N' && typeof value === 'string' && locale) {
    return { [locale]: value };
  }
  return value;
}
