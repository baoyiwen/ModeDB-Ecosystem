import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { exportModelMapExcel } from '../../apps/model-designer/src/model-map/export-model-map.js';
import { I18nManager } from '../../apps/model-designer/src/managers/i18n-manager.js';
import {
  buildModelMap,
  filterModelMap,
  matchesModelMapField,
} from '../../apps/model-designer/src/model-map/model-map.js';
import type { EngineModelNode } from '../../apps/model-designer/src/types/engine-schema.js';
import type { PropObject } from '../../apps/model-designer/src/types/prop-object.js';
import enUi from '../../apps/model-designer/src/i18n/locales/en/ui.json';
import zhUi from '../../apps/model-designer/src/i18n/locales/zh/ui.json';
import jaUi from '../../apps/model-designer/src/i18n/locales/ja/ui.json';

function field(name: string, patch: Partial<PropObject> = {}): PropObject {
  return { id: name, name, type: 'String', is_primary: false, encrypt_level: 0, metadata: {}, ...patch };
}

function model(id: string, patch: Partial<EngineModelNode> = {}): EngineModelNode {
  return { id, model_name: id, parent_id: null, props_objects_array: [], ...patch };
}

describe('Model Map directory', () => {
  it('resolves display names and descriptions without changing source metadata', () => {
    const models = [model('station', {
      name_i18n: { zh: '车站', en: 'Station', ja: '駅' },
      description_i18n: { zh: '车站简介', en: 'Station description' },
      props_objects_array: [field('code', {
        name_i18n: { zh: '编号', en: 'Code', ja: 'コード' },
        description_i18n: { zh: '车站编号', en: 'Station code' },
        is_primary: true,
        is_required: true,
      })],
    })];
    const original = structuredClone(models);
    const zh = buildModelMap(models, 'zh')[0]!;
    const en = buildModelMap(models, 'en')[0]!;
    const ja = buildModelMap(models, 'ja')[0]!;
    assert.equal(zh.label, '车站');
    assert.equal(en.description, 'Station description');
    assert.equal(ja.label, '駅');
    assert.equal(ja.description, '车站简介');
    assert.equal(zh.fields[0]?.label, '编号');
    assert.equal(en.fields[0]?.description, 'Station code');
    assert.equal(ja.fields[0]?.label, 'コード');
    assert.equal(en.fields[0]?.prop.is_primary, true);
    assert.equal(en.fields[0]?.prop.is_required, true);
    assert.deepEqual(models, original);
  });

  it('includes multi-level inheritance once, in field order, with the defining model', () => {
    const models = [
      model('base', { props_objects_array: [field('title', { sort: 2 }), field('code', { sort: 1 })] }),
      model('station', { parent_id: 'base', props_objects_array: [field('code'), field('platforms')] }),
      model('hub', { parent_id: 'station', props_objects_array: [field('platforms'), field('capacity')] }),
    ];
    const entry = buildModelMap(models, 'en').find((item) => item.model.id === 'hub')!;
    assert.deepEqual(entry.fields.map((item) => item.prop.name), ['code', 'title', 'platforms', 'capacity']);
    assert.deepEqual(entry.fields.map((item) => item.ownerId), ['base', 'base', 'station', 'hub']);
    assert.equal(entry.parent?.id, 'station');
    assert.equal(entry.inheritanceIssue, undefined);
    assert.equal(models[0]?.props_objects_array[0]?.name, 'title');
  });

  it('searches localized names, unique names, descriptions and inherited fields', () => {
    const entries = buildModelMap([
      model('base', { props_objects_array: [field('code', { name_i18n: { en: 'Identifier' }, description_i18n: { en: 'Unique reference' } })] }),
      model('station', { name_i18n: { en: 'Station' }, description_i18n: { en: 'Passenger boarding' }, parent_id: 'base' }),
      model('route'),
    ], 'en');
    assert.equal(filterModelMap(entries, '   '), entries);
    assert.deepEqual(filterModelMap(entries, ' STATION ').map((item) => item.model.id), ['station']);
    assert.deepEqual(filterModelMap(entries, 'boarding').map((item) => item.model.id), ['station']);
    for (const term of ['code', 'IDENTIFIER', 'unique reference']) {
      assert.deepEqual(filterModelMap(entries, term).map((item) => item.model.id), ['base', 'station']);
    }
    assert.equal(matchesModelMapField(entries[0]!.fields[0]!, 'reference'), true);
    assert.deepEqual(filterModelMap(entries, 'no match'), []);
  });

  it('handles empty models, missing parents and inheritance cycles without inventing fields', () => {
    assert.deepEqual(buildModelMap([], 'zh'), []);
    const entries = buildModelMap([
      model('empty'),
      model('missing', { parent_id: 'deleted', props_objects_array: [field('known')] }),
      model('a', { parent_id: 'b', props_objects_array: [field('a_field')] }),
      model('b', { parent_id: 'a', props_objects_array: [field('b_field')] }),
    ], 'en');
    assert.deepEqual(entries.find((entry) => entry.model.id === 'empty')?.fields, []);
    assert.equal(entries.find((entry) => entry.model.id === 'missing')?.inheritanceIssue, 'missing-parent');
    assert.deepEqual(entries.find((entry) => entry.model.id === 'missing')?.fields.map((item) => item.prop.name), ['known']);
    const cyclic = entries.find((entry) => entry.model.id === 'a')!;
    assert.equal(cyclic.inheritanceIssue, 'cycle');
    assert.deepEqual(new Set(cyclic.fields.map((item) => item.prop.name)), new Set(['a_field', 'b_field']));
    assert.equal(cyclic.fields.length, 2);
  });

  it('falls back to unique names and sorts numbered model names naturally', () => {
    const entries = buildModelMap([model('Model10'), model('Model2', { props_objects_array: [field('unique_code')] })], 'en');
    assert.deepEqual(entries.map((entry) => entry.label), ['Model2', 'Model10']);
    assert.equal(entries[0]?.fields[0]?.label, 'unique_code');
  });

  it('provides matching Model Map translation keys and parameters for all interface languages', () => {
    const keys = Object.keys(enUi).filter((key) => key.startsWith('modelMap'));
    for (const bundle of [zhUi, jaUi]) {
      assert.deepEqual(Object.keys(bundle).filter((key) => key.startsWith('modelMap')), keys);
      for (const key of keys) {
        const value = (bundle as Record<string, string>)[key]!;
        assert.ok(value.trim(), key);
        assert.deepEqual(value.match(/\{\w+\}/g)?.sort(), (enUi as Record<string, string>)[key]!.match(/\{\w+\}/g)?.sort(), key);
      }
    }
  });
});

