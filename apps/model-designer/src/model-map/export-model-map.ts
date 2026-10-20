import ExcelJS from 'exceljs';
import type { I18nManager } from '../managers/i18n-manager.js';
import { normalizeLegacyPropType, propDataTypeLabelKey } from '../config/engine-prop-types.js';
import { resolveModelDisplayName } from '../utils/i18n-resolve.js';
import type { ModelMapEntry } from './model-map.js';

type ExportCell = string | number;

function textWidth(value: string): number {
  return [...value].reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
}

function worksheetName(label: string, fallback: string, used: Set<string>): string {
  const trim = (value: string, length: number): string =>
    value
      .slice(0, length)
      .replace(/[\uD800-\uDBFF]$/, '')
      .replace(/^'+|'+$/g, '');
  const clean = (value: string): string => value.replace(/[\x00-\x1f\\/*?:[\]]/g, '_').trim();
  const base = trim(clean(label), 31) || trim(clean(fallback), 31) || 'Model';
  let name = base;
  for (let index = 2; used.has(name.toLowerCase()); index += 1) {
    const suffix = ` (${index})`;
    name = `${trim(base, 31 - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

/** A static schema dictionary. Strings stay literal, including names beginning with '='. */
export async function exportModelMapExcel(
  entries: readonly ModelMapEntry[],
  i18n: I18nManager,
  libraryLabel: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const t = (key: string): string => i18n.t('ui', key);
  if (entries.length === 0) throw new Error(t('modelMapEmpty'));
  if (libraryLabel.length > 32_767) throw new Error(t('modelMapExportLimit'));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ModeDB';
  workbook.title = `${t('modelMapTitle')} - ${libraryLabel}`;

  const byId = new Map(entries.map((entry) => [entry.model.id, entry.model]));
  // Excel reserves History and compares worksheet names without case sensitivity.
  const usedNames = new Set(['history']);
  const modelSheets = entries.map((entry) => ({
    entry,
    name: worksheetName(entry.model.model_name, 'Model', usedNames),
  }));
  const styleHeader = (header: ExcelJS.Row): void => {
    header.height = 30;
    header.eachCell((cell) => {
      cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    });
  };
  const writeRow = (
    sheet: ExcelJS.Worksheet,
    index: number,
    values: ExportCell[],
    widths: readonly number[],
  ): void => {
    if (values.some((value) => typeof value === 'string' && value.length > 32_767)) {
      throw new Error(t('modelMapExportLimit'));
    }
    const row = sheet.getRow(index);
    row.values = values.map((value) => (value === '' ? null : value));
    let lines = 1;
    row.eachCell((cell, column) => {
      cell.font = { name: 'Arial', size: 10, color: { argb: 'FF1E293B' } };
      cell.alignment = {
        vertical: 'top',
        horizontal: typeof cell.value === 'number' ? 'right' : 'left',
        wrapText: true,
      };
      if (typeof cell.value === 'number') cell.numFmt = '#,##0';
      const width = Math.max(1, (widths[column - 1] ?? 20) - 2);
      const cellLines = String(cell.value ?? '')
        .split(/\r?\n/)
        .reduce((count, line) => count + Math.max(1, Math.ceil(textWidth(line) / width)), 0);
      lines = Math.max(lines, cellLines);
    });
    row.height = Math.min(409, Math.max(26, lines * 15 + 8));
  };

  if (entries.length > 1_048_571) throw new Error(t('modelMapExportLimit'));
  const summaryWidths = [26, 30, 58, 26, 30, 16, 34];
  const summary = workbook.addWorksheet(
    worksheetName(t('modelMapDirectory'), 'Models', usedNames),
    { views: [{ state: 'frozen', xSplit: 2, ySplit: 5, showGridLines: false, topLeftCell: 'C6' }] },
  );
  summary.columns = summaryWidths.map((width) => ({ width }));
  summary.getCell('A2').value = t('modelMapDirectory');
  summary.getCell('A2').font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF1E293B' } };
  summary.getRow(2).height = 24;
  summary.getCell('A3').value = libraryLabel;
  summary.getCell('A3').font = { name: 'Arial', size: 10, color: { argb: 'FF64748B' } };
  summary.getRow(3).height = 22;
  summary.getRow(5).values = [
    t('modelMapModelName'),
    t('modelMapModelUniqueName'),
    t('modelMapIntroduction'),
    t('modelMapParent'),
    t('modelMapParentUniqueName'),
    t('modelMapFieldTotal'),
    t('modelMapExportSheetName'),
  ];
  styleHeader(summary.getRow(5));
  modelSheets.forEach(({ entry, name }, index) => {
    writeRow(
      summary,
      index + 6,
      [
        entry.label,
        entry.model.model_name,
        entry.description,
        entry.parent ? resolveModelDisplayName(entry.parent, i18n.locale) : '',
        entry.parent?.model_name ?? '',
        entry.fields.length,
        name,
      ],
      summaryWidths,
    );
  });
  summary.autoFilter = {
    from: { row: 5, column: 1 },
    to: { row: summary.rowCount, column: summaryWidths.length },
  };

  const widths = [26, 30, 18, 58, 14, 14, 26, 30];
  for (const { entry, name } of modelSheets) {
    if (entry.fields.length > 1_048_575) throw new Error(t('modelMapExportLimit'));
    const sheet = workbook.addWorksheet(name, {
      views: [{ state: 'frozen', xSplit: 2, ySplit: 1, showGridLines: false, topLeftCell: 'C2' }],
    });
    sheet.columns = widths.map((width) => ({ width }));
    sheet.getRow(1).values = [
      t('modelMapExportFieldName'),
      t('modelMapFieldUniqueName'),
      t('modelMapType'),
      t('modelMapIntroduction'),
      t('modelMapRequired'),
      t('modelMapPrimary'),
      t('modelMapSource'),
      t('modelMapSourceUniqueName'),
    ];
    styleHeader(sheet.getRow(1));
    entry.fields.forEach((field, index) => {
      const type = normalizeLegacyPropType(field.prop.type);
      const key = propDataTypeLabelKey(type);
      const label = i18n.t('engine', key);
      writeRow(
        sheet,
        index + 2,
        [
          field.label,
          field.prop.name,
          label === key ? type : label,
          field.description,
          t(field.prop.is_required ? 'modelMapYes' : 'modelMapNo'),
          t(field.prop.is_primary ? 'modelMapYes' : 'modelMapNo'),
          field.ownerLabel,
          byId.get(field.ownerId)?.model_name ?? '',
        ],
        widths,
      );
    });
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: sheet.rowCount, column: widths.length },
    };
  }

  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
