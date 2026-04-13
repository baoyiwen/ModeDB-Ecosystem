import type { DataType, FieldTypeDef } from './data-types.js';
import { ValidationError } from './errors.js';

/**
 * Callback signature for syncing a field value back to the model buffer.
 * Provided by the hydration layer so `.update()` can write through.
 */
export type ValueSyncFn = (fieldName: string, rawValue: unknown) => void;

/**
 * Abstract base class for all object-oriented field types.
 *
 * Every high-level type (I18N, Color, Unit, …) extends this class and
 * implements {@link getData} (extract the raw JSON-safe value) and
 * {@link validate} (type-check an incoming raw value).
 *
 * Instances are created by the hydration layer and carry a back-reference
 * to the owning entity's sync callback so that `.update()` can push
 * changes into the write-behind buffer without manual plumbing.
 */
export abstract class ValueObject<T = unknown> {
  constructor(
    protected _value: T,
    readonly fieldName: string,
    readonly typeDef: FieldTypeDef,
    protected readonly _sync?: ValueSyncFn,
  ) {}

  abstract getData(): T;

  abstract validate(raw: unknown): T;

  update(newValue: T | unknown): void {
    const validated = this.validate(newValue);
    this._value = validated;
    this._sync?.(this.fieldName, this.getData());
  }

  get dataType(): DataType {
    return this.typeDef.type;
  }
}

// ---------------------------------------------------------------------------
// I18NValue
// ---------------------------------------------------------------------------

export type I18NDict = Record<string, string>;

export class I18NValue extends ValueObject<I18NDict> {
  getData(): I18NDict {
    return { ...this._value };
  }

  validate(raw: unknown): I18NDict {
    if (raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof k !== 'string' || typeof v !== 'string') {
          throw new ValidationError(
            `I18NValue "${this.fieldName}": every entry must be string→string; key "${k}" has ${typeof v}.`,
          );
        }
      }
      return obj as I18NDict;
    }
    throw new ValidationError(
      `I18NValue "${this.fieldName}" expects Record<string, string> but received ${typeof raw}.`,
    );
  }

  get(lang: string): string | undefined {
    return this._value[lang];
  }

  set(lang: string, text: string): void {
    this._value = { ...this._value, [lang]: text };
    this._sync?.(this.fieldName, this.getData());
  }

  get locales(): string[] {
    return Object.keys(this._value);
  }
}

// ---------------------------------------------------------------------------
// ColorValue
// ---------------------------------------------------------------------------

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function parseHex(hex: string): RGBA {
  let h = hex.replace(/^#/, '');
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length === 6) {
    h += 'ff';
  }
  if (h.length !== 8) {
    throw new ValidationError(`Invalid hex color: "${hex}".`);
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: parseInt(h.slice(6, 8), 16) / 255,
  };
}

export class ColorValue extends ValueObject<RGBA> {
  getData(): RGBA {
    return { ...this._value };
  }

  validate(raw: unknown): RGBA {
    if (typeof raw === 'string') {
      return parseHex(raw);
    }
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      if (typeof o.r === 'number' && typeof o.g === 'number' && typeof o.b === 'number') {
        return {
          r: clamp(Math.round(o.r as number), 0, 255),
          g: clamp(Math.round(o.g as number), 0, 255),
          b: clamp(Math.round(o.b as number), 0, 255),
          a: typeof o.a === 'number' ? clamp(o.a as number, 0, 1) : 1,
        };
      }
    }
    throw new ValidationError(
      `ColorValue "${this.fieldName}" expects hex string or {r,g,b,a?} but received ${typeof raw}.`,
    );
  }

  toHex(): string {
    const { r, g, b, a } = this._value;
    const hex = [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
    if (a < 1) {
      return `#${hex}${Math.round(a * 255)
        .toString(16)
        .padStart(2, '0')}`;
    }
    return `#${hex}`;
  }

  toCSS(): string {
    const { r, g, b, a } = this._value;
    if (a < 1) {
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    return `rgb(${r}, ${g}, ${b})`;
  }
}

// ---------------------------------------------------------------------------
// UnitValue
// ---------------------------------------------------------------------------

export interface UnitData {
  value: number;
  unit: string;
}

const UNIT_CONVERSIONS: Record<string, Record<string, number>> = {
  m: { cm: 100, mm: 1000, km: 0.001, ft: 3.28084, in: 39.3701 },
  cm: { m: 0.01, mm: 10, km: 0.00001, ft: 0.0328084, in: 0.393701 },
  mm: { m: 0.001, cm: 0.1, km: 0.000001 },
  km: { m: 1000, cm: 100_000, mm: 1_000_000 },
  kg: { g: 1000, lb: 2.20462, oz: 35.274 },
  g: { kg: 0.001, lb: 0.00220462, oz: 0.035274 },
  lb: { kg: 0.453592, g: 453.592, oz: 16 },
};

export class UnitValue extends ValueObject<UnitData> {
  getData(): UnitData {
    return { ...this._value };
  }

  validate(raw: unknown): UnitData {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      if (typeof o.value === 'number' && typeof o.unit === 'string') {
        if (Number.isNaN(o.value)) {
          throw new ValidationError(`UnitValue "${this.fieldName}": value must not be NaN.`);
        }
        return { value: o.value as number, unit: o.unit as string };
      }
    }
    throw new ValidationError(
      `UnitValue "${this.fieldName}" expects {value: number, unit: string} but received ${typeof raw}.`,
    );
  }

  get value(): number {
    return this._value.value;
  }

  get unit(): string {
    return this._value.unit;
  }

  convertTo(targetUnit: string): number {
    if (this._value.unit === targetUnit) {
      return this._value.value;
    }
    const table = UNIT_CONVERSIONS[this._value.unit];
    const factor = table?.[targetUnit];
    if (factor === undefined) {
      throw new ValidationError(
        `No conversion from "${this._value.unit}" to "${targetUnit}" is registered.`,
      );
    }
    return this._value.value * factor;
  }
}

