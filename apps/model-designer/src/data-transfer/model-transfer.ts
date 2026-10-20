import type { RemoteModelDBClient } from '@mode-db/sdk';
import {
  TRANSFER_FORMAT,
  TRANSFER_MAX_EDGES,
  TRANSFER_MAX_ROWS,
  TransferError,
  transferRecordKey,
  transferRelationKey,
  validateTransferPackage,
  type TransferEdge,
  type TransferModel,
  type TransferPackage,
  type TransferPreflight,
  type TransferProgress,
  type TransferRelation,
} from '@mode-db/data-kit';

import { applyTransferFilters, type TransferFilter } from './filters.js';
export { applyTransferFilters, type TransferFilter } from './filters.js';
export type TransferNotify = (progress: TransferProgress) => void;

function rawRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new TransferError('result');
  if ('getData' in value && typeof value.getData === 'function') return value.getData(true);
  return value as Record<string, unknown>;
}

function resultRows(result: unknown): Record<string, unknown>[] {
  const items = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && 'items' in result
      ? result.items
      : undefined;
  if (!Array.isArray(items)) throw new TransferError('result');
  if (
    result &&
    !Array.isArray(result) &&
    typeof result === 'object' &&
    'total' in result &&
    typeof result.total === 'number' &&
    result.total > items.length
  )
    throw new TransferError('limit');
  return items.map(rawRow);
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransferError('cancelled');
}

/** Export only designer-associated fields plus IDs and explicit relation identities. */
export async function collectModelTransfer(input: {
  readonly client: Pick<RemoteModelDBClient, 'model'>;
  readonly database: string;
  readonly model: TransferModel;
  readonly relations: readonly TransferRelation[];
  readonly ancestors?: readonly string[];
  readonly filters: readonly TransferFilter[];
  readonly template?: boolean;
  readonly includeRelations?: boolean;
  readonly signal?: AbortSignal;
  readonly notify?: TransferNotify;
}): Promise<TransferPackage> {
  const { client, model, signal, notify } = input;
  if (
    input.includeRelations !== false &&
    input.relations.some(
      (rel) =>
        rel.source !== model.name &&
        rel.target !== model.name &&
        (input.ancestors?.includes(rel.source) || input.ancestors?.includes(rel.target)),
    )
  ) {
    throw new TransferError('inheritedRelation');
  }
  const relevant =
    input.includeRelations === false
      ? []
      : input.relations.filter((rel) => rel.source === model.name || rel.target === model.name);
  const manifest = {
    format: TRANSFER_FORMAT,
    kind: input.template ? ('template' as const) : ('data' as const),
    database: input.database,
    createdAt: new Date().toISOString(),
    models: [model],
    relations: relevant,
  };
  if (input.template) return { manifest, rows: [], edges: [] };
  checkCancelled(signal);
  notify?.({ stage: 'query', completed: 0 });
  const query = client.model(model.name).query();
  applyTransferFilters(query, model, input.filters);
  const raw = resultRows(
    await query.execute({ includeRelates: false, limit: TRANSFER_MAX_ROWS + 1 }),
  );
  if (raw.length > TRANSFER_MAX_ROWS) throw new TransferError('limit');
  const rows = raw.map((row, index) => {
    if (typeof row._id !== 'string' || !row._id) throw new TransferError('result');
    return {
      model: model.name,
      sheet: model.sheet,
      row: index + 3,
      key: `r${index + 1}`,
      id: row._id,
      values: Object.fromEntries(
        model.fields
          .filter((field) => Object.hasOwn(row, field.name))
          .map((field) => [field.name, row[field.name]]),
      ),
    };
  });
  const edges: TransferEdge[] = [];
  const seen = new Set<string>();
  const directions = relevant.flatMap((rel) => [
    ...(rel.source === model.name ? [{ rel, label: rel.forward, reverse: false }] : []),
    ...(rel.target === model.name ? [{ rel, label: rel.reverse, reverse: true }] : []),
  ]);
  const ids = rows.map((row) => row.id);
  for (let index = 0; index < directions.length && ids.length > 0; index++) {
    checkCancelled(signal);
    const { rel, label, reverse } = directions[index]!;
    // Fluent traversal is label-based. Refuse ambiguous labels rather than
    // accidentally exporting another endpoint's edges.
    if (directions.filter((entry) => entry.label === label).length > 1)
      throw new TransferError('ambiguousRelation', undefined, label);
    notify?.({ stage: 'relations', completed: index, total: directions.length });
    const related = resultRows(
      await client.model(model.name).query(ids).relate(label).execute({ includeRelates: true }),
    );
    for (const origin of related) {
      const slots = origin.relates;
      if (!slots || typeof slots !== 'object') continue;
      const children = (slots as Record<string, unknown>)[label];
      if (!Array.isArray(children)) continue;
      for (const value of children) {
        const child = rawRow(value);
        if (typeof origin._id !== 'string' || typeof child._id !== 'string')
          throw new TransferError('result');
        const sourceRef = `id:${reverse ? child._id : origin._id}`;
        const targetRef = `id:${reverse ? origin._id : child._id}`;
        const key = JSON.stringify([transferRelationKey(rel), sourceRef, targetRef]);
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ ...rel, sourceRef, targetRef, sheet: '_relations', row: edges.length + 3 });
        if (edges.length > TRANSFER_MAX_EDGES) throw new TransferError('limit');
      }
    }
  }
  checkCancelled(signal);
  return { manifest, rows, edges };
}

/** One job-local, batched existence index covers rows and external relationship endpoints. */
export async function preflightModelTransfer(input: {
  readonly client: Pick<RemoteModelDBClient, 'model'>;
  readonly database: string;
  readonly data: TransferPackage;
  readonly models: readonly TransferModel[];
  readonly relations: readonly TransferRelation[];
  readonly signal?: AbortSignal;
  readonly notify?: TransferNotify;
}): Promise<TransferPreflight> {
  const pending = new Map<string, Set<string>>();
  const known = new Set(input.models.map((model) => model.name));
  const add = (model: string, id: string): void => {
    if (!known.has(model) || model.startsWith('sys_') || !id) return;
    const ids = pending.get(model) ?? new Set<string>();
    ids.add(id);
    pending.set(model, ids);
  };
  for (const row of input.data.rows) if (row.id) add(row.model, row.id);
  for (const edge of input.data.edges) {
    if (edge.sourceRef.startsWith('id:')) add(edge.source, edge.sourceRef.slice(3));
    if (edge.targetRef.startsWith('id:')) add(edge.target, edge.targetRef.slice(3));
  }
  const existingIds = new Set<string>();
  const total = [...pending.values()].reduce((sum, ids) => sum + ids.size, 0);
  let completed = 0;
  input.notify?.({ stage: 'validate', completed, total });
  for (const [model, values] of pending) {
    const ids = [...values];
    for (let start = 0; start < ids.length; start += 2_000) {
      checkCancelled(input.signal);
      const chunk = ids.slice(start, start + 2_000);
      const result = resultRows(
        await input.client.model(model).query(chunk).execute({ includeRelates: false }),
      );
      for (const row of result)
        if (typeof row._id === 'string') existingIds.add(transferRecordKey(model, row._id));
      completed += chunk.length;
      input.notify?.({ stage: 'validate', completed, total });
    }
  }
  checkCancelled(input.signal);
  return validateTransferPackage({ ...input, existingIds });
}
