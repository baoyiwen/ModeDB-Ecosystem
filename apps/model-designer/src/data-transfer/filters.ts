import { TransferError, type TransferModel } from '@mode-db/data-kit';
import { toStoredDateTime } from '../pivot/date-time.js';

/** One set of conditions shared by the database preview and the export. */
export interface TransferFilter {
  readonly field: string;
  readonly op:
    | 'eq'
    | 'neq'
    | 'contains'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'between'
    | 'isNull'
    | 'isNotNull';
  readonly value: string;
  readonly valueTo?: string;
  readonly locale?: string;
  readonly join?: 'and' | 'or';
}

export interface TransferFilterQuery {
  is(field: string, value: unknown): unknown;
  contains(field: string, value: string): unknown;
  gt(field: string, value: unknown): unknown;
  lt(field: string, value: unknown): unknown;
  where?(field: string, operator: string, value: unknown): unknown;
  or?(): unknown;
}

export function transferFilterOperators(type: string): TransferFilter['op'][] {
  if (['JSON', 'Unit'].includes(type)) return ['isNull', 'isNotNull'];
  const common: TransferFilter['op'][] = ['eq', 'neq'];
  if (['String', 'I18N'].includes(type)) common.push('contains');
  if (['Int', 'Number', 'DateTime'].includes(type))
    common.push('gt', 'gte', 'lt', 'lte', 'between');
  return [...common, 'isNull', 'isNotNull'];
}

export function applyTransferFilters(
  query: TransferFilterQuery,
  model: TransferModel,
  filters: readonly TransferFilter[],
): void {
  // Validate the whole form before changing the query builder.
  const conditions = filters.map((filter) => {
    const field = model.fields.find((item) => item.name === filter.field);
    if (
      !field ||
      !transferFilterOperators(field.type).includes(filter.op) ||
      (!['isNull', 'isNotNull'].includes(filter.op) && !filter.value.trim()) ||
      (filter.join !== undefined && !['and', 'or'].includes(filter.join))
    )
      throw new TransferError('filter');
    const parse = (text: string): unknown => {
      let value: unknown = text;
      if (['Number', 'Int'].includes(field.type)) {
        value = Number(text);
        if (!Number.isFinite(value) || (field.type === 'Int' && !Number.isSafeInteger(value)))
          throw new TransferError('filter');
      } else if (field.type === 'Boolean') {
        if (!/^(true|false)$/i.test(text)) throw new TransferError('filter');
        value = text.toLowerCase() === 'true';
      } else if (field.type === 'DateTime') {
        value = toStoredDateTime(text);
        if (!value) throw new TransferError('filter');
      }
      return value;
    };
    const unary = ['isNull', 'isNotNull'].includes(filter.op);
    const value = unary ? null : parse(filter.value);
    const to =
      filter.op === 'between'
        ? parse(
            filter.valueTo?.trim() ||
              (() => {
                throw new TransferError('filter');
              })(),
          )
        : undefined;
    if (
      filter.op === 'between' &&
      (field.type === 'DateTime'
        ? Date.parse(String(value)) > Date.parse(String(to))
        : Number(value) > Number(to))
    )
      throw new TransferError('filter');
    const fieldName =
      field.type === 'I18N' && !unary ? `${filter.field}.${filter.locale ?? 'zh'}` : filter.field;
    if (filter.locale && !/^[a-z]{2}(?:-[A-Za-z]{2,4})?$/.test(filter.locale))
      throw new TransferError('filter');
    if (
      (!['eq', 'contains', 'gt', 'lt'].includes(filter.op) || fieldName !== filter.field) &&
      !query.where
    )
      throw new TransferError('filter');
    if (filter.join === 'or' && !query.or) throw new TransferError('filter');
    return { ...filter, field: fieldName, value: filter.op === 'between' ? [value, to] : value };
  });
  for (const [index, { field, op, value, join }] of conditions.entries()) {
    if (index > 0 && join === 'or') query.or!();
    if (op === 'eq') query.is(field, value);
    else if (op === 'contains') query.contains(field, value as string);
    else if (op === 'gt') query.gt(field, value);
    else if (op === 'lt') query.lt(field, value);
    else query.where!(field, op === 'isNull' ? 'eq' : op === 'isNotNull' ? 'neq' : op, value);
  }
}
