import ExcelJS from 'exceljs';
import { transferSheetName } from './sheet-name.js';
export { transferSheetName } from './sheet-name.js';
import { toStoredDateTime } from '../pivot/date-time.js';
import {
  TRANSFER_FORMAT,
  TRANSFER_MAX_BYTES,
  TRANSFER_MAX_EDGES,
  TRANSFER_MAX_ROWS,
  TransferError,
  type TransferEdge,
  type TransferField,
  type TransferManifest,
  type TransferModel,
  type TransferPackage,
  type TransferRow,
} from '@mode-db/data-kit';

export type TransferTranslate = (key: string, values?: Record<string, string>) => string;
const META = '_modedb';
const EDGES = '_relations';
const PATHS = '_paths';
const META_MAX_ROWS = 5_000;
const META_CHUNK_LENGTH = 32_000;
const pathColumns = ['path', 'parentPath', 'nodeId', 'model', 'key'] as const;
const edgeColumns = ['source', 'target', 'forward', 'reverse', 'sourceRef', 'targetRef'] as const;

function cellValue(value: unknown): ExcelJS.CellValue {
  if (value === undefined) return null;
  if (value === null) return '\\N';
  if (value === '') return '\\E';
  if (typeof value === 'string') return value.startsWith('\\') ? `\\${value}` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function styleSheet(
  sheet: ExcelJS.Worksheet,
  labels: string[],
  keys: string[],
  widths: number[],
): void {
  sheet.views = [{ state: 'frozen', ySplit: 2, xSplit: 2, showGridLines: false }];
  sheet.columns = widths.map((width) => ({ width }));
  sheet.getRow(1).values = labels;
  sheet.getRow(2).values = keys;
  sheet.getRow(2).hidden = true;
  sheet.getRow(1).height = 32;
  sheet.properties.defaultRowHeight = 25;
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF1E293B' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FF94A3B8' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    };
  });
}

function writeDataRow(sheet: ExcelJS.Worksheet, values: unknown[]): void {
  const converted = values.map(cellValue);
  const oversized = converted.findIndex(
    (value) => typeof value === 'string' && value.length > 32_767,
  );
  if (oversized !== -1) {
    const row = sheet.rowCount + 1;
    throw new TransferError(
      'cellLimit',
      { sheet: sheet.name, row, column: sheet.getRow(row).getCell(oversized + 1).address },
      `${String(converted[oversized]).length} > 32767`,
    );
  }
  const row = sheet.addRow(converted);
  row.height = 28;
  for (let column = 1; column <= Math.max(sheet.columnCount, values.length); column++) {
    const cell = row.getCell(column);
    cell.font = { name: 'Arial', size: 10, color: { argb: 'FF1E293B' } };
    cell.alignment = {
      vertical: 'middle',
      horizontal: typeof cell.value === 'number' ? 'right' : 'left',
    };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    };
    if (row.number % 2 === 0)
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
  }
}

/** Never split a UTF-16 surrogate pair when fitting Excel's character limits. */
function textPrefix(value: string, length: number): string {
  const end = Math.min(length, value.length);
  return value.slice(0, end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!) ? end - 1 : end);
}

function writeMetadata(sheet: ExcelJS.Worksheet, kind: string, value: unknown): void {
  // Machine metadata uses JSON Unicode escapes so the XLSX ZIP encoder cannot
  // split surrogate pairs at its own stream boundaries. JSON.parse restores
  // the original characters; visible model data is not transformed.
  let json = JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const chunks: string[] = [];
  while (json.length) {
    const chunk = textPrefix(json, META_CHUNK_LENGTH);
    chunks.push(chunk);
    json = json.slice(chunk.length);
  }
  if (sheet.rowCount + chunks.length > META_MAX_ROWS) throw new TransferError('limit');
  chunks.forEach((chunk, index) => writeDataRow(sheet, [kind, chunk, index + 1, chunks.length]));
}

function addStructuredTable(sheet: ExcelJS.Worksheet, name: string): void {
  if (sheet.columnCount === 0) return;
  const labels = Array.from({ length: sheet.columnCount }, (_, index) =>
    String(sheet.getCell(1, index + 1).value ?? ''),
  );
  const seen = new Set<string>();
  const columns = labels.map((label, index) => {
    const base = label.trim() || String(index + 1);
    let name = textPrefix(base, 255);
    let suffix = 1;
    while (seen.has(name.toLowerCase())) {
      const ending = ` (${++suffix})`;
      name = `${textPrefix(base, 255 - ending.length)}${ending}`;
    }
    seen.add(name.toLowerCase());
    return { name, filterButton: true };
  });
  sheet.addTable({
    name,
    ref: 'A1',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleLight9', showRowStripes: true },
    columns,
    rows: Array.from({ length: Math.max(2, sheet.rowCount) - 1 }, (_, index) =>
      Array.from(
        { length: columns.length },
        (_, column) => sheet.getCell(index + 2, column + 1).value,
      ),
    ),
  });
}

