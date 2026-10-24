import type { ManagementCatalogResponse, RemoteModelDBClient } from '@mode-db/sdk';
import {
  SYS_DATA_ASSET_MAP,
  SYS_MODEL,
  SYS_PROPS,
  SYS_RELATION_DEF,
} from '../bootstrap/designer-storage-init.js';
import { isInheritRelation } from '../config/graph-edge-kinds.js';
import { dataTypeToEngineCode, normalizeLegacyPropType } from '../config/engine-prop-types.js';
import { openWorkspaceSession } from '../engine/workspace-session.js';
import type { DataManager } from '../managers/data-manager.js';
import type { GraphSyncManager } from '../managers/graph-sync-manager.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { PropObject } from '../types/prop-object.js';
import { readBusinessCatalog } from './engine-catalog-import.js';
import { pushDesignerSnapshot } from './sdk-designer-sync.js';
import { extractEngineModelRelationPayload } from './engine-model-relation.js';
import { serializeMldgDocumentToUint8Array } from './mldg-wire-bytes.js';
import { createUuid } from '../utils/random-id.js';
import {
  relationLogicFromCardinality,
  relationSourceCardinality,
  relationTargetCardinality,
  type RelationEngineNames,
  type RelationLogicWire,
} from '../utils/relation-identity.js';

interface RowDataLike {
  getData?: (deep?: boolean) => Record<string, unknown>;
}

function hydrate(row: unknown): Record<string, unknown> {
  if (row && typeof row === 'object' && typeof (row as RowDataLike).getData === 'function') {
    return (row as Required<RowDataLike>).getData(true);
  }
  if (row && typeof row === 'object') {
    return row as Record<string, unknown>;
  }
  throw new Error('DESIGNER_PUSH_BAD_ROW');
}

function propsToFieldSchema(props: readonly PropObject[]): Record<string, string> {
  const schema: Record<string, string> = {};
  for (const p of props) {
    schema[p.name] = normalizeLegacyPropType(p.type);
  }
  return schema;
}

function engineDeltaProps(
  model: EngineModelNode,
  modelsById: ReadonlyMap<string, EngineModelNode>,
): PropObject[] {
  const own = model.props_objects_array;
  if (!model.parent_id) {
    return own;
  }
  const parent = modelsById.get(model.parent_id);
  if (!parent) {
    return own;
  }
  const parentNames = new Set(parent.props_objects_array.map((p) => p.name));
  return own.filter((p) => !parentNames.has(p.name));
}

function parentEngineName(
  model: EngineModelNode,
  modelsById: ReadonlyMap<string, EngineModelNode>,
): string | null {
  if (!model.parent_id) {
    return null;
  }
  return modelsById.get(model.parent_id)?.model_name ?? null;
}

async function resolveAssetMapId(
  client: RemoteModelDBClient,
  libraryCode: string,
): Promise<string | undefined> {
  const rows = await client.model(SYS_DATA_ASSET_MAP).query().execute();
  for (const r of Array.isArray(rows) ? rows : []) {
    const d = hydrate(r);
    if (d.code === libraryCode && typeof d._id === 'string') {
      return d._id;
    }
  }
  return undefined;
}

async function loadLibraryRowsById(
  client: RemoteModelDBClient,
  modelName: string,
  libraryCode: string,
): Promise<Map<string, Record<string, unknown>>> {
  const rows = await client.model(modelName).query().execute();
  const out = new Map<string, Record<string, unknown>>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const d = hydrate(r);
    const id = typeof d._id === 'string' ? d._id : '';
    if (!id || d.library_code !== libraryCode) {
      continue;
    }
    out.set(id, d);
  }
  return out;
}

async function listLibraryCatalogIds(
  client: RemoteModelDBClient,
  modelName: string,
  libraryCode: string,
): Promise<string[]> {
  const rows = await client.model(modelName).query().execute();
  const ids: string[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const d = hydrate(r);
    if (d.library_code !== libraryCode || typeof d._id !== 'string') {
      continue;
    }
    ids.push(d._id);
  }
  return ids;
}

