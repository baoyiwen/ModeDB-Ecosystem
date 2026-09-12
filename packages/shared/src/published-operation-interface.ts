import type { PublishedQueryParameter } from './published-query-interface.js';
import type { EngineDatabaseOperation } from './engine-operations.js';

export interface InterfaceParameterPlaceholder {
  readonly $interfaceParameter: string;
}

export interface PublishedOperationTemplateRowRef {
  readonly model: string;
  readonly id: unknown;
}

export type PublishedOperationTemplateOperation =
  | {
      readonly op: 'insert';
      readonly model: string;
      readonly data: Readonly<Record<string, unknown>>;
      readonly sync?: boolean;
    }
  | {
      readonly op: 'insertMany';
      readonly model: string;
      readonly rows: readonly Readonly<Record<string, unknown>>[];
      readonly sync?: boolean;
      readonly returning: true;
      readonly upsert: {
        readonly matchFields: readonly string[];
        readonly updateExisting: true;
      };
    }
  | {
      readonly op: 'update';
      readonly model: string;
      readonly id: unknown;
      readonly partial: Readonly<Record<string, unknown>>;
      readonly sync?: boolean;
    }
  | {
      readonly op: 'delete';
      readonly model: string;
      readonly id: unknown;
      readonly sync?: boolean;
    }
  | {
      readonly op: 'bindPair';
      readonly forward: string;
      readonly reverse: string;
      readonly source: PublishedOperationTemplateRowRef;
      readonly target: PublishedOperationTemplateRowRef;
    }
  | {
      readonly op: 'unlinkPair';
      readonly forward: string;
      readonly reverse: string;
      readonly source: PublishedOperationTemplateRowRef;
      readonly target: PublishedOperationTemplateRowRef;
    }
  | {
      readonly op: 'rebindPair';
      readonly forward: string;
      readonly reverse: string;
      readonly source: PublishedOperationTemplateRowRef;
      readonly previousTarget: PublishedOperationTemplateRowRef;
      readonly nextTarget: PublishedOperationTemplateRowRef;
    };

export interface PublishedOperationExecutionTemplate {
  readonly format: 1;
  readonly operation: PublishedOperationTemplateOperation;
  readonly parameters: readonly PublishedQueryParameter[];
  readonly batch?: {
    readonly itemsParameter: 'items';
    readonly maxItems: number;
    readonly failureMode: 'continue' | 'stop';
  };
  readonly transaction?: {
    readonly mode: 'single' | 'batch';
    readonly rollbackOnFailure: boolean;
  };
  readonly result: {
    readonly returns: 'none' | 'recordRef' | 'record' | 'summary';
    readonly includeItemResults?: boolean;
  };
}

export interface BoundPublishedOperationBatch {
  readonly items: readonly (
    | { readonly index: number; readonly operation: EngineDatabaseOperation }
    | { readonly index: number; readonly error: string }
  )[];
  readonly requestedCount: number;
  readonly failureMode: 'continue' | 'stop';
  readonly includeItemResults: boolean;
}

export function interfaceParameterPlaceholder(parameterId: string): InterfaceParameterPlaceholder {
  return { $interfaceParameter: parameterId };
}

export function isInterfaceParameterPlaceholder(
  value: unknown,
): value is InterfaceParameterPlaceholder {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Partial<InterfaceParameterPlaceholder>).$interfaceParameter === 'string'
  );
}

export function bindPublishedOperationExecutionTemplate(
  template: PublishedOperationExecutionTemplate,
  supplied: Readonly<Record<string, unknown>>,
): EngineDatabaseOperation {
  if (!isPublishedOperationExecutionTemplate(template)) {
    throw new Error('INTERFACE_OPERATION_TEMPLATE_INVALID');
  }
  if (template.batch) {
    throw new Error('INTERFACE_BATCH_BINDER_REQUIRED');
  }
  const knownKeys = new Set(
    template.parameters.flatMap((parameter) => [parameter.id, parameter.name]),
  );
  const unknown = Object.keys(supplied).find((key) => !knownKeys.has(key));
  if (unknown) {
    throw new Error(`INTERFACE_PARAMETER_UNKNOWN:${unknown}`);
  }
  const values = new Map<string, unknown>();
  for (const parameter of template.parameters) {
    values.set(parameter.id, resolveOperationParameter(parameter, supplied));
  }
  const operation = replaceOperationPlaceholders(template.operation, values);
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error('INTERFACE_OPERATION_TEMPLATE_INVALID');
  }
  if (operation.op === 'insert') {
    return operation;
  }
  if (operation.op === 'insertMany') {
    return {
      op: 'insertMany',
      model: operation.model,
      rows: operation.rows.map((row) => ({ ...row })),
      returning: true,
      upsert: {
        matchFields: [...operation.upsert.matchFields],
        updateExisting: true,
      },
      ...(operation.sync !== undefined ? { sync: operation.sync } : {}),
    };
  }
  if (operation.op === 'bindPair' || operation.op === 'unlinkPair') {
    assertBoundRowRef(operation.source);
    assertBoundRowRef(operation.target);
    return {
      op: operation.op,
      forward: operation.forward,
      reverse: operation.reverse,
      source: { model: operation.source.model, id: operation.source.id },
      target: { model: operation.target.model, id: operation.target.id },
    };
  }
  if (operation.op === 'rebindPair') {
    assertBoundRowRef(operation.source);
    assertBoundRowRef(operation.previousTarget);
    assertBoundRowRef(operation.nextTarget);
    return {
      op: 'rebindPair',
      forward: operation.forward,
      reverse: operation.reverse,
      source: { model: operation.source.model, id: operation.source.id },
      previousTarget: {
        model: operation.previousTarget.model,
        id: operation.previousTarget.id,
      },
      nextTarget: { model: operation.nextTarget.model, id: operation.nextTarget.id },
    };
  }
  if (typeof operation.id !== 'string' || !operation.id.trim()) {
    throw new Error('INTERFACE_OPERATION_ID_INVALID');
  }
  if (operation.op === 'update') {
    return {
      op: 'update',
      model: operation.model,
      id: operation.id,
      partial: { ...operation.partial },
      ...(operation.sync !== undefined ? { sync: operation.sync } : {}),
    };
  }
  return {
    op: 'delete',
    model: operation.model,
    id: operation.id,
    ...(operation.sync !== undefined ? { sync: operation.sync } : {}),
  };
}