// ---------------------------------------------------------------------------
// Scalar wrappers (String, Number, Int, Boolean, DateTime, JSON)
// ---------------------------------------------------------------------------

export class StringValue extends ValueObject<string> {
  getData(): string {
    return this._value;
  }

  validate(raw: unknown): string {
    if (typeof raw === 'string') {
      return raw;
    }
    throw new ValidationError(
      `StringValue "${this.fieldName}" expects string but received ${typeof raw}.`,
    );
  }
}

export class NumberValue extends ValueObject<number> {
  getData(): number {
    return this._value;
  }

  validate(raw: unknown): number {
    if (typeof raw === 'number' && !Number.isNaN(raw)) {
      return raw;
    }
    throw new ValidationError(
      `NumberValue "${this.fieldName}" expects number but received ${typeof raw === 'number' ? 'NaN' : typeof raw}.`,
    );
  }
}

export class IntValue extends ValueObject<number> {
  getData(): number {
    return this._value;
  }

  validate(raw: unknown): number {
    if (typeof raw === 'number' && !Number.isNaN(raw) && Number.isInteger(raw)) {
      return raw;
    }
    throw new ValidationError(
      `IntValue "${this.fieldName}" expects integer but received ${typeof raw === 'number' ? String(raw) : typeof raw}.`,
    );
  }
}

export class BooleanValue extends ValueObject<boolean> {
  getData(): boolean {
    return this._value;
  }

  validate(raw: unknown): boolean {
    if (typeof raw === 'boolean') {
      return raw;
    }
    throw new ValidationError(
      `BooleanValue "${this.fieldName}" expects boolean but received ${typeof raw}.`,
    );
  }
}

export class DateTimeValue extends ValueObject<string> {
  private static readonly ISO_RE =
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

  getData(): string {
    return this._value;
  }

  validate(raw: unknown): string {
    if (typeof raw === 'string' && DateTimeValue.ISO_RE.test(raw)) {
      return raw;
    }
    throw new ValidationError(
      `DateTimeValue "${this.fieldName}" expects ISO 8601 string but received ${JSON.stringify(raw)}.`,
    );
  }

  toDate(): Date {
    return new Date(this._value);
  }
}

export class JsonValue extends ValueObject<unknown> {
  getData(): unknown {
    return this._value;
  }

  validate(raw: unknown): unknown {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Factory: raw value + FieldTypeDef → ValueObject
// ---------------------------------------------------------------------------

/**
 * Coerce a raw persisted Color value (hex string or RGBA object) into an RGBA.
 */
function coerceRawColor(raw: unknown): RGBA {
  if (typeof raw === 'string') {
    return parseHex(raw);
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    return {
      r: clamp(Math.round(Number(o.r ?? 0)), 0, 255),
      g: clamp(Math.round(Number(o.g ?? 0)), 0, 255),
      b: clamp(Math.round(Number(o.b ?? 0)), 0, 255),
      a: typeof o.a === 'number' ? clamp(o.a, 0, 1) : 1,
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

export function createValueObject(
  fieldName: string,
  raw: unknown,
  def: FieldTypeDef,
  sync?: ValueSyncFn,
): ValueObject {
  switch (def.type) {
    case 'String':
      return new StringValue(raw as string, fieldName, def, sync);
    case 'I18N':
      return new I18NValue((raw ?? {}) as I18NDict, fieldName, def, sync);
    case 'Number':
      return new NumberValue(raw as number, fieldName, def, sync);
    case 'Int':
      return new IntValue(raw as number, fieldName, def, sync);
    case 'Boolean':
      return new BooleanValue(raw as boolean, fieldName, def, sync);
    case 'DateTime':
      return new DateTimeValue(raw as string, fieldName, def, sync);
    case 'JSON':
      return new JsonValue(raw, fieldName, def, sync);
    case 'Color':
      return new ColorValue(coerceRawColor(raw), fieldName, def, sync);
    case 'Unit':
      return new UnitValue((raw ?? { value: 0, unit: '' }) as UnitData, fieldName, def, sync);
    default:
      return new JsonValue(raw, fieldName, def, sync);
  }
}

/**
 * Extract raw data from a ValueObject (or return the value as-is if it is not a ValueObject).
 */
export function unwrapValue(v: unknown): unknown {
  if (v instanceof ValueObject) {
    return v.getData();
  }
  return v;
}