function collectCanvasPropIds(data: DataManager): Set<string> {
  const ids = new Set<string>();
  for (const model of data.models) {
    for (const prop of model.props_objects_array) {
      if (prop.id) {
        ids.add(prop.id);
      }
    }
  }
  return ids;
}

function parseRelationCanvasMetaField(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim() === '') {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function currentRelationNames(rel: EngineRelationEdge): RelationEngineNames {
  const forward = rel.forward_name || rel.engine_forward_name || rel.kind;
  return {
    forward,
    reverse: rel.reverse_name || rel.engine_reverse_name || `${forward}_rev`,
  };
}

function relationSelfLoopPolicy(rel: EngineRelationEdge): 'deny' | 'allow' {
  return rel.self_loop_policy === 'allow' ? 'allow' : 'deny';
}

function relationStorageKey(input: {
  readonly source: string;
  readonly target: string;
  readonly forward: string;
  readonly reverse: string;
}): string {
  return `${input.source}\0${input.target}\0${input.forward}\0${input.reverse}`;
}

function relationStorageKeyFromRow(row: Record<string, unknown>): string | null {
  let forward = typeof row.engine_name === 'string' ? row.engine_name : '';
  let reverse = '';
  let source = '';
  let target = '';
  const meta = parseRelationCanvasMetaField(row.canvas_meta);
  if (typeof meta.engineForward === 'string') {
    forward = meta.engineForward;
  } else if (typeof meta.forward === 'string') {
    forward = meta.forward;
  }
  if (typeof meta.engineReverse === 'string') {
    reverse = meta.engineReverse;
  } else if (typeof meta.reverse === 'string') {
    reverse = meta.reverse;
  }
  if (typeof meta.source === 'string') {
    source = meta.source;
  }
  if (typeof meta.target === 'string') {
    target = meta.target;
  }
  if (!source || !target || !forward) {
    return null;
  }
  return relationStorageKey({ source, target, forward, reverse });
}

/**
 * 删除设计器库中已从画布移除的 catalog 行（模型 / 属性 / 关系定义）。
 */
async function pruneRemovedDesignerCatalogRows(
  client: RemoteModelDBClient,
  libraryCode: string,
  data: DataManager,
): Promise<void> {
  const code = libraryCode.trim();
  const canvasModelIds = new Set(data.models.map((m) => m.id));
  const canvasRelationIds = new Set(
    data.relations.filter((r) => !isInheritRelation(r.kind)).map((r) => r.id),
  );
  const canvasPropIds = collectCanvasPropIds(data);

  const deletes: Array<{ model: string; id: string }> = [];

  for (const id of await listLibraryCatalogIds(client, SYS_PROPS, code)) {
    if (!canvasPropIds.has(id)) {
      deletes.push({ model: SYS_PROPS, id });
    }
  }

  for (const id of await listLibraryCatalogIds(client, SYS_RELATION_DEF, code)) {
    if (!canvasRelationIds.has(id)) {
      deletes.push({ model: SYS_RELATION_DEF, id });
    }
  }

  for (const id of await listLibraryCatalogIds(client, SYS_MODEL, code)) {
    if (!canvasModelIds.has(id)) {
      deletes.push({ model: SYS_MODEL, id });
    }
  }

  if (deletes.length === 0) {
    return;
  }

  const { failureCount } = await client.batchDelete(deletes, { sync: true });
  if (failureCount > 0) {
    throw new Error('DESIGNER_PUSH_CATALOG_DELETE_FAILED');
  }
}

/**
 * 从业务库 registry 中移除画布上已不存在的模型 / 关系定义。
 */
async function pruneRemovedBusinessSchema(
  businessClient: RemoteModelDBClient,
  data: DataManager,
  catalog: ManagementCatalogResponse,
): Promise<void> {
  const canvasModelNames = new Set(
    data.models.filter((m) => !m.model_name.startsWith('sys_')).map((m) => m.model_name),
  );
  const modelNameByIdForPrune = new Map(data.models.map((m) => [m.id, m.model_name] as const));
  const canvasRelationKeys = new Set(
    data.relations
      .filter((r) => !isInheritRelation(r.kind))
      .map((r) => {
        const source = modelNameByIdForPrune.get(r.source_model_id);
        const target = modelNameByIdForPrune.get(r.target_model_id);
        const { forward, reverse } = currentRelationNames(r);
        return source && target && forward ? `${source}::${target}::${forward}::${reverse}` : '';
      })
      .filter((key) => key.length > 0),
  );

  const modelsToRemove = catalog.models.filter(
    (model) => !model.name.startsWith('sys_') && !canvasModelNames.has(model.name),
  );
  const removingModelNames = new Set(modelsToRemove.map((model) => model.name));

  // 仅显式从画布删除、且端点仍保留的关系；涉及待删模型的关系由 dropModel 一并移除。
  for (const rel of catalog.relations) {
    if (canvasRelationKeys.has(`${rel.source}::${rel.target}::${rel.forward}::${rel.reverse}`)) {
      continue;
    }
    if (removingModelNames.has(rel.source) || removingModelNames.has(rel.target)) {
      continue;
    }
    try {
      await businessClient.dropRelation(rel.forward, {
        source: rel.source,
        target: rel.target,
        reverse: rel.reverse,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!/not found/i.test(message)) {
        throw e;
      }
    }
  }

  for (const model of modelsToRemove) {
    await businessClient.dropModel(model.name);
  }
}

/**
 * 将画布模型/属性/关系行写入设计器库（`sys_model` / `sys_props` / `sys_relation`）。
 */
async function pushDesignerCatalogRows(
  client: RemoteModelDBClient,
  libraryCode: string,
  data: DataManager,
): Promise<void> {
  const code = libraryCode.trim();
  const assetMapId = await resolveAssetMapId(client, code);
  const existingModelRowsById = await loadLibraryRowsById(client, SYS_MODEL, code);
  const modelIdByEngineName = new Map<string, string>();
  const duplicateModelIdsByEngineName = new Map<string, string[]>();
  for (const [id, row] of existingModelRowsById) {
    if (typeof row.engine_name === 'string' && row.engine_name) {
      const existing = modelIdByEngineName.get(row.engine_name);
      if (existing) {
        duplicateModelIdsByEngineName.set(row.engine_name, [
          ...(duplicateModelIdsByEngineName.get(row.engine_name) ?? []),
          id,
        ]);
      } else {
        modelIdByEngineName.set(row.engine_name, id);
      }
    }
  }
  const modelStorageIdByCanvasId = new Map<string, string>();
  const usedModelStorageIds = new Set<string>();

  for (const model of data.models) {
    const layout = data.getLayout(model.id);
    const partial: Record<string, unknown> = {
      engine_name: model.model_name,
      library_code: code,
      name: model.name_i18n ?? { en: model.model_name, zh: model.model_name, ja: model.model_name },
      description: model.description_i18n ?? { en: '', zh: '', ja: '' },
      color: model.color_value ?? '#7c3aed',
      posX: layout?.position.x ?? 0,
      posY: layout?.position.y ?? 0,
      canvas_meta: JSON.stringify({
        position: layout?.position ?? { x: 0, y: 0 },
        color_theme: layout?.color_theme ?? 'default',
        z_index: layout?.z_index ?? 0,
        position_locked: layout?.position_locked ?? false,
        edge_bend_hints: layout?.edge_bend_hints,
      }),
    };

    const storageModelId = existingModelRowsById.has(model.id)
      ? model.id
      : (modelIdByEngineName.get(model.model_name) ?? model.id);
    modelStorageIdByCanvasId.set(model.id, storageModelId);
    usedModelStorageIds.add(storageModelId);
    if (existingModelRowsById.has(storageModelId)) {
      const { failureCount } = await client.batchUpdate(
        [{ model: SYS_MODEL, id: storageModelId, partial }],
        { sync: true },
      );
      if (failureCount > 0) {
        throw new Error('DESIGNER_PUSH_SYS_MODEL_UPDATE_FAILED');
      }
    } else {
      const { failureCount } = await client
        .model(SYS_MODEL)
        .insertMany([{ _id: storageModelId, ...partial }], { sync: true });
      if (failureCount > 0) {
        throw new Error('DESIGNER_PUSH_SYS_MODEL_INSERT_FAILED');
      }
      existingModelRowsById.set(storageModelId, { _id: storageModelId, ...partial });
      modelIdByEngineName.set(model.model_name, storageModelId);
    }

    if (assetMapId !== undefined) {
      try {
        await client.bindRelation(
          { model: SYS_DATA_ASSET_MAP, id: assetMapId },
          { model: SYS_MODEL, id: storageModelId },
          'assetMapIncludesModels',
          'modelBelongsToAssetMap',
        );
      } catch {
        /* idempotent */
      }
    }

    if (model.parent_id && data.models.some((m) => m.id === model.parent_id)) {
      const parentStorageId = modelStorageIdByCanvasId.get(model.parent_id) ?? model.parent_id;
      try {
        await client.bindRelation(
          { model: SYS_MODEL, id: storageModelId },
          { model: SYS_MODEL, id: parentStorageId },
          'modelBelongsToParent',
          'parentModelHasChildren',
        );
      } catch {
        /* idempotent */
      }
    }
  }

  const duplicateModelDeletes: Array<{ model: string; id: string }> = [];
  for (const ids of duplicateModelIdsByEngineName.values()) {
    for (const id of ids) {
      if (!usedModelStorageIds.has(id)) {
        duplicateModelDeletes.push({ model: SYS_MODEL, id });
      }
    }
  }
  if (duplicateModelDeletes.length > 0) {
    const { failureCount } = await client.batchDelete(duplicateModelDeletes, { sync: true });
    if (failureCount > 0) {
      throw new Error('DESIGNER_PUSH_SYS_MODEL_DEDUPE_FAILED');
    }
  }

  const modelRowsWithProps = await client
    .model(SYS_MODEL)
    .query()
    .group('modelOwnsProps')
    .execute({ includeRelates: true });
  const propIdsByModelId = new Map<string, Map<string, string>>();
  for (const r of Array.isArray(modelRowsWithProps) ? modelRowsWithProps : []) {
    const d = hydrate(r);
    const modelId = typeof d._id === 'string' ? d._id : '';
    if (!modelId || d.library_code !== code) {
      continue;
    }
    const map = propIdsByModelId.get(modelId) ?? new Map<string, string>();
    const duplicateIds: string[] = [];
    const rel = d.relates as Record<string, unknown> | undefined;
    const slot = rel?.modelOwnsProps;
    if (Array.isArray(slot)) {
      for (const p of slot as Record<string, unknown>[]) {
        if (typeof p.engine_name === 'string' && typeof p._id === 'string') {
          if (map.has(p.engine_name)) {
            duplicateIds.push(p._id);
          } else {
            map.set(p.engine_name, p._id);
          }
        }
      }
    }
    if (duplicateIds.length > 0) {
      const { failureCount } = await client.batchDelete(
        duplicateIds.map((id) => ({ model: SYS_PROPS, id })),
        { sync: true },
      );
      if (failureCount > 0) {
        throw new Error('DESIGNER_PUSH_SYS_PROPS_DEDUPE_FAILED');
      }
    }
    propIdsByModelId.set(modelId, map);
  }
  const existingPropRowsById = await loadLibraryRowsById(client, SYS_PROPS, code);

  const newPropRows: Array<Record<string, unknown>> = [];
  const propUpdates: Array<{ model: string; id: string; partial: Record<string, unknown> }> = [];
  const propBindings: Array<{ modelId: string; propId: string }> = [];
  for (const model of data.models) {
    const storageModelId = modelStorageIdByCanvasId.get(model.id) ?? model.id;
    const existingFields = propIdsByModelId.get(storageModelId) ?? new Map<string, string>();
    for (let sort = 0; sort < model.props_objects_array.length; sort++) {
      const prop = model.props_objects_array[sort]!;
      const existingPropId =
        prop.id && existingPropRowsById.has(prop.id) ? prop.id : existingFields.get(prop.name);
      const propId = existingPropId ?? prop.id ?? createUuid();
      const alreadyBound = existingFields.has(prop.name);
      const partial = {
        engine_name: prop.name,
        model_engine_name: model.model_name,
        library_code: code,
        name: prop.name_i18n ?? {},
        description: prop.description_i18n ?? { en: '', zh: '', ja: '' },
        engineType: prop.engine_type ?? dataTypeToEngineCode(normalizeLegacyPropType(prop.type)),
        sort: prop.sort ?? sort,
        isRequired: prop.is_required ?? false,
        isPrimary: prop.is_primary ?? false,
        vaultKey: prop.vault_key ?? '',
      };
      if (existingPropRowsById.has(propId)) {
        propUpdates.push({ model: SYS_PROPS, id: propId, partial });
        if (!alreadyBound) {
          propBindings.push({ modelId: storageModelId, propId });
        }
        existingFields.set(prop.name, propId);
        continue;
      }
      if (alreadyBound) {
        continue;
      }
      newPropRows.push({
        _id: propId,
        ...partial,
      });
      propBindings.push({ modelId: storageModelId, propId });
      existingFields.set(prop.name, propId);
    }
    propIdsByModelId.set(storageModelId, existingFields);
  }

  if (propUpdates.length > 0) {
    const { failureCount } = await client.batchUpdate(propUpdates, { sync: true });
    if (failureCount > 0) {
      throw new Error('DESIGNER_PUSH_SYS_PROPS_UPDATE_FAILED');
    }
  }

  if (newPropRows.length > 0) {
    const { failureCount } = await client.model(SYS_PROPS).insertMany(newPropRows, { sync: true });
    if (failureCount > 0) {
      throw new Error('DESIGNER_PUSH_SYS_PROPS_INSERT_FAILED');
    }
  }

  for (const { modelId, propId } of propBindings) {
    try {
      await client.bindRelation(
        { model: SYS_MODEL, id: modelId },
        { model: SYS_PROPS, id: propId },
        'modelOwnsProps',
        'propOwnedByModel',
      );
    } catch {
      /* idempotent */
    }
  }

  const existingRelationRowsById = await loadLibraryRowsById(client, SYS_RELATION_DEF, code);
  const relationIdByStorageKey = new Map<string, string>();
  const duplicateRelationIdsByStorageKey = new Map<string, string[]>();
  for (const [id, row] of existingRelationRowsById) {
    const storageKey = relationStorageKeyFromRow(row);
    if (storageKey) {
      const existing = relationIdByStorageKey.get(storageKey);
      if (existing) {
        duplicateRelationIdsByStorageKey.set(storageKey, [
          ...(duplicateRelationIdsByStorageKey.get(storageKey) ?? []),
          id,
        ]);
      } else {
        relationIdByStorageKey.set(storageKey, id);
      }
    }
  }
  const usedRelationStorageIds = new Set<string>();

  for (const rel of data.relations.filter((r) => !isInheritRelation(r.kind))) {
    const source = data.models.find((m) => m.id === rel.source_model_id);
    const target = data.models.find((m) => m.id === rel.target_model_id);
    if (!source || !target) {
      continue;
    }
    const engineNames = currentRelationNames(rel);
    const forward = rel.forward_name ?? engineNames.forward;
    const reverse = rel.reverse_name ?? engineNames.reverse;
    const storageKey = relationStorageKey({
      source: source.model_name,
      target: target.model_name,
      forward: engineNames.forward,
      reverse: engineNames.reverse,
    });
    const partial: Record<string, unknown> = {
      engine_name: engineNames.forward,
      library_code: code,
      name: rel.forward_name_i18n ?? {},
      description: rel.forward_description_i18n ??
        rel.description_i18n ?? { en: '', zh: '', ja: '' },
      forwardDescription: rel.forward_description_i18n ??
        rel.description_i18n ?? { en: '', zh: '', ja: '' },
      reverseDescription: rel.reverse_description_i18n ??
        rel.description_i18n ?? { en: '', zh: '', ja: '' },
      selfCardinality: rel.self_cardinality ?? '',
      sourceCardinality: relationSourceCardinality(rel),
      targetCardinality: relationTargetCardinality(rel),
      selfLoopPolicy: relationSelfLoopPolicy(rel),
      posX: rel.pos_x ?? 0,
      posY: rel.pos_y ?? 0,
      canvas_meta: JSON.stringify({
        ...parseRelationCanvasMetaField(rel.canvas_meta_str),
        forward,
        reverse,
        engineForward: engineNames.forward,
        engineReverse: engineNames.reverse,
        forwardNameI18n: rel.forward_name_i18n,
        reverseNameI18n: rel.reverse_name_i18n,
        sourceId: source.id,
        targetId: target.id,
        source: source.model_name,
        target: target.model_name,
        forwardDescription: rel.forward_description_i18n ??
          rel.description_i18n ?? { en: '', zh: '', ja: '' },
        reverseDescription: rel.reverse_description_i18n ??
          rel.description_i18n ?? { en: '', zh: '', ja: '' },
        sourceCardinality: relationSourceCardinality(rel),
        targetCardinality: relationTargetCardinality(rel),
        selfLoopPolicy: relationSelfLoopPolicy(rel),
      }),
    };
    const storageRelationId = existingRelationRowsById.has(rel.id)
      ? rel.id
      : (relationIdByStorageKey.get(storageKey) ?? rel.id);
    usedRelationStorageIds.add(storageRelationId);
    if (existingRelationRowsById.has(storageRelationId)) {
      const { failureCount } = await client.batchUpdate(
        [{ model: SYS_RELATION_DEF, id: storageRelationId, partial }],
        { sync: true },
      );
      if (failureCount > 0) {
        throw new Error('DESIGNER_PUSH_SYS_RELATION_UPDATE_FAILED');
      }
    } else {
      const { failureCount } = await client
        .model(SYS_RELATION_DEF)
        .insertMany([{ _id: storageRelationId, ...partial }], { sync: true });
      if (failureCount > 0) {
        throw new Error('DESIGNER_PUSH_SYS_RELATION_INSERT_FAILED');
      }
      existingRelationRowsById.set(storageRelationId, { _id: storageRelationId, ...partial });
      relationIdByStorageKey.set(storageKey, storageRelationId);
    }
    if (assetMapId !== undefined) {
      try {
        await client.bindRelation(
          { model: SYS_DATA_ASSET_MAP, id: assetMapId },
          { model: SYS_RELATION_DEF, id: storageRelationId },
          'assetMapIncludesRelationDefs',
          'relationDefBelongsToAssetMap',
        );
      } catch {
        /* idempotent */
      }
    }
  }

  const duplicateRelationDeletes: Array<{ model: string; id: string }> = [];
  for (const ids of duplicateRelationIdsByStorageKey.values()) {
    for (const id of ids) {
      if (!usedRelationStorageIds.has(id)) {
        duplicateRelationDeletes.push({ model: SYS_RELATION_DEF, id });
      }
    }
  }
  if (duplicateRelationDeletes.length > 0) {
    const { failureCount } = await client.batchDelete(duplicateRelationDeletes, { sync: true });
    if (failureCount > 0) {
      throw new Error('DESIGNER_PUSH_SYS_RELATION_DEDUPE_FAILED');
    }
  }
}

/**
 * 将画布 schema 注册/补全到**业务库**（Model Engine 层）。
 */
async function pushSchemaToBusinessDb(
  businessClient: RemoteModelDBClient,
  data: DataManager,
  catalog: ManagementCatalogResponse,
): Promise<void> {
  const catalogModels = new Map(catalog.models.map((m) => [m.name, m] as const));
  const modelsById = new Map(data.models.map((m) => [m.id, m] as const));
  const modelNameById = new Map(data.models.map((m) => [m.id, m.model_name] as const));

  const newModels: Array<{
    name: string;
    schema?: Record<string, string>;
    parentId?: string | null;
  }> = [];

  for (const model of data.models) {
    if (model.model_name.startsWith('sys_')) {
      continue;
    }
    const deltaProps = engineDeltaProps(model, modelsById);
    const schema = propsToFieldSchema(deltaProps);
    const catalogModel = catalogModels.get(model.model_name);

    if (!catalogModel) {
      newModels.push({
        name: model.model_name,
        schema,
        parentId: parentEngineName(model, modelsById),
      });
      continue;
    }

    const existingFields = new Set(catalogModel.fields ?? []);
    const patchFields = deltaProps.filter((p) => !existingFields.has(p.name));
    if (patchFields.length > 0) {
      await businessClient.alterModel(model.model_name, propsToFieldSchema(patchFields), {
        patch: true,
      });
    }
  }

  if (newModels.length > 0) {
    await businessClient.batchRegister({ models: newModels });
  }

  const newRelations: Array<{
    source: string;
    target: string;
    forward: string;
    reverse: string;
    logic: RelationLogicWire;
    selfLoopPolicy: 'deny' | 'allow';
  }> = [];

  for (const rel of data.relations) {
    if (isInheritRelation(rel.kind)) {
      continue;
    }
    const { forward, reverse } = currentRelationNames(rel);
    if (!forward) {
      continue;
    }
    const source = modelNameById.get(rel.source_model_id);
    const target = modelNameById.get(rel.target_model_id);
    if (!source || !target) {
      continue;
    }
    const exists = catalog.relations.some(
      (r) =>
        r.source === source &&
        r.target === target &&
        r.forward === forward &&
        r.reverse === reverse,
    );
    if (exists) {
      await businessClient.updateRelationLogic(
        forward,
        relationLogicFromCardinality(rel),
        undefined,
        relationSelfLoopPolicy(rel),
        { source, target, reverse },
      );
      continue;
    }
    newRelations.push({
      source,
      target,
      forward,
      reverse,
      logic: relationLogicFromCardinality(rel),
      selfLoopPolicy: relationSelfLoopPolicy(rel),
    });
  }

  if (newRelations.length > 0) {
    await businessClient.batchRegister({ relations: newRelations, quickLink: true });
  }
}

export interface PushLibraryParams {
  readonly designerClient: RemoteModelDBClient;
  readonly libraryCode: string;
  readonly data: DataManager;
  readonly graphSync: GraphSyncManager;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly browserSession?: boolean;
}

/**
 * 完整保存：设计器 catalog 行 + 业务库 schema 注册 + mldg 快照。
 */
export async function pushLibraryToEngine(params: PushLibraryParams): Promise<void> {
  const code = params.libraryCode.trim();
  if (!code) {
    throw new Error('DESIGNER_PUSH_NO_LIBRARY_CODE');
  }

  await pruneRemovedDesignerCatalogRows(params.designerClient, code, params.data);
  await pushDesignerCatalogRows(params.designerClient, code, params.data);

  const doc = params.data.toMldgDocument();
  doc.engine_schema.relations = doc.engine_schema.relations.map((rel) => {
    if (isInheritRelation(rel.kind)) {
      return rel;
    }
    const names = currentRelationNames(rel);
    return {
      ...rel,
      engine_forward_name: names.forward,
      engine_reverse_name: names.reverse,
    };
  });
  extractEngineModelRelationPayload(doc);
  const bytes = serializeMldgDocumentToUint8Array(doc);
  await pushDesignerSnapshot(params.designerClient, bytes, code);

  const catalogBefore = await readBusinessCatalog({
    host: params.host,
    port: params.port,
    token: params.token,
    browserSession: params.browserSession,
    businessDb: code,
  });

  const businessClient = await openWorkspaceSession({
    host: params.host,
    port: params.port,
    token: params.token,
    browserSession: params.browserSession,
    workspace: code,
  });
  try {
    await pruneRemovedBusinessSchema(businessClient, params.data, catalogBefore);
    const catalog = await readBusinessCatalog({
      host: params.host,
      port: params.port,
      token: params.token,
      browserSession: params.browserSession,
      businessDb: code,
    });
    await pushSchemaToBusinessDb(businessClient, params.data, catalog);
  } finally {
    try {
      businessClient.close();
    } catch {
      /* ignore */
    }
  }

  params.graphSync.clearDirty();
}
