/**
 * Mirror of `@mode-db/common` DataType — duplicated here to avoid pulling
 * Node-only barrel exports (`engine-logger`, `disk-adapter`, `PathResolver`)
 * into the Vite browser bundle.
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
 * 与引擎 DataType 一致的画布字段逻辑类型（PascalCase）。
 * `engine_type` 存此列表中的下标，便于与目录对齐。
 */
export const DESIGNER_PROP_DATA_TYPES = [
  DataType.String,
  DataType.I18N,
  DataType.Number,
  DataType.Int,
  DataType.Boolean,
  DataType.DateTime,
  DataType.JSON,
  DataType.Color,
  DataType.Unit,
] as const satisfies readonly DataType[];

const ORDERED = DESIGNER_PROP_DATA_TYPES as readonly string[];

export function dataTypeToEngineCode(t: string): number {
  const i = ORDERED.indexOf(t);
  return i >= 0 ? i : 0;
}

/** 兼容旧数据（小写 string/number/boolean；以及历史上可能出现的非字符串类型）。 */
export function normalizeLegacyPropType(t: unknown): string {
  if (typeof t !== 'string' || !t) {
    return DataType.String;
  }
  if (ORDERED.includes(t)) {
    return t;
  }
  const legacy: Record<string, string> = {
    string: DataType.String,
    number: DataType.Number,
    boolean: DataType.Boolean,
  };
  const low = t.toLowerCase();
  return legacy[low] ?? t;
}

/** engine.json 键：`propDT_String` … */
export function propDataTypeLabelKey(t: string): string {
  return `propDT_${t}`;
}
