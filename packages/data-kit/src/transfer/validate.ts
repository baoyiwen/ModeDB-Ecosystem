import {
  TRANSFER_FORMAT,
  TRANSFER_MAX_EDGES,
  TRANSFER_MAX_ROWS,
  transferRecordKey,
  transferRelationKey,
  type TransferField,
  type TransferIssue,
  type TransferModel,
  type TransferPackage,
  type TransferPreflight,
  type TransferRelation,
} from './types.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strict validation: an invalid integer must never be silently truncated during import. */
export function transferValueValid(value: unknown, type: string): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  switch (type) {
    case 'String':
      return typeof value === 'string';
    case 'Int':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'Number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'Boolean':
      return typeof value === 'boolean';
    case 'DateTime':
      return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
    case 'I18N':
      return record(value) && Object.values(value).every((item) => typeof item === 'string');
    case 'JSON':
      return value !== undefined;
    case 'Unit':
      return (
        record(value) &&
        typeof value.value === 'number' &&
        Number.isFinite(value.value) &&
        typeof value.unit === 'string'
      );
    case 'Color':
      return typeof value === 'string'
        ? /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)
        : record(value) &&
            ['r', 'g', 'b'].every(
              (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
            );
    default:
      return false;
  }
}

function requiredEmpty(value: unknown, field: TransferField): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && !value.trim()) ||
    (field.type === 'I18N' && record(value) && Object.keys(value).length === 0)
  );
}

/**
 * Per-job indexes are supplied by the adapter. Existence is checked once per model,
 * including relation endpoints; no per-row network requests or cached absence claims.
 * This is a read-only preflight, not an authorization to write or a transaction snapshot.
 */
export function validateTransferPackage(input: {
  readonly data: TransferPackage;
  readonly database: string;
  readonly models: readonly TransferModel[];
  readonly relations: readonly TransferRelation[];
  readonly existingIds: ReadonlySet<string>;
}): TransferPreflight {
  const { data, existingIds } = input;
  const issues: TransferIssue[] = [];
  const schema = new Map(input.models.map((model) => [model.name, model]));
  const allowedRelations = new Map(input.relations.map((rel) => [transferRelationKey(rel), rel]));
  const fileModels = new Map(data.manifest.models.map((model) => [model.name, model]));
  const issue = (
    code: string,
    location: { sheet: string; row: number; column?: string },
    detail?: string,
  ): void => {
    issues.push({ code, ...location, detail });
  };
  if (data.manifest.format !== TRANSFER_FORMAT) {
    issue('format', { sheet: '_modedb', row: 1 });
  }
  if (data.manifest.kind === 'report') {
    issue('reportOnly', { sheet: '_modedb', row: 2 });
  }
  if (data.rows.length > TRANSFER_MAX_ROWS || data.edges.length > TRANSFER_MAX_EDGES) {
    issue('limit', { sheet: '_modedb', row: 1 });
  }
  for (const model of data.manifest.models) {
    const current = schema.get(model.name);
    if (!current || model.name.startsWith('sys_')) {
      issue('model', { sheet: model.sheet, row: 1 }, model.name);
      continue;
    }
    for (const field of model.fields) {
      const target = current.fields.find((item) => item.name === field.name);
      if (
        !target ||
        field.name.startsWith('_') ||
        ['constructor', 'prototype', '__proto__'].includes(field.name)
      ) {
        issue('field', { sheet: model.sheet, row: 2, column: field.name }, field.name);
      } else if (target.type !== field.type) {
        issue(
          'schema',
          { sheet: model.sheet, row: 2, column: field.name },
          `${field.type} → ${target.type}`,
        );
      }
    }
  }

  const rowKeys = new Map<string, (typeof data.rows)[number]>();
  const ids = new Set<string>();
  let existingRows = 0;
  for (const row of data.rows) {
    const key = transferRecordKey(row.model, row.key);
    if (!row.key || rowKeys.has(key)) {
      issue('duplicateKey', { ...row, column: '_key' }, row.key);
    } else {
      rowKeys.set(key, row);
    }
    if (row.id) {
      const identity = transferRecordKey(row.model, row.id);
      if (ids.has(identity)) {
        issue('duplicateId', { ...row, column: '_id' }, row.id);
      }
      ids.add(identity);
      if (existingIds.has(identity)) {
        existingRows++;
      }
    }
    const current = schema.get(row.model);
    const declared = fileModels.get(row.model);
    if (!current || !declared) {
      issue('model', row, row.model);
      continue;
    }
    const allowed = new Set(declared.fields.map((field) => field.name));
    for (const name of Object.keys(row.values)) {
      if (!allowed.has(name)) {
        issue('field', { ...row, column: name }, name);
      }
    }
    for (const field of current.fields) {
      const value = row.values[field.name];
      if (field.required && requiredEmpty(value, field)) {
        issue('required', { ...row, column: field.name }, field.label);
      } else if (!transferValueValid(value, field.type)) {
        issue('type', { ...row, column: field.name }, field.type);
      }
    }
  }

  const resolveRef = (model: string, ref: string): string | undefined => {
    if (ref.startsWith('row:')) {
      const row = rowKeys.get(transferRecordKey(model, ref.slice(4)));
      return row ? transferRecordKey(model, row.id ? `id:${row.id}` : `row:${row.key}`) : undefined;
    }
    if (ref.startsWith('id:') && ref.length > 3) {
      const id = ref.slice(3);
      return ids.has(transferRecordKey(model, id)) || existingIds.has(transferRecordKey(model, id))
        ? transferRecordKey(model, ref)
        : undefined;
    }
    return undefined;
  };
  const edgeKeys = new Set<string>();
  for (const edge of data.edges) {
    const key = transferRelationKey(edge);
    const definition = allowedRelations.get(key);
    if (!definition) {
      issue('relation', edge, `${edge.source}.${edge.forward} → ${edge.target}.${edge.reverse}`);
      continue;
    }
    const source = resolveRef(edge.source, edge.sourceRef);
    const target = resolveRef(edge.target, edge.targetRef);
    if (!source) {
      issue('reference', { ...edge, column: 'sourceRef' }, edge.sourceRef);
    }
    if (!target) {
      issue('reference', { ...edge, column: 'targetRef' }, edge.targetRef);
    }
    if (source && target) {
      if (source === target && definition.selfLoopPolicy !== 'allow') {
        issue('selfLoop', edge);
      }
      const identity = JSON.stringify([key, source, target]);
      if (edgeKeys.has(identity)) {
        issue('duplicateRelation', edge);
      }
      edgeKeys.add(identity);
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    database: input.database,
    rows: data.rows.length,
    newRows: data.rows.length - existingRows,
    existingRows,
    relations: data.edges.length,
    issues,
    valid: issues.length === 0,
  };
}