export function bindPublishedOperationBatchExecutionTemplate(
  template: PublishedOperationExecutionTemplate,
  supplied: Readonly<Record<string, unknown>>,
): BoundPublishedOperationBatch {
  if (!isPublishedOperationExecutionTemplate(template) || !template.batch) {
    throw new Error('INTERFACE_OPERATION_BATCH_TEMPLATE_INVALID');
  }
  const unknown = Object.keys(supplied).find((key) => key !== template.batch!.itemsParameter);
  if (unknown) {
    throw new Error(`INTERFACE_PARAMETER_UNKNOWN:${unknown}`);
  }
  const items = supplied[template.batch.itemsParameter];
  if (!Array.isArray(items)) {
    throw new Error(`INTERFACE_PARAMETER_INVALID:${template.batch.itemsParameter}:array`);
  }
  if (items.length === 0) {
    throw new Error('INTERFACE_BATCH_EMPTY');
  }
  if (items.length > template.batch.maxItems) {
    throw new Error(`INTERFACE_BATCH_LIMIT_EXCEEDED:${template.batch.maxItems}`);
  }
  const singleTemplate: PublishedOperationExecutionTemplate = {
    ...template,
    batch: undefined,
    transaction: { mode: 'single', rollbackOnFailure: true },
  };
  const boundItems = items.map((item, index) => {
    if (!isRecord(item)) {
      return { index, error: `INTERFACE_BATCH_ITEM_INVALID:${index}` } as const;
    }
    try {
      return {
        index,
        operation: bindPublishedOperationExecutionTemplate(singleTemplate, item),
      } as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { index, error: `INTERFACE_BATCH_ITEM_INVALID:${index}:${message}` } as const;
    }
  });
  return {
    items: boundItems,
    requestedCount: items.length,
    failureMode: template.batch.failureMode,
    includeItemResults: template.result.includeItemResults === true,
  };
}

