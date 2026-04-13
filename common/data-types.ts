import { ValidationError } from './errors.js';

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
 * - `required`: when `true`, `null` / `undefined` values are rejected on insert/update.
 * - `unit`: default unit string for `'Unit'` fields (e.g. `'m'`, `'kg'`).
 */
export interface FieldTypeDef {
  readonly type: DataType;
  readonly required?: boolean;
  readonly unit?: string;
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
  return input;
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
export function validateFieldValue(
  field: string,
  value: unknown,
  def: FieldTypeDef,
  locale?: string,
): void {
  if (value === null || value === undefined) {
    if (def.required) {
      throw new ValidationError(`Field "${field}" is required but received ${String(value)}.`);
    }
    return;
  }

  switch (def.type) {
    case 'String':
      if (typeof value !== 'string') {
        throw new ValidationError(`Field "${field}" expects String but received ${typeof value}.`);
      }
      break;

    case 'I18N':
      if (typeof value === 'string') {
        if (!locale) {
          throw new ValidationError(
            `Field "${field}" is I18N; pass an object like { zh: "..." } or set currentLocale for auto-wrap.`,
          );
        }
      } else if (isPlainObject(value)) {
        for (const [k, v] of Object.entries(value)) {
          if (typeof k !== 'string' || typeof v !== 'string') {
            throw new ValidationError(
              `Field "${field}" (I18N) must be a Record<string, string>; key "${k}" has non-string value.`,
            );
          }
        }
      } else {
        throw new ValidationError(
          `Field "${field}" expects I18N (object or string with locale) but received ${typeof value}.`,
        );
      }
      break;

    case 'Number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new ValidationError(
          `Field "${field}" expects Number but received ${typeof value === 'number' ? 'NaN' : typeof value}.`,
        );
      }
      break;

    case 'Int':
      if (typeof value !== 'number' || Number.isNaN(value) || !Number.isInteger(value)) {
        throw new ValidationError(
          `Field "${field}" expects Int but received ${typeof value === 'number' ? String(value) : typeof value}.`,
        );
      }
      break;

    case 'Boolean':
      if (typeof value !== 'boolean') {
        throw new ValidationError(`Field "${field}" expects Boolean but received ${typeof value}.`);
      }
      break;

    case 'DateTime':
      if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
        throw new ValidationError(
          `Field "${field}" expects DateTime (ISO 8601 string) but received ${JSON.stringify(value)}.`,
        );
      }
      break;

    case 'JSON':
      break;

    case 'Color':
      if (typeof value === 'string') {
        if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
          throw new ValidationError(
            `Field "${field}" expects Color (hex string or {r,g,b,a?}) but received invalid hex "${value}".`,
          );
        }
      } else if (isPlainObject(value)) {
        const o = value as Record<string, unknown>;
        if (typeof o.r !== 'number' || typeof o.g !== 'number' || typeof o.b !== 'number') {
          throw new ValidationError(
            `Field "${field}" expects Color {r,g,b,a?} with numeric channels.`,
          );
        }
      } else {
        throw new ValidationError(
          `Field "${field}" expects Color (hex string or {r,g,b,a?}) but received ${typeof value}.`,
        );
      }
      break;

    case 'Unit':
      if (!isPlainObject(value)) {
        throw new ValidationError(
          `Field "${field}" expects Unit ({value, unit}) but received ${typeof value}.`,
        );
      }
      {
        const o = value as Record<string, unknown>;
        if (typeof o.value !== 'number' || Number.isNaN(o.value)) {
          throw new ValidationError(`Field "${field}" expects Unit.value to be a finite number.`);
        }
        if (typeof o.unit !== 'string') {
          throw new ValidationError(`Field "${field}" expects Unit.unit to be a string.`);
        }
      }
      break;

    default: {
      const _exhaustive: never = def.type;
      throw new ValidationError(`Unknown DataType "${_exhaustive}".`);
    }
  }
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
