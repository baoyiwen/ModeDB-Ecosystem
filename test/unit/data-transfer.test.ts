import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { RemoteModelDBClient } from '@mode-db/sdk';
import { TRANSFER_FORMAT, TransferError, transferRecordKey, validateTransferPackage, type TransferModel, type TransferPackage, type TransferRelation } from '@mode-db/data-kit';
import { collectModelTransfer, preflightModelTransfer } from '../../apps/model-designer/src/data-transfer/model-transfer.js';
import { readTransferWorkbook, transferSheetName, writeTransferWorkbook } from '../../apps/model-designer/src/data-transfer/workbook.js';
import zh from '../../apps/model-designer/src/i18n/locales/zh/ui.json';
import en from '../../apps/model-designer/src/i18n/locales/en/ui.json';
import ja from '../../apps/model-designer/src/i18n/locales/ja/ui.json';

const ExcelJS = createRequire(new URL('../../apps/model-designer/package.json', import.meta.url))('exceljs');
const JSZip = createRequire(createRequire(new URL('../../apps/model-designer/package.json', import.meta.url)).resolve('exceljs'))('jszip');
const t = (key: string): string => (zh as Record<string, string>)[key] ?? key;
const model: TransferModel = { name: 'Node', label: '节点', sheet: 'Node', fields: [
  { name: 'name', label: '名称', type: 'I18N', required: true },
  { name: 'code', label: '编号', type: 'String' },
  { name: 'count', label: '数量', type: 'Int' },
  { name: 'active', label: '启用', type: 'Boolean' },
  { name: 'payload', label: '数据', type: 'JSON' },
  { name: 'distance', label: '距离', type: 'Unit' },
] };
const relation: TransferRelation = { source: 'Node', target: 'Node', forward: 'children', reverse: 'parent', selfLoopPolicy: 'deny' };
function pack(): TransferPackage {
  return { manifest: { format: TRANSFER_FORMAT, kind: 'data', database: 'fixture', createdAt: '2026-10-17T00:00:00.000Z', models: [model], relations: [relation] },
    rows: [{ model: 'Node', sheet: 'Node', row: 3, key: 'r1', id: '00012345678901234567890', values: { name: { zh: '北京', en: 'Beijing', ja: '北京' }, code: '=1+1', count: 0, active: false, payload: { nested: [null, 1, '🙂'] }, distance: { value: 12.5, unit: 'km' } } }], edges: [] };
}
const check = (data: TransferPackage, existingIds: ReadonlySet<string> = new Set(), relations = [relation]) => validateTransferPackage({ data, database: 'fixture', models: [model], relations, existingIds });
async function bytes(data = pack()): Promise<ArrayBuffer> { const value = await writeTransferWorkbook(data, t); return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); }
async function edit(mutate: (book: InstanceType<typeof ExcelJS.Workbook>) => void): Promise<ArrayBuffer> {
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await bytes()); mutate(book);
  const buffer = new Uint8Array(await book.xlsx.writeBuffer()); return buffer.buffer;
}