/** ExcelJS is the application's existing browser exporter; no sheet protection is trusted. */
export async function writeTransferWorkbook(
  data: TransferPackage,
  t: TransferTranslate,
): Promise<Uint8Array<ArrayBuffer>> {
  if (data.rows.length > TRANSFER_MAX_ROWS || data.edges.length > TRANSFER_MAX_EDGES)
    throw new TransferError('limit');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ModeDB';
  const overviewName = transferSheetName(
    t('transferOverview'),
    new Set([
      'history',
      META,
      PATHS,
      EDGES,
      ...data.manifest.models.map((model) => model.sheet.toLowerCase()),
    ]),
  );
  const overview = workbook.addWorksheet(overviewName, { views: [{ showGridLines: false }] });
  overview.columns = [{ width: 30 }, { width: 48 }, { width: 20 }];
  overview.getCell('A2').value = t('transferTitle');
  overview.getCell('A2').font = { name: 'Arial', size: 14, bold: true };
  overview.getRow(2).height = 28;
  overview.addRow([t('transferDatabase'), data.manifest.database]);
  overview.addRow([t('transferCreated'), new Date(data.manifest.createdAt)]);
  overview.getCell('B4').numFmt = 'yyyy-mm-dd hh:mm:ss';
  overview.addRow([
    t('transferKind'),
    t(
      data.manifest.kind === 'report'
        ? 'transferReport'
        : data.manifest.kind === 'template'
          ? 'transferTemplate'
          : 'transferData',
    ),
  ]);
  overview.addRow([t('transferInstructions')]);
  overview.mergeCells('A6:C6');
  overview.getCell('A6').alignment = { wrapText: true, vertical: 'top' };
  overview.getRow(6).height = 82;
  overview.getCell('A6').font = { name: 'Arial', size: 10 };
  overview.addRow([t('transferModel'), t('transferSheet'), t('transferRows')]);
  for (const model of data.manifest.models) {
    overview.addRow([
      `${model.label} [${model.name}]`,
      model.sheet,
      data.rows.filter((row) => row.model === model.name).length,
    ]);
    const sheet = workbook.addWorksheet(model.sheet);
    sheet.properties.tabColor = { argb: 'FF64748B' };
    const keys = ['_key', '_id', ...model.fields.map((field) => field.name)];
    styleSheet(
      sheet,
      [
        t('transferRowKey'),
        t('transferRecordId'),
        ...model.fields.map((field) => `${field.label}${field.required ? ' *' : ''}`),
      ],
      keys,
      [
        12,
        26,
        ...model.fields.map((field) =>
          field.type === 'I18N' || field.type === 'JSON'
            ? 36
            : field.type === 'Boolean'
              ? 14
              : field.type === 'DateTime'
                ? 28
                : 22,
        ),
      ],
    );
    sheet.getColumn(1).hidden = true;
    sheet.getColumn(1).numFmt = '@';
    sheet.getColumn(2).numFmt = '@';
    model.fields.forEach((field, index) => {
      if (['String', 'DateTime', 'I18N', 'JSON', 'Unit', 'Color'].includes(field.type))
        sheet.getColumn(index + 3).numFmt = '@';
    });
    for (const row of data.rows.filter((row) => row.model === model.name)) {
      writeDataRow(sheet, [
        row.key,
        row.id,
        ...model.fields.map((field) => {
          const value = row.values[field.name];
          if (field.type === 'DateTime' && typeof value === 'string')
            return value.replace(/^(\d{4}-\d{2}-\d{2})T/, '$1 ');
          return field.type === 'JSON' && value !== null && value !== undefined
            ? JSON.stringify(value)
            : value;
        }),
      ]);
    }
    if (data.manifest.kind === 'template') {
      for (let i = 0; i < 20; i++) {
        const row = sheet.getRow(i + 3);
        row.height = 28;
        for (let col = 3; col <= keys.length; col++) {
          row.getCell(col).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFF8E6' },
          };
          row.getCell(col).border = {
            bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          };
          const field = model.fields[col - 3];
          if (field?.type === 'Boolean')
            row.getCell(col).dataValidation = {
              type: 'list',
              allowBlank: true,
              formulae: ['"true,false"'],
            };
        }
      }
    }
    // The structured table owns filtering. An overlapping worksheet autoFilter
    // makes Excel repair the file by removing the table definition.
    addStructuredTable(sheet, `ModelData${data.manifest.models.indexOf(model) + 1}`);
  }
  const relations = workbook.addWorksheet(EDGES);
  styleSheet(
    relations,
    edgeColumns.map((column) => t(`transferEdge_${column}`)),
    [...edgeColumns],
    [28, 28, 24, 24, 42, 42],
  );
  for (const edge of data.edges)
    writeDataRow(
      relations,
      edgeColumns.map((column) => edge[column]),
    );
  relations.properties.tabColor = { argb: 'FF94A3B8' };
  addStructuredTable(relations, 'RelationData');
  if (data.manifest.interfaceSource) {
    overview.addRow([]);
    overview.addRow([
      t('transferInterfaceSource'),
      `${data.manifest.interfaceSource.callableName} v${data.manifest.interfaceSource.version}`,
    ]);
    overview.addRow([t('transferScope'), t('transferInterfaceScope')]);
    if (data.manifest.kind === 'report')
      overview.addRow([t('transferReport'), t('transferInterfaceReportHint')]);
  }
  if (data.paths) {
    if (data.paths.length > 100_000) throw new TransferError('limit');
    const paths = workbook.addWorksheet(PATHS, { state: 'hidden' });
    styleSheet(
      paths,
      pathColumns.map((column) => t(`transferPath_${column}`)),
      [...pathColumns],
      [65, 65, 30, 28, 20],
    );
    for (const path of data.paths)
      writeDataRow(
        paths,
        pathColumns.map((column) => path[column]),
      );
  }
  const meta = workbook.addWorksheet(META, { state: 'hidden' });
  meta.addRow(['kind', 'json', 'part', 'parts']);
  const { models, relations: definitions, ...header } = data.manifest;
  writeMetadata(meta, 'manifest', { ...header, overviewName });
  for (const model of models) writeMetadata(meta, 'model', model);
  for (const relation of definitions) writeMetadata(meta, 'relation', relation);
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  if (bytes.byteLength > TRANSFER_MAX_BYTES) throw new TransferError('limit');
  return bytes;
}