export function isPublishedOperationExecutionTemplate(
  value: unknown,
): value is PublishedOperationExecutionTemplate {
  if (!isRecord(value) || value.format !== 1 || !isRecord(value.operation)) {
    return false;
  }
  const operation = value.operation;
  if (
    !['insert', 'insertMany', 'update', 'delete', 'bindPair', 'unlinkPair', 'rebindPair'].includes(
      String(operation.op),
    )
  ) {
    return false;
  }
  if (['insert', 'insertMany', 'update', 'delete'].includes(String(operation.op))) {
    if (typeof operation.model !== 'string' || !operation.model.trim()) {
      return false;
    }
  }
  if (operation.op === 'insert' && !isRecord(operation.data)) {
    return false;
  }
  if (
    operation.op === 'insertMany' &&
    (!Array.isArray(operation.rows) ||
      operation.rows.length !== 1 ||
      !operation.rows.every(isRecord) ||
      operation.returning !== true ||
      !isRecord(operation.upsert) ||
      !Array.isArray(operation.upsert.matchFields) ||
      operation.upsert.matchFields.length === 0 ||
      !operation.upsert.matchFields.every(
        (field) => typeof field === 'string' && Boolean(field.trim()),
      ) ||
      operation.upsert.updateExisting !== true)
  ) {
    return false;
  }
  if (operation.op === 'update' && (!('id' in operation) || !isRecord(operation.partial))) {
    return false;
  }
  if (operation.op === 'delete' && !('id' in operation)) {
    return false;
  }
  if (operation.op === 'bindPair' || operation.op === 'unlinkPair') {
    if (
      !validRelationLabels(operation) ||
      !isTemplateRowRef(operation.source) ||
      !isTemplateRowRef(operation.target)
    ) {
      return false;
    }
  }
  if (operation.op === 'rebindPair') {
    if (
      !validRelationLabels(operation) ||
      !isTemplateRowRef(operation.source) ||
      !isTemplateRowRef(operation.previousTarget) ||
      !isTemplateRowRef(operation.nextTarget)
    ) {
      return false;
    }
  }
  if (!Array.isArray(value.parameters) || !value.parameters.every(isPublishedOperationParameter)) {
    return false;
  }
  if (value.batch !== undefined) {
    if (
      !isRecord(value.batch) ||
      value.batch.itemsParameter !== 'items' ||
      typeof value.batch.maxItems !== 'number' ||
      !Number.isInteger(value.batch.maxItems) ||
      value.batch.maxItems < 1 ||
      value.batch.maxItems > 1000 ||
      !['continue', 'stop'].includes(String(value.batch.failureMode)) ||
      !isRecord(value.transaction) ||
      value.transaction.mode !== 'batch' ||
      value.transaction.rollbackOnFailure !== false
    ) {
      return false;
    }
  }
  if (
    value.transaction !== undefined &&
    (!isRecord(value.transaction) ||
      !['single', 'batch'].includes(String(value.transaction.mode)) ||
      typeof value.transaction.rollbackOnFailure !== 'boolean')
  ) {
    return false;
  }
  return (
    isRecord(value.result) &&
    ['none', 'recordRef', 'record', 'summary'].includes(String(value.result.returns)) &&
    (value.result.includeItemResults === undefined ||
      typeof value.result.includeItemResults === 'boolean')
  );
}

function isPublishedOperationParameter(value: unknown): value is PublishedQueryParameter {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Boolean(value.id) &&
    typeof value.name === 'string' &&
    Boolean(value.name) &&
    [
      'string',
      'number',
      'boolean',
      'date',
      'datetime',
      'enum',
      'json',
      'recordRef',
      'relationRef',
    ].includes(String(value.type)) &&
    typeof value.required === 'boolean'
  );
}

function assertBoundRowRef(ref: PublishedOperationTemplateRowRef): asserts ref is {
  readonly model: string;
  readonly id: string;
} {
  if (typeof ref.id !== 'string' || !ref.id.trim()) {
    throw new Error('INTERFACE_OPERATION_ID_INVALID');
  }
}

function isTemplateRowRef(value: unknown): value is PublishedOperationTemplateRowRef {
  return (
    isRecord(value) &&
    typeof value.model === 'string' &&
    Boolean(value.model.trim()) &&
    'id' in value
  );
}

function validRelationLabels(value: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof value.forward === 'string' &&
    Boolean(value.forward.trim()) &&
    typeof value.reverse === 'string' &&
    Boolean(value.reverse.trim())
  );
}

function resolveOperationParameter(
  parameter: PublishedQueryParameter,
  supplied: Readonly<Record<string, unknown>>,
): unknown {
  const hasName = Object.prototype.hasOwnProperty.call(supplied, parameter.name);
  const hasId = Object.prototype.hasOwnProperty.call(supplied, parameter.id);
  const raw = hasName
    ? supplied[parameter.name]
    : hasId
      ? supplied[parameter.id]
      : parameter.defaultValue;
  if (raw === undefined || raw === '') {
    if (parameter.required) {
      throw new Error(`INTERFACE_PARAMETER_REQUIRED:${parameter.name}`);
    }
    return raw;
  }
  if (parameter.type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error(`INTERFACE_PARAMETER_INVALID:${parameter.name}:number`);
    }
    return value;
  }
  if (parameter.type === 'boolean') {
    if (typeof raw === 'boolean') {
      return raw;
    }
    if (raw === 'true' || raw === '1') {
      return true;
    }
    if (raw === 'false' || raw === '0') {
      return false;
    }
    throw new Error(`INTERFACE_PARAMETER_INVALID:${parameter.name}:boolean`);
  }
  if (parameter.type === 'json' && typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`INTERFACE_PARAMETER_INVALID:${parameter.name}:json`);
    }
  }
  return raw;
}

function replaceOperationPlaceholders(
  value: PublishedOperationTemplateOperation,
  values: ReadonlyMap<string, unknown>,
): PublishedOperationTemplateOperation;
function replaceOperationPlaceholders(
  value: unknown,
  values: ReadonlyMap<string, unknown>,
): unknown;
function replaceOperationPlaceholders(
  value: unknown,
  values: ReadonlyMap<string, unknown>,
): unknown {
  if (isInterfaceParameterPlaceholder(value)) {
    return values.get(value.$interfaceParameter);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceOperationPlaceholders(entry, values));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        replaceOperationPlaceholders(child, values),
      ]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