describe('data transfer workbook and import validation', () => {
  it('round-trips full language values, long text IDs, literal formulas and typed values', async () => {
    const source = pack(), parsed = await readTransferWorkbook(await bytes(source));
    assert.deepEqual(parsed.manifest, source.manifest);
    assert.equal(parsed.rows[0]?.id, source.rows[0]?.id);
    assert.deepEqual({ ...parsed.rows[0]?.values }, source.rows[0]?.values);
    assert.equal(check(parsed).valid, true);
    const existing = check(parsed, new Set([transferRecordKey('Node', source.rows[0]!.id!)]));
    assert.equal(existing.newRows, 0); assert.equal(existing.existingRows, 1);
  });
  it('round-trips large interface signatures and model metadata without truncation', async () => {
    const source = pack();
    const signature = JSON.stringify({ graph: 'a'.repeat(31_900) + '🙂\\boundary'.repeat(7_000) });
    const data: TransferPackage = {
      ...source,
      manifest: { ...source.manifest,
        interfaceSource: { callableName: 'nestedQuery', version: '1.0.0', signature, scope: 'returned-result' },
        models: [{ ...model, fields: model.fields.map((field) => ({ ...field, label: `${field.label}${'字段🙂'.repeat(7_000)}` })) }],
      }, paths: [],
    };
    const buffer = await bytes(data);
    const archive = await JSZip.loadAsync(buffer);
    const sharedXml = await archive.file('xl/sharedStrings.xml').async('string');
    assert.equal(sharedXml.includes('\uFFFD'), false, 'exported Unicode XML remains intact');
    const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer);
    const meta = book.getWorksheet('_modedb');
    assert.ok(meta.rowCount > 10);
    meta.eachRow((row: { eachCell: (visit: (cell: { value: unknown }) => void) => void }) => row.eachCell((cell) => {
      if (typeof cell.value === 'string') assert.ok(cell.value.length <= 32_767);
    }));
    const parsed = (await readTransferWorkbook(buffer)).manifest;
    assert.equal(parsed.interfaceSource!.signature === signature, true, 'full interface signature');
    for (let index = 0; index < model.fields.length; index++) {
      const actual = parsed.models[0]!.fields[index]!.label, expected = data.manifest.models[0]!.fields[index]!.label;
      assert.equal(actual === expected, true, `full field label ${index}`);
    }
    assert.deepEqual({ ...parsed, models: [], interfaceSource: undefined }, { ...data.manifest, models: [], interfaceSource: undefined });
  });
  it('preserves escaped metadata chunks at backslash and surrogate-pair boundaries', async () => {
    for (const boundary of ['\\', '🙂']) {
      const source = pack();
      const emptyHeader = JSON.stringify({ ...source.manifest, models: undefined, relations: undefined,
        interfaceSource: { callableName: 'q', version: '1', signature: '', scope: 'returned-result' }, overviewName: t('transferOverview') });
      const prefixLength = emptyHeader.indexOf('"signature":"') + '"signature":"'.length;
      const signature = 'a'.repeat(32_000 - prefixLength - (boundary === '🙂' ? 1 : 0)) + boundary + 'tail'.repeat(9_000);
      const data: TransferPackage = { ...source, manifest: { ...source.manifest,
        interfaceSource: { callableName: 'q', version: '1', signature, scope: 'returned-result' } }, paths: [] };
      assert.equal((await readTransferWorkbook(await bytes(data))).manifest.interfaceSource?.signature, signature);
    }
  });
  it('still reads the original two-column metadata representation', async () => {
    const buffer = await edit((book) => {
      const meta = book.getWorksheet('_modedb');
      for (let row = 1; row <= meta.rowCount; row++) {
        meta.getCell(row, 3).value = null;
        meta.getCell(row, 4).value = null;
      }
    });
    assert.deepEqual((await readTransferWorkbook(buffer)).manifest, pack().manifest);
  });
  for (const [label, mutate] of [
    ['missing chunk', (meta: any) => { meta.getCell('D2').value = 2; }],
    ['duplicate chunk', (meta: any) => { meta.getCell('C3').value = 0; }],
    ['inconsistent count', (meta: any) => { meta.getCell('D2').value = 2; meta.getCell('A3').value = 'manifest'; meta.getCell('C3').value = 2; }],
  ] as const) it(`rejects ${label} in chunked metadata`, async () => {
    await assert.rejects(readTransferWorkbook(await edit((book) => mutate(book.getWorksheet('_modedb')))),
      (error: unknown) => error instanceof TransferError && error.code === 'format' && error.location?.sheet === '_modedb');
  });
  it('uses one table filter per range and legal case-insensitive unique table headings', async () => {
    const source = pack();
    const labels = ['NAME', 'name', 'name (2)', 'NAME', '长🙂'.repeat(200), '长🙂'.repeat(200)];
    const data = { ...source, manifest: { ...source.manifest, models: [{ ...model,
      fields: model.fields.map((field, i) => ({ ...field, required: false, label: labels[i]! })) }] } };
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await bytes(data));
    for (const sheetName of ['Node', '_relations']) {
      const sheet = book.getWorksheet(sheetName);
      assert.equal(sheet.autoFilter, undefined);
      const table = sheet.getTables()[0].table;
      const headings = table.columns.map((column: { name: string }) => column.name);
      assert.equal(new Set(headings.map((name: string) => name.toLowerCase())).size, headings.length);
      assert.ok(headings.every((name: string) => name.length > 0 && name.length <= 255));
      assert.ok(table.autoFilterRef);
    }
  });
  it('rejects oversized business values with the exact cell and length, without truncation', async () => {
    const source = pack();
    const data = { ...source, rows: [{ ...source.rows[0]!, values: { ...source.rows[0]!.values, code: 'x'.repeat(32_768) } }] };
    await assert.rejects(bytes(data), (error: unknown) => error instanceof TransferError && error.code === 'cellLimit'
      && error.location?.sheet === 'Node' && error.location.row === 3 && error.location.column === 'D3' && error.detail === '32768 > 32767');
  });
  it('preserves omitted, null, empty, leading backslash and primitive JSON values', async () => {
    for (const value of [undefined, null, '', '\\N', '\\E', '\\abc', 'plain', 0, false]) {
      const source = pack();
      const data = { ...source, rows: [{ ...source.rows[0]!, values: { name: { zh: '测试' }, code: typeof value === 'number' || typeof value === 'boolean' ? undefined : value, payload: value } }] };
      const parsed = await readTransferWorkbook(await bytes(data));
      assert.deepEqual(parsed.rows[0]?.values.payload, value);
      assert.deepEqual(parsed.rows[0]?.values.code, data.rows[0]!.values.code);
    }
  });
  it('creates empty templates and accepts a filled template row without an ID', async () => {
    const source = pack();
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await bytes({ ...source, manifest: { ...source.manifest, kind: 'template' }, rows: [] }));
    const empty = new Uint8Array(await book.xlsx.writeBuffer());
    assert.equal((await readTransferWorkbook(empty.buffer)).rows.length, 0);
    book.getWorksheet('Node').getCell('C3').value = '{"zh":"新节点","en":"New"}';
    const filled = new Uint8Array(await book.xlsx.writeBuffer());
    const result = check(await readTransferWorkbook(filled.buffer));
    assert.equal(result.valid, true); assert.equal(result.newRows, 1); assert.equal(result.existingRows, 0);
  });
  it('uses model unique names and safe, collision-free Excel sheet names', () => {
    const used = new Set(['history', '_modedb', '_relations']);
    assert.equal(transferSheetName('Node', used), 'Node');
    assert.equal(transferSheetName('node', used), 'node (2)');
    assert.equal(transferSheetName('A/B?C', used), 'A_B_C');
    assert.ok(transferSheetName('🙂'.repeat(30), used).length <= 31);
  });
  for (const [label, mutation, code, column] of [
    ['numeric ID', (b: InstanceType<typeof ExcelJS.Workbook>) => { b.getWorksheet('Node').getCell('B3').value = 123; }, 'text', 'B3'],
    ['formula', (b: InstanceType<typeof ExcelJS.Workbook>) => { b.getWorksheet('Node').getCell('D3').value = { formula: '1+1', result: 2 }; }, 'formula', 'D3'],
    ['unknown machine column', (b: InstanceType<typeof ExcelJS.Workbook>) => { b.getWorksheet('Node').getCell('I2').value = 'hidden'; }, 'columns', 'I2'],
    ['unmapped data', (b: InstanceType<typeof ExcelJS.Workbook>) => { b.getWorksheet('Node').getCell('I3').value = 'lost'; }, 'columns', 'I3'],
    ['invalid JSON', (b: InstanceType<typeof ExcelJS.Workbook>) => { b.getWorksheet('Node').getCell('C3').value = '{bad'; }, 'json', 'name'],
  ] as const) it(`rejects ${label} with an exact sheet and cell location`, async () => {
    await assert.rejects(readTransferWorkbook(await edit(mutation)), (error: unknown) => error instanceof TransferError && error.code === code && error.location?.sheet === 'Node' && error.location.column === column && error.location.row >= 2);
  });
  it('rejects missing model sheets, unexpected sheets and derived reports', async () => {
    await assert.rejects(readTransferWorkbook(await edit((b) => b.removeWorksheet(b.getWorksheet('Node').id))), (e: unknown) => e instanceof TransferError && e.code === 'missingSheet');
    await assert.rejects(readTransferWorkbook(await edit((b) => b.addWorksheet('Injected'))), (e: unknown) => e instanceof TransferError && e.code === 'format');
    const source = pack();
    await assert.rejects(readTransferWorkbook(await bytes({ ...source, manifest: { ...source.manifest, kind: 'report' } })), (e: unknown) => e instanceof TransferError && e.code === 'reportOnly');
  });
  it('accumulates duplicate keys/IDs, required fields and strict integer type issues', () => {
    const source = pack(), row = source.rows[0]!;
    const result = check({ ...source, rows: [row, { ...row, row: 4, values: { count: 1.5 } }] });
    assert.deepEqual(new Set(result.issues.map((issue) => issue.code)), new Set(['duplicateKey', 'duplicateId', 'required', 'type']));
    assert.ok(result.issues.every((issue) => issue.row === 4));
  });
  it('validates against actual schema instead of trusting modified workbook field types', () => {
    const source = pack();
    const result = check({ ...source, manifest: { ...source.manifest, models: [{ ...model, fields: [...model.fields.map((field) => field.name === 'count' ? { ...field, type: 'String' } : field), { name: '_createdAt', label: 'hidden', type: 'String' }] }] } });
    assert.deepEqual(result.issues.map((issue) => issue.code), ['schema', 'field']);
  });
  it('resolves forward row references and external database references', () => {
    const source = pack(), second = { ...source.rows[0]!, row: 4, key: 'r2', id: undefined };
    const edge = { ...relation, sheet: '_relations', row: 3, sourceRef: 'row:r2', targetRef: 'id:peer' };
    const data = { ...source, rows: [source.rows[0]!, second], edges: [edge] };
    assert.equal(check(data, new Set([transferRecordKey('Node', 'peer')])).valid, true);
    assert.equal(check(data).issues[0]?.column, 'targetRef');
  });
  it('detects self loops and duplicate relationships across row/id reference forms', () => {
    const source = pack(), edge = { ...relation, sheet: '_relations', row: 3, sourceRef: 'row:r1', targetRef: `id:${source.rows[0]!.id}` };
    assert.equal(check({ ...source, edges: [edge] }).issues[0]?.code, 'selfLoop');
    const data = { ...source, edges: [edge, { ...edge, row: 4, sourceRef: edge.targetRef }] };
    assert.deepEqual(check(data, new Set(), [{ ...relation, selfLoopPolicy: 'allow' }]).issues.map((issue) => issue.code), ['duplicateRelation']);
  });
  it('does not accept a relation just because its forward name matches', () => {
    const source = pack();
    const result = check({ ...source, edges: [{ ...relation, target: 'Other', sheet: '_relations', row: 3, sourceRef: 'row:r1', targetRef: 'id:missing' }] });
    assert.equal(result.issues[0]?.code, 'relation');
  });
  it('provides the same complete translation key set in Chinese, English and Japanese', () => {
    const keys = Object.keys(zh).filter((key) => key.startsWith('transfer'));
    for (const locale of [en, ja]) for (const key of keys) assert.ok((locale as Record<string, string>)[key], key);
    assert.ok(keys.length > 70);
  });
});

