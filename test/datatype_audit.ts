/**
 * DataType Protocol 审计：类型校验、I18N 自动包装与查询解析、
 * .mld schema header 持久化、atlas-manifest fieldTypes、向后兼容。
 *
 * Run:  npx tsx test/datatype_audit.ts
 *       npm run datatype-audit
 *       npm run test:integration（含本脚本）
 */

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { AuthoringEngine } from '../src/authoring/AuthoringEngine.js';
import { ValidationError } from '../common/errors.js';
import { DataType } from '../common/data-types.js';
import {
  I18NValue,
  ColorValue,
  UnitValue,
  IntValue,
  StringValue,
  JsonValue,
} from '../common/value-objects.js';

const DATA_ROOT = join(process.cwd(), 'data');
const ATLAS = 'datatype_audit';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function assertRejects(
  fn: () => Promise<unknown>,
  errorType: abstract new (...a: never[]) => Error,
  msg: string,
): Promise<void> {
  try {
    await fn();
    failed++;
    console.error(`  ✗ ${msg} — expected throw but none occurred`);
  } catch (err) {
    if (err instanceof errorType) {
      passed++;
      console.log(`  ✓ ${msg}`);
    } else {
      failed++;
      console.error(
        `  ✗ ${msg} — wrong error type: ${(err as Error).constructor.name}: ${(err as Error).message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 1. updateFields — typed record vs legacy string[]
// ---------------------------------------------------------------------------
async function auditUpdateFields(): Promise<void> {
  console.log('\n═══ 1. updateFields — typed record 与 legacy string[] ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('TypedModel');
  const m = engine.model('TypedModel');
  m.updateFields({
    name: 'I18N',
    age: 'Int',
    score: { type: 'Number' },
    active: 'Boolean',
    bio: 'String',
    createdAt: 'DateTime',
    meta: 'JSON',
    color: 'Color',
    size: 'Unit',
  });

  const def = engine.registry.getModel('TypedModel')!;
  assert(def.fields.has('name'), 'typed record: fields 包含 name');
  assert(def.fields.has('age'), 'typed record: fields 包含 age');
  assert(def.fieldTypes.get('name')?.type === 'I18N', 'fieldTypes name → I18N');
  assert(def.fieldTypes.get('age')?.type === 'Int', 'fieldTypes age → Int');
  assert(def.fieldTypes.get('score')?.type === 'Number', 'fieldTypes score → Number');
  assert(def.fieldTypes.get('active')?.type === 'Boolean', 'fieldTypes active → Boolean');
  assert(def.fieldTypes.get('color')?.type === 'Color', 'fieldTypes color → Color');
  assert(def.fieldTypes.get('size')?.type === 'Unit', 'fieldTypes size → Unit');

  engine.registerModel('LegacyModel');
  const legacy = engine.model('LegacyModel');
  legacy.updateFields(['x', 'y', 'z']);
  const legacyDef = engine.registry.getModel('LegacyModel')!;
  assert(legacyDef.fields.has('x'), 'legacy string[]: fields 包含 x');
  assert(legacyDef.fieldTypes.size === 0, 'legacy string[]: fieldTypes 为空');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 2. Pre-insert validation
// ---------------------------------------------------------------------------
async function auditInsertValidation(): Promise<void> {
  console.log('\n═══ 2. Pre-insert validation ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('Validated', {
    age: 'Int',
    score: 'Number',
    active: 'Boolean',
    createdAt: 'DateTime',
    bio: 'String',
    meta: 'JSON',
    color: 'Color',
    size: 'Unit',
  });

  const m = engine.model('Validated');

  await assertRejects(() => m.insert({ age: 'abc' }), ValidationError, 'Int 字段拒绝字符串 "abc"');

  await assertRejects(() => m.insert({ age: 3.14 }), ValidationError, 'Int 字段拒绝浮点数 3.14');

  await assertRejects(
    () => m.insert({ score: 'abc' }),
    ValidationError,
    'Number 字段拒绝字符串 "abc"',
  );

  await assertRejects(() => m.insert({ active: 1 }), ValidationError, 'Boolean 字段拒绝数字 1');

  await assertRejects(
    () => m.insert({ createdAt: 'not-a-date' }),
    ValidationError,
    'DateTime 字段拒绝非 ISO 格式',
  );

  await assertRejects(() => m.insert({ bio: 123 }), ValidationError, 'String 字段拒绝数字 123');

  await assertRejects(
    () => m.insert({ color: 'not-a-color' }),
    ValidationError,
    'Color 字段拒绝无效 hex',
  );

  await assertRejects(
    () => m.insert({ size: 'not-a-unit' }),
    ValidationError,
    'Unit 字段拒绝非对象值',
  );

  const validRecord = await m.insert({
    age: 25,
    score: 99.5,
    active: true,
    createdAt: '2026-04-13T12:00:00Z',
    bio: 'hello',
    meta: { anything: true },
    color: '#ff0000',
    size: { value: 1.5, unit: 'm' },
  });
  assert(validRecord._id !== undefined, '合法数据插入成功');
  assert((validRecord as Record<string, unknown>).age === 25, '合法数据 age = 25');

  const nullRecord = await m.insert({ age: null as unknown as number });
  assert(nullRecord._id !== undefined, 'null 值（非 required）插入成功');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 3. I18N insert — plain string auto-wrap
// ---------------------------------------------------------------------------
async function auditI18NInsert(): Promise<void> {
  console.log('\n═══ 3. I18N insert — plain string auto-wrap ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('I18NModel', { title: 'I18N', desc: 'I18N' });
  const m = engine.model('I18NModel');

  const r1 = await m.insert({ title: '你好', desc: { zh: '描述', en: 'desc' } });
  const titleVal = (r1 as Record<string, unknown>).title;
  assert(
    typeof titleVal === 'object' && (titleVal as Record<string, string>).zh === '你好',
    'plain string auto-wrapped to { zh: "你好" }',
  );

  const descVal = (r1 as Record<string, unknown>).desc as Record<string, string>;
  assert(descVal.zh === '描述' && descVal.en === 'desc', 'object form I18N 保持不变');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 4. I18N query — locale-aware filtering
// ---------------------------------------------------------------------------
async function auditI18NQuery(): Promise<void> {
  console.log('\n═══ 4. I18N query — locale-aware filtering ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('I18NQuery', { name: 'I18N', code: 'String' });
  const m = engine.model('I18NQuery');

  await m.insert({ name: { zh: '苹果', en: 'Apple' }, code: 'A' });
  await m.insert({ name: { zh: '香蕉', en: 'Banana' }, code: 'B' });
  await m.insert({ name: { zh: '橙子', en: 'Orange' }, code: 'C' });

  const results = await m.query().where('name', 'eq', '苹果').execute();
  assert(results.length === 1, 'I18N query(zh) "苹果" 命中 1 行');
  assert(
    (results[0]!.getData() as Record<string, unknown>).code === 'A',
    'I18N query 结果 code = A',
  );

  const noHit = await m.query().where('name', 'eq', 'Apple').execute();
  assert(noHit.length === 0, 'I18N query(zh) "Apple" 不命中（locale=zh）');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 5. .mld schema header persistence
// ---------------------------------------------------------------------------
async function auditMldSchemaHeader(): Promise<void> {
  console.log('\n═══ 5. .mld schema header 持久化 ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('HeaderTest', { val: 'Int', label: 'I18N' });
  const m = engine.model('HeaderTest');

  await m.insert({ val: 42, label: '测试' }, { sync: true });

  const mldPath = engine.paths.modelDataPath('HeaderTest');
  assert(existsSync(mldPath), '.mld 文件存在');

  const content = readFileSync(mldPath, 'utf-8');
  const firstLine = content.split('\n')[0]!;
  assert(firstLine.startsWith('{"__schema__":'), '.mld 首行以 {"__schema__": 开头');

  const header = JSON.parse(firstLine) as {
    __schema__: { fields: string[]; fieldTypes?: Record<string, unknown> };
  };
  assert(Array.isArray(header.__schema__.fields), 'schema header 包含 fields 数组');
  assert(header.__schema__.fieldTypes !== undefined, 'schema header 包含 fieldTypes');
  assert(
    (header.__schema__.fieldTypes as Record<string, { type: string }>).val?.type === 'Int',
    'schema header fieldTypes.val.type = Int',
  );

  const dataLines = content.split('\n').filter((l) => l.trim() && !l.startsWith('{"__schema__":'));
  assert(dataLines.length >= 1, '.mld 数据行 ≥ 1');
  const dataRow = JSON.parse(dataLines[0]!) as Record<string, unknown>;
  assert(dataRow._id !== undefined, '数据行包含 _id');
  assert(dataRow.val === 42, '数据行 val = 42');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 6. atlas-manifest.json fieldTypes
// ---------------------------------------------------------------------------
async function auditManifestFieldTypes(): Promise<void> {
  console.log('\n═══ 6. atlas-manifest.json fieldTypes ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('ManifestTest', {
    count: 'Int',
    label: 'I18N',
    color: 'Color',
    size: { type: 'Unit', unit: 'm' },
  });

  await engine.flushAll();

  const manifestPath = engine.paths.manifestFilePath();
  assert(existsSync(manifestPath), 'atlas-manifest.json 存在');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    models: Array<{
      name: string;
      fields: string[];
      fieldTypes?: Record<string, { type: string; unit?: string }>;
    }>;
  };

  const model = manifest.models.find((m) => m.name === 'ManifestTest');
  assert(model !== undefined, 'manifest 包含 ManifestTest');
  assert(model!.fieldTypes !== undefined, 'manifest model 包含 fieldTypes');
  assert(model!.fieldTypes!.count?.type === 'Int', 'manifest fieldTypes.count.type = Int');
  assert(model!.fieldTypes!.label?.type === 'I18N', 'manifest fieldTypes.label.type = I18N');
  assert(model!.fieldTypes!.color?.type === 'Color', 'manifest fieldTypes.color.type = Color');
  assert(model!.fieldTypes!.size?.type === 'Unit', 'manifest fieldTypes.size.type = Unit');
  assert(model!.fieldTypes!.size?.unit === 'm', 'manifest fieldTypes.size.unit = m');

  const legacyModel = manifest.models.find((m) => m.name === 'LegacyModel');
  if (legacyModel) {
    assert(legacyModel.fieldTypes === undefined, 'legacy model 在 manifest 中无 fieldTypes');
  }
}

// ---------------------------------------------------------------------------
// 7. Backward compatibility — untyped fields skip validation
// ---------------------------------------------------------------------------
async function auditBackwardCompat(): Promise<void> {
  console.log('\n═══ 7. Backward compatibility — untyped fields ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('UntypedModel');
  engine.model('UntypedModel').updateFields(['foo', 'bar']);

  const m = engine.model('UntypedModel');
  const r = await m.insert({ foo: 123, bar: { nested: true } });
  assert(r._id !== undefined, 'untyped model 插入任意类型成功');
  assert((r as Record<string, unknown>).foo === 123, 'untyped field foo = 123 (number)');
  assert(typeof (r as Record<string, unknown>).bar === 'object', 'untyped field bar = object');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 8. DataType constants
// ---------------------------------------------------------------------------
function auditDataTypeConstants(): void {
  console.log('\n═══ 8. DataType constants ═══');

  assert(DataType.String === 'String', 'DataType.String = "String"');
  assert(DataType.I18N === 'I18N', 'DataType.I18N = "I18N"');
  assert(DataType.Number === 'Number', 'DataType.Number = "Number"');
  assert(DataType.Int === 'Int', 'DataType.Int = "Int"');
  assert(DataType.Boolean === 'Boolean', 'DataType.Boolean = "Boolean"');
  assert(DataType.DateTime === 'DateTime', 'DataType.DateTime = "DateTime"');
  assert(DataType.JSON === 'JSON', 'DataType.JSON = "JSON"');
  assert(DataType.Color === 'Color', 'DataType.Color = "Color"');
  assert(DataType.Unit === 'Unit', 'DataType.Unit = "Unit"');
}

// ---------------------------------------------------------------------------
// 9. I18N without locale — rejects plain string
// ---------------------------------------------------------------------------
async function auditI18NNoLocale(): Promise<void> {
  console.log('\n═══ 9. I18N without locale — rejects plain string ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS });

  engine.registerModel('NoLocaleModel', { title: 'I18N' });
  const m = engine.model('NoLocaleModel');

  await assertRejects(
    () => m.insert({ title: 'plain string' }),
    ValidationError,
    'I18N 字段无 locale 时拒绝 plain string',
  );

  const r = await m.insert({ title: { zh: '中文', en: 'English' } });
  assert(r._id !== undefined, 'I18N 字段无 locale 时接受 object form');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 10. Engine-level registerModel with typed fields
// ---------------------------------------------------------------------------
async function auditEngineRegisterTyped(): Promise<void> {
  console.log('\n═══ 10. Engine-level registerModel with typed fields ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('EngineTyped', { x: 'Int', y: 'Number' });
  const def = engine.registry.getModel('EngineTyped')!;
  assert(def.fields.has('x'), 'registerModel typed: fields 包含 x');
  assert(def.fieldTypes.get('x')?.type === 'Int', 'registerModel typed: x → Int');
  assert(def.fieldTypes.get('y')?.type === 'Number', 'registerModel typed: y → Number');

  engine.registerModel('EngineUntyped', new Set(['a', 'b']));
  const untypedDef = engine.registry.getModel('EngineUntyped')!;
  assert(untypedDef.fields.has('a'), 'registerModel untyped: fields 包含 a');
  assert(untypedDef.fieldTypes.size === 0, 'registerModel untyped: fieldTypes 为空');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 11. ValueObject — getValue() on HydratedEntity
// ---------------------------------------------------------------------------
async function auditValueObject(): Promise<void> {
  console.log('\n═══ 11. ValueObject — getValue() on HydratedEntity ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('VOModel', {
    name: 'I18N',
    age: 'Int',
    bio: 'String',
    meta: 'JSON',
  });
  const m = engine.model('VOModel');

  await m.insert({ name: '测试', age: 42, bio: 'hello', meta: { x: 1 } });

  const results = await m.query().execute();
  assert(results.length === 1, 'VOModel query 返回 1 行');

  const entity = results[0]!;
  const nameVO = entity.getValue('name');
  assert(nameVO instanceof I18NValue, 'getValue("name") 返回 I18NValue');
  assert((nameVO as I18NValue).get('zh') === '测试', 'I18NValue.get("zh") = "测试"');

  const ageVO = entity.getValue('age');
  assert(ageVO instanceof IntValue, 'getValue("age") 返回 IntValue');
  assert(ageVO!.getData() === 42, 'IntValue.getData() = 42');

  const bioVO = entity.getValue('bio');
  assert(bioVO instanceof StringValue, 'getValue("bio") 返回 StringValue');

  const metaVO = entity.getValue('meta');
  assert(metaVO instanceof JsonValue, 'getValue("meta") 返回 JsonValue');

  const missing = entity.getValue('nonexistent');
  assert(missing === undefined, 'getValue("nonexistent") = undefined');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 12. Color type — insert validation + ValueObject
// ---------------------------------------------------------------------------
async function auditColorType(): Promise<void> {
  console.log('\n═══ 12. Color type — insert validation + ValueObject ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('ColorModel', { color: 'Color', label: 'String' });
  const m = engine.model('ColorModel');

  const hexRecord = await m.insert({ color: '#ff8800', label: 'orange' });
  assert(hexRecord._id !== undefined, 'hex color 插入成功');

  const rgbaRecord = await m.insert({
    color: { r: 0, g: 128, b: 255, a: 0.5 },
    label: 'blue-alpha',
  });
  assert(rgbaRecord._id !== undefined, 'RGBA object 插入成功');

  await assertRejects(
    () => m.insert({ color: 'not-hex' }),
    ValidationError,
    'Color 拒绝无效 hex 字符串',
  );

  await assertRejects(() => m.insert({ color: 12345 }), ValidationError, 'Color 拒绝数字');

  const results = await m.query().where('label', 'eq', 'orange').execute();
  assert(results.length === 1, 'Color query 命中 1 行');

  const colorVO = results[0]!.getValue('color');
  assert(colorVO instanceof ColorValue, 'getValue("color") 返回 ColorValue');
  const hex = (colorVO as ColorValue).toHex();
  assert(hex === '#ff8800', 'ColorValue.toHex() = "#ff8800"');
  const css = (colorVO as ColorValue).toCSS();
  assert(css === 'rgb(255, 136, 0)', 'ColorValue.toCSS() = "rgb(255, 136, 0)"');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 13. Unit type — insert validation + conversion
// ---------------------------------------------------------------------------
async function auditUnitType(): Promise<void> {
  console.log('\n═══ 13. Unit type — insert validation + conversion ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('UnitModel', { length: 'Unit', name: 'String' });
  const m = engine.model('UnitModel');

  const r = await m.insert({ length: { value: 100, unit: 'cm' }, name: 'bar' });
  assert(r._id !== undefined, 'Unit {value, unit} 插入成功');

  await assertRejects(() => m.insert({ length: 'not-a-unit' }), ValidationError, 'Unit 拒绝字符串');

  await assertRejects(
    () => m.insert({ length: { value: NaN, unit: 'm' } }),
    ValidationError,
    'Unit 拒绝 NaN value',
  );

  const results = await m.query().where('name', 'eq', 'bar').execute();
  assert(results.length === 1, 'Unit query 命中 1 行');

  const unitVO = results[0]!.getValue('length');
  assert(unitVO instanceof UnitValue, 'getValue("length") 返回 UnitValue');
  assert((unitVO as UnitValue).value === 100, 'UnitValue.value = 100');
  assert((unitVO as UnitValue).unit === 'cm', 'UnitValue.unit = "cm"');

  const inMeters = (unitVO as UnitValue).convertTo('m');
  assert(Math.abs(inMeters - 1) < 0.001, 'UnitValue.convertTo("m") ≈ 1');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// 14. getData(deep) — recursive unwrap
// ---------------------------------------------------------------------------
async function auditGetDataDeep(): Promise<void> {
  console.log('\n═══ 14. getData(deep) — recursive unwrap ═══');

  const engine = new AuthoringEngine({ atlas: ATLAS, currentLocale: 'zh' });

  engine.registerModel('Parent14', { name: 'String' });
  const parent = engine.model('Parent14');
  const p = await parent.insert({ name: 'root' });

  const shallow = (await parent.query().execute())[0]!;
  const shallowData = shallow.getData();
  assert(shallowData._id === p._id, 'getData() 返回原始 record');

  const deepData = shallow.getData(true);
  assert(deepData._id === p._id, 'getData(true) 包含 _id');

  await engine.flushAll();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const atlasDir = join(DATA_ROOT, ATLAS);
  if (existsSync(atlasDir)) {
    await rm(atlasDir, { recursive: true, force: true });
  }

  auditDataTypeConstants();
  await auditUpdateFields();
  await auditInsertValidation();
  await auditI18NInsert();
  await auditI18NQuery();
  await auditMldSchemaHeader();
  await auditManifestFieldTypes();
  await auditBackwardCompat();
  await auditI18NNoLocale();
  await auditEngineRegisterTyped();
  await auditValueObject();
  await auditColorType();
  await auditUnitType();
  await auditGetDataDeep();

  console.log(
    `\n${'═'.repeat(60)}\n  datatype_audit 结果：通过 ${passed}，失败 ${failed}\n${'═'.repeat(60)}\n`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main();