function plainCell(cell: ExcelJS.Cell): string | number | boolean | Date | null | undefined {
  const value = cell.value;
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  )
    return value;
  throw new TransferError('formula', {
    sheet: cell.worksheet.name,
    row: Number(cell.row),
    column: cell.address,
  });
}

function textCell(cell: ExcelJS.Cell): string {
  const value = plainCell(cell);
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string')
    throw new TransferError('text', {
      sheet: cell.worksheet.name,
      row: Number(cell.row),
      column: cell.address,
    });
  return value;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeCell(cell: ExcelJS.Cell, field: TransferField): unknown {
  const value = plainCell(cell);
  if (value === null || value === undefined || value === '') return undefined;
  if (value === '\\N') return null;
  if (value === '\\E') return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') return value;
  if (value.startsWith('\\\\')) return value.slice(1);
  if (
    ['JSON', 'I18N', 'Unit'].includes(field.type) ||
    (field.type === 'Color' && value.startsWith('{'))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      throw new TransferError('json', {
        sheet: cell.worksheet.name,
        row: Number(cell.row),
        column: field.name,
      });
    }
  }
  if (field.type === 'Int' || field.type === 'Number')
    return value.trim() && Number.isFinite(Number(value)) ? Number(value) : value;
  if (field.type === 'Boolean' && /^(true|false)$/i.test(value))
    return value.toLowerCase() === 'true';
  if (field.type === 'DateTime') {
    const stored = toStoredDateTime(value);
    if (!stored)
      throw new TransferError('date', {
        sheet: cell.worksheet.name,
        row: Number(cell.row),
        column: field.name,
      });
    return stored;
  }
  return value;
}

function columnMap(sheet: ExcelJS.Worksheet, expected: string[]): Map<string, number> {
  const columns = new Map<string, number>();
  sheet.getRow(2).eachCell((cell, col) => {
    const name = textCell(cell);
    if (!expected.includes(name) || columns.has(name))
      throw new TransferError('columns', { sheet: sheet.name, row: 2, column: cell.address }, name);
    columns.set(name, col);
  });
  if (columns.size !== expected.length)
    throw new TransferError('columns', { sheet: sheet.name, row: 2 });
  return columns;
}