describe('data transfer read-only adapter', () => {
  it('refuses inherited endpoint relations that this phase cannot export completely', async () => {
    const client = { model: () => { throw new Error('No query permitted'); } } as unknown as Pick<RemoteModelDBClient, 'model'>;
    await assert.rejects(collectModelTransfer({ client, database: 'fixture', model, relations: [{ ...relation, source: 'Base', target: 'Other' }], ancestors: ['Base'], filters: [] }), (error: unknown) => error instanceof TransferError && error.code === 'inheritedRelation');
  });
  it('refuses truncated query results instead of exporting a silent first page', async () => {
    const client = { model: () => ({ query: () => ({ execute: async () => ({ total: 10002, items: [{ _id: 'first', name: { zh: '测试' } }] }) }) }) } as unknown as Pick<RemoteModelDBClient, 'model'>;
    await assert.rejects(collectModelTransfer({ client, database: 'fixture', model, relations: [], filters: [] }), (error: unknown) => error instanceof TransferError && error.code === 'limit');
  });
  it('rejects invalid filters before sending any query', async () => {
    const client = { model: () => ({ query: () => ({ execute: async () => { throw new Error('Unexpected execution'); } }) }) } as unknown as Pick<RemoteModelDBClient, 'model'>;
    for (const filter of [{ field: 'count', op: 'eq' as const, value: '1.5' }, { field: 'active', op: 'eq' as const, value: 'yes' }]) {
      await assert.rejects(collectModelTransfer({ client, database: 'fixture', model, relations: [], filters: [filter] }), (error: unknown) => error instanceof TransferError && error.code === 'filter');
    }
  });
  it('deduplicates and batches record and relationship existence lookups per model', async () => {
    const source = pack(), ids = Array.from({ length: 2001 }, (_, i) => `id${i}`), calls: string[][] = [];
    const client = { model: () => ({ query: (chunk: string[]) => ({ execute: async () => { calls.push(chunk); return chunk.map((_id) => ({ _id })); } }) }) } as unknown as Pick<RemoteModelDBClient, 'model'>;
    const rows = ids.map((id, i) => ({ ...source.rows[0]!, id, key: `r${i}`, row: i + 3 }));
    const edges = ids.slice(1).map((id, i) => ({ ...relation, sheet: '_relations', row: i + 3, sourceRef: 'id:id0', targetRef: `id:${id}` }));
    const result = await preflightModelTransfer({ client, database: 'fixture', data: { ...source, rows, edges }, models: [model], relations: [relation] });
    assert.equal(result.valid, true); assert.equal(result.existingRows, 2001);
    assert.deepEqual(calls.map((chunk) => chunk.length), [2000, 1]);
  });
  it('does not query data for a blank template, and observes cancellation', async () => {
    const client = { model: () => { throw new Error('No query permitted'); } } as unknown as Pick<RemoteModelDBClient, 'model'>;
    const input = { client, database: 'fixture', model, relations: [relation], filters: [] };
    assert.equal((await collectModelTransfer({ ...input, template: true })).rows.length, 0);
    await assert.rejects(collectModelTransfer({ ...input, signal: AbortSignal.abort() }), (e: unknown) => e instanceof TransferError && e.code === 'cancelled');
  });
});