describe('Model Map Excel export', () => {
  const require = createRequire(new URL('../../apps/model-designer/package.json', import.meta.url));
  const ExcelJS = require('exceljs');

  it('round-trips all model and inherited field details as typed, localized workbook cells', async () => {
    const i18n = new I18nManager();
    i18n.setLocale('zh');
    const models = [
      model('base', { name_i18n: { zh: '基础资产' }, props_objects_array: [field('code', { name_i18n: { zh: '编号' }, description_i18n: { zh: '唯一编号' }, is_primary: true, is_required: true })] }),
      model('station', { name_i18n: { zh: '车站' }, parent_id: 'base', description_i18n: { zh: '车站简介\n第二行' }, props_objects_array: [field('platforms', { type: 'Int', name_i18n: { zh: '站台' } })] }),
      model('empty'),
    ];
    const entries = buildModelMap(models, i18n.locale);
    const original = structuredClone(models);
    const bytes = await exportModelMapExcel(entries, i18n, '铁路图谱');
    assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4b]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    assert.deepEqual(workbook.worksheets.map((sheet: { name: string }) => sheet.name), ['模型列表', ...entries.map((entry) => entry.model.model_name)]);
    const summary = workbook.worksheets[0];
    const station = workbook.getWorksheet('station');
    const base = workbook.getWorksheet('base');
    const empty = workbook.getWorksheet('empty');
    assert.equal(summary.rowCount, 8);
    assert.equal(station.rowCount, 3);
    assert.equal(base.rowCount, 2);
    assert.equal(empty.rowCount, 1);
    assert.equal(summary.getCell('A3').value, '铁路图谱');
    const summaryRows = summary.getRows(6, entries.length).map((row: { values: unknown[] }) => row.values.slice(1));
    assert.deepEqual(summaryRows.find((row: unknown[]) => row[1] === 'station'), ['车站', 'station', '车站简介\n第二行', '基础资产', 'base', 2, 'station']);
    assert.equal(station.getCell('A1').value, '字段名称');
    assert.deepEqual(station.getRow(2).values.slice(1), ['编号', 'code', '字符串', '唯一编号', '是', '是', '基础资产', 'base']);
    assert.equal(station.views[0].ySplit, 1);
    assert.equal(station.views[0].xSplit, 2);
    assert.equal(station.views[0].showGridLines, false);
    assert.equal(station.autoFilter, 'A1:H3');
    assert.equal(summary.autoFilter, 'A5:G8');
    assert.equal(summary.views[0].ySplit, 5);
    const emptyRow = summary.getRows(6, entries.length).find((row: { getCell: (column: number) => { value: unknown } }) => row.getCell(2).value === 'empty');
    assert.equal(emptyRow.getCell(6).value, 0);
    for (const column of [3, 4, 5]) assert.equal(emptyRow.getCell(column).value, null);
    assert.deepEqual(models, original);
  });

  it('preserves literal text, special characters, empty models and all three languages', async () => {
    const i18n = new I18nManager();
    for (const locale of ['zh', 'en', 'ja'] as const) {
      i18n.setLocale(locale);
      const entries = buildModelMap([model('=SUM(A1:A2)', { name_i18n: { zh: '模型 & <测试>', en: 'Model & <test>', ja: 'モデル & <テスト>' }, props_objects_array: [field('00123', { description_i18n: { en: '=1+1' } })] }), model('empty')], locale);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await exportModelMapExcel(entries, i18n, 'Graph'));
      assert.equal(workbook.worksheets.length, 3);
      const summary = workbook.worksheets[0];
      const row = summary.getRows(6, entries.length).find((row: { getCell: (column: number) => { value: unknown } }) => row.getCell(2).value === '=SUM(A1:A2)');
      const sheet = workbook.getWorksheet(row.getCell(7).value);
      assert.equal(summary.name, i18n.t('ui', 'modelMapDirectory'));
      assert.equal(sheet.name, '=SUM(A1_A2)');
      assert.equal(summary.getCell('A5').value, i18n.t('ui', 'modelMapModelName'));
      assert.equal(summary.getCell('G5').value, i18n.t('ui', 'modelMapExportSheetName'));
      assert.equal(sheet.getCell('A1').value, i18n.t('ui', 'modelMapExportFieldName'));
      assert.equal(sheet.rowCount, 2);
      assert.equal(sheet.getCell('B2').value, '00123');
      assert.equal(sheet.getCell('D2').value, '=1+1');
      assert.equal(sheet.getCell('D2').type, ExcelJS.ValueType.String);
      assert.equal(row.getCell(2).type, ExcelJS.ValueType.String);
      assert.ok(row.getCell(1).value.includes('& <'));
    }
  });

  it('names field sheets with unique model names and maps Excel name collisions in the first sheet', async () => {
    const i18n = new I18nManager();
    i18n.setLocale('en');
    const names = ['A/B', 'A:B', 'Same', 'same', 'History', "'Quoted'", "'".repeat(32), 'X'.repeat(31) + '1', 'X'.repeat(31) + '2', 'x'.repeat(30) + '🚂', i18n.t('ui', 'modelMapDirectory')];
    const models = names.map((name, index) => model(`model-${index}`, { model_name: name, name_i18n: { en: 'Shared display name' }, props_objects_array: [field(`field-${index}`)] }));
    const workbook = new ExcelJS.Workbook();
    const entries = buildModelMap(models, 'en');
    await workbook.xlsx.load(await exportModelMapExcel(entries, i18n, 'Graph'));
    const sheetNames = workbook.worksheets.map((sheet: { name: string }) => sheet.name);
    assert.equal(sheetNames.length, models.length + 1);
    assert.equal(new Set(sheetNames.map((name: string) => name.toLowerCase())).size, models.length + 1);
    for (const sheet of workbook.worksheets) {
      assert.ok(sheet.name.length > 0 && sheet.name.length <= 31);
      assert.doesNotMatch(sheet.name, /[\x00-\x1f\\/*?:[\]]|^'|'$|[\uD800-\uDBFF]$/);
      assert.notEqual(sheet.name.toLowerCase(), 'history');
    }
    const summary = workbook.worksheets[0];
    entries.forEach((entry, index) => {
      const row = summary.getRow(index + 6);
      assert.equal(row.getCell(1).value, entry.label);
      assert.equal(row.getCell(2).value, entry.model.model_name, 'Full unique model name is preserved in the summary');
      const sheet = workbook.getWorksheet(row.getCell(7).value);
      assert.notEqual(sheet, summary);
      assert.equal(sheet.rowCount, 2, 'Field sheets contain only the field table');
      assert.equal(sheet.getCell('B2').value, entry.fields[0]!.prop.name, 'No fields spill into another model sheet');
    });
    assert.notEqual(summary.name, i18n.t('ui', 'modelMapDirectory'), 'Summary name yields to an actual model unique name');
    assert.ok(workbook.getWorksheet(i18n.t('ui', 'modelMapDirectory')), 'A valid model unique name is used verbatim');
  });

  it('reports Excel cell limits instead of silently truncating descriptions', async () => {
    const i18n = new I18nManager();
    const entries = buildModelMap([model('large', { description_i18n: { en: 'x'.repeat(32_768) } })], 'en');
    await assert.rejects(exportModelMapExcel(entries, i18n, 'Graph'), /Excel/);
  });
});