function checkExtraCells(
  sheet: ExcelJS.Worksheet,
  row: number,
  columns: ReadonlyMap<string, number>,
): void {
  const allowed = new Set(columns.values());
  sheet.getRow(row).eachCell((cell, column) => {
    if (!allowed.has(column) && plainCell(cell) !== '')
      throw new TransferError('columns', { sheet: sheet.name, row, column: cell.address });
  });
}

/** Strict parsing retains Excel locations for all subsequent preflight diagnostics. */
export async function readTransferWorkbook(bytes: ArrayBuffer): Promise<TransferPackage> {
  if (bytes.byteLength > TRANSFER_MAX_BYTES) throw new TransferError('limit');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes);
  } catch {
    throw new TransferError('format');
  }
  if (workbook.worksheets.length > 104) throw new TransferError('limit');
  const meta = workbook.getWorksheet(META);
  if (!meta || meta.rowCount > META_MAX_ROWS) throw new TransferError('format');
  const chunked =
    textCell(meta.getCell(1, 3)) === 'part' && textCell(meta.getCell(1, 4)) === 'parts';
  if (!chunked && (meta.getCell(1, 3).value != null || meta.getCell(1, 4).value != null))
    throw new TransferError('format', { sheet: META, row: 1 });
  const entries: { kind: string; value: Record<string, unknown> }[] = [];
  for (let i = 2; i <= meta.rowCount; i++) {
    try {
      const kind = textCell(meta.getCell(i, 1));
      let json = '';
      if (chunked) {
        const parts = plainCell(meta.getCell(i, 4));
        if (
          typeof parts !== 'number' ||
          !Number.isInteger(parts) ||
          parts < 1 ||
          i + parts - 1 > meta.rowCount
        )
          throw new Error();
        for (let part = 1; part <= parts; part++) {
          const row = i + part - 1;
          if (
            textCell(meta.getCell(row, 1)) !== kind ||
            plainCell(meta.getCell(row, 3)) !== part ||
            plainCell(meta.getCell(row, 4)) !== parts
          )
            throw new Error();
          const chunk = decodeCell(meta.getCell(row, 2), {
            name: 'json',
            label: 'json',
            type: 'String',
          });
          if (typeof chunk !== 'string' || !chunk.length || chunk.length > META_CHUNK_LENGTH)
            throw new Error();
          json += chunk;
        }
        i += parts - 1;
      } else json = textCell(meta.getCell(i, 2));
      const value: unknown = JSON.parse(json);
      if (!object(value)) throw new Error();
      entries.push({ kind, value });
    } catch (error) {
      if (error instanceof TransferError) throw error;
      throw new TransferError('format', { sheet: META, row: i });
    }
  }
  const headers = entries.filter((entry) => entry.kind === 'manifest');
  const header = headers[0]?.value;
  if (
    headers.length !== 1 ||
    !header ||
    header.format !== TRANSFER_FORMAT ||
    !['data', 'template', 'report'].includes(String(header.kind)) ||
    typeof header.database !== 'string' ||
    typeof header.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(header.createdAt))
  )
    throw new TransferError('format');
  if (header.kind === 'report') throw new TransferError('reportOnly');
  const source = header.interfaceSource;
  if (
    source !== undefined &&
    (!object(source) ||
      !['callableName', 'version', 'signature'].every((key) => typeof source[key] === 'string') ||
      source.scope !== 'returned-result')
  )
    throw new TransferError('format');
  const models = entries
    .filter((entry) => entry.kind === 'model')
    .map(({ value }): TransferModel => {
      if (
        typeof value.name !== 'string' ||
        typeof value.sheet !== 'string' ||
        typeof value.label !== 'string' ||
        !Array.isArray(value.fields) ||
        value.fields.length > 500 ||
        !value.fields.every(
          (field: unknown) =>
            object(field) &&
            typeof field.name === 'string' &&
            typeof field.type === 'string' &&
            typeof field.label === 'string',
        )
      )
        throw new TransferError('format');
      return value as unknown as TransferModel;
    });
  if (
    !models.length ||
    models.length > 100 ||
    new Set(models.map((model) => model.name)).size !== models.length ||
    new Set(models.map((model) => model.sheet.toLowerCase())).size !== models.length
  )
    throw new TransferError('format');
  const definitions = entries
    .filter((entry) => entry.kind === 'relation')
    .map(({ value }) => {
      if (
        !['source', 'target', 'forward', 'reverse'].every((key) => typeof value[key] === 'string')
      )
        throw new TransferError('format');
      return value as unknown as TransferManifest['relations'][number];
    });
  if (typeof header.overviewName !== 'string' || !workbook.getWorksheet(header.overviewName))
    throw new TransferError('format');
  const reserved = new Set([META, EDGES, PATHS, header.overviewName.toLowerCase()]);
  const allowedSheets = new Set([
    META,
    EDGES,
    header.overviewName,
    ...(source ? [PATHS] : []),
    ...models.map((model) => model.sheet),
  ]);
  if (
    models.some((model) => reserved.has(model.sheet.toLowerCase())) ||
    workbook.worksheets.some((sheet) => !allowedSheets.has(sheet.name))
  )
    throw new TransferError('format');
  const rows: TransferRow[] = [];
  for (const model of models) {
    const sheet = workbook.getWorksheet(model.sheet);
    if (!sheet) throw new TransferError('missingSheet', { sheet: model.sheet, row: 1 });
    if (sheet.rowCount > TRANSFER_MAX_ROWS + 2) throw new TransferError('limit');
    const columns = columnMap(sheet, ['_key', '_id', ...model.fields.map((field) => field.name)]);
    for (let i = 3; i <= sheet.rowCount; i++) {
      checkExtraCells(sheet, i, columns);
      const id = textCell(sheet.getCell(i, columns.get('_id')!));
      const values: Record<string, unknown> = Object.create(null);
      for (const field of model.fields) {
        const value = decodeCell(sheet.getCell(i, columns.get(field.name)!), field);
        if (value !== undefined) values[field.name] = value;
      }
      const key = textCell(sheet.getCell(i, columns.get('_key')!)) || `r${i - 2}`;
      if (!id && Object.keys(values).length === 0) continue;
      rows.push({
        sheet: sheet.name,
        row: i,
        model: model.name,
        key,
        ...(id ? { id } : {}),
        values,
      });
      if (rows.length > TRANSFER_MAX_ROWS) throw new TransferError('limit');
    }
  }
  const edgeSheet = workbook.getWorksheet(EDGES);
  if (!edgeSheet) throw new TransferError('missingSheet', { sheet: EDGES, row: 1 });
  if (edgeSheet.rowCount > TRANSFER_MAX_EDGES + 2) throw new TransferError('limit');
  const edgeMap = columnMap(edgeSheet, [...edgeColumns]);
  const edges: TransferEdge[] = [];
  for (let i = 3; i <= edgeSheet.rowCount; i++) {
    checkExtraCells(edgeSheet, i, edgeMap);
    const values = Object.fromEntries(
      edgeColumns.map((column) => [column, textCell(edgeSheet.getCell(i, edgeMap.get(column)!))]),
    );
    if (Object.values(values).every((value) => !value)) continue;
    edges.push({ ...values, sheet: EDGES, row: i } as unknown as TransferEdge);
  }
  const paths: NonNullable<TransferPackage['paths']>[number][] = [];
  if (source) {
    const sheet = workbook.getWorksheet(PATHS);
    if (!sheet) throw new TransferError('missingSheet', { sheet: PATHS, row: 1 });
    if (sheet.rowCount > 100_002) throw new TransferError('limit');
    const columns = columnMap(sheet, [...pathColumns]);
    for (let row = 3; row <= sheet.rowCount; row++) {
      checkExtraCells(sheet, row, columns);
      const value = Object.fromEntries(
        pathColumns.map((column) => {
          const cell = sheet.getCell(row, columns.get(column)!);
          const text = decodeCell(cell, { name: column, label: column, type: 'String' });
          if (text !== undefined && typeof text !== 'string')
            throw new TransferError('text', { sheet: PATHS, row, column });
          return [column, text ?? ''];
        }),
      );
      if (Object.values(value).every((item) => !item)) continue;
      paths.push(value as unknown as (typeof paths)[number]);
    }
  }
  return {
    manifest: {
      format: TRANSFER_FORMAT,
      kind: header.kind as 'data' | 'template',
      database: header.database,
      createdAt: header.createdAt,
      models,
      relations: definitions,
      ...(source
        ? { interfaceSource: source as unknown as NonNullable<TransferManifest['interfaceSource']> }
        : {}),
    },
    rows,
    edges,
    ...(source ? { paths } : {}),
  };
}
