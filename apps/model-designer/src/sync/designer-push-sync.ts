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
import type { EngineModelNode } from '../types/engine-schema.js';
import type { PropObject } from '../types/prop-object.js';
import { readBusinessCatalog } from './engine-catalog-import.js';
import { pushDesignerSnapshot } from './sdk-designer-sync.js';
import { extractEngineModelRelationPayload } from './engine-model-relation.js';
import { serializeMldgDocumentToUint8Array } from './mldg-wire-bytes.js';

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

async function modelRowExists(
  client: RemoteModelDBClient,
  model: string,
  id: string,
): Promise<boolean> {
  const raw = await client.model(model).query([id]).execute();
  return Array.isArray(raw) && raw.length > 0;
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
  const canvasRelationForwards = new Set(
    data.relations
      .filter((r) => !isInheritRelation(r.kind))
      .map((r) => r.forward_name ?? r.kind)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

  const modelsToRemove = catalog.models.filter(
    (model) => !model.name.startsWith('sys_') && !canvasModelNames.has(model.name),
  );
  const removingModelNames = new Set(modelsToRemove.map((model) => model.name));

  // 仅显式从画布删除、且端点仍保留的关系；涉及待删模型的关系由 dropModel 一并移除。
  for (const rel of catalog.relations) {
    if (canvasRelationForwards.has(rel.forward)) {
      continue;
    }
    if (removingModelNames.has(rel.source) || removingModelNames.has(rel.target)) {
      continue;
    }
    try {
      await businessClient.dropRelation(rel.forward);
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

    const exists = await modelRowExists(client, SYS_MODEL, model.id);
    if (exists) {
      const { failureCount } = await client.batchUpdate(
        [{ model: SYS_MODEL, id: model.id, partial }],
        { sync: true },
      );
      if (failureCount > 0) {
        throw new Error('DESIGNER_PUSH_SYS_MODEL_UPDATE_FAILED');
      }
    } else {
      const { failureCount } = await client
        .model(SYS_MODEL)
        .insertMany([{ _id: model.id, ...partial }], { sync: true });
      if (failureCount > 0) {
        throw new Error('DESIGNER_PUSH_SYS_MODEL_INSERT_FAILED');
      }
    }

    if (assetMapId !== undefined) {
      try {
        await client.bindRelation(
          { model: SYS_DATA_ASSET_MAP, id: assetMapId },
          { model: SYS_MODEL, id: model.id },
          'assetMapIncludesModels',
          'modelBelongsToAssetMap',
        );
      } catch {
        /* idempotent */
      }
    }

    if (model.parent_id && data.models.some((m) => m.id === model.parent_id)) {
      try {
        await client.bindRelation(
          { model: SYS_MODEL, id: model.parent_id },
          { model: SYS_MODEL, id: model.id },
          'parentModelHasChildren',
          'modelBelongsToParent',
        );
      } catch {
        /* idempotent */
      }
    }
  }

  const modelRowsWithProps = await client
    .model(SYS_MODEL)
    .query()
    .group('modelOwnsProps')
    .execute({ includeRelates: true });
  const propsByModelId = new Map<string, Set<string>>();
  for (const r of Array.isArray(modelRowsWithProps) ? modelRowsWithProps : []) {
    const d = hydrate(r);
    const modelId = typeof d._id === 'string' ? d._id : '';
    if (!modelId || d.library_code !== code) {
      continue;
    }
    const set = propsByModelId.get(modelId) ?? new Set<string>();
    const rel = d.relates as Record<string, unknown> | undefined;
    const slot = rel?.modelOwnsProps;
    if (Array.isArray(slot)) {
      for (const p of slot as Record<string, unknown>[]) {
        if (typeof p.engine_name === 'string') {
          set.add(p.engine_name);
        }
      }
    }
    propsByModelId.set(modelId, set);
  }

  const newPropRows: Array<Record<string, unknown>> = [];
  const propBindings: Array<{ modelId: string; propId: string }> = [];
  for (const model of data.models) {
    const existingFields = propsByModelId.get(model.id) ?? new Set<string>();
    for (let sort = 0; sort < model.props_objects_array.length; sort++) {
      const prop = model.props_objects_array[sort]!;
      if (existingFields.has(prop.name)) {
        continue;
      }
      const propId = prop.id || crypto.randomUUID();
      newPropRows.push({
        _id: propId,
        engine_name: prop.name,
        library_code: code,
        name: prop.name_i18n ?? { en: prop.name, zh: prop.name, ja: prop.name },
        description: prop.description_i18n ?? { en: '', zh: '', ja: '' },
        engineType: prop.engine_type ?? dataTypeToEngineCode(normalizeLegacyPropType(prop.type)),
        sort: prop.sort ?? sort,
        isRequired: prop.is_required ?? false,
        isPrimary: prop.is_primary ?? false,
        vaultKey: prop.vault_key ?? '',
      });
      propBindings.push({ modelId: model.id, propId });
      existingFields.add(prop.name);
    }
    propsByModelId.set(model.id, existingFields);
  }

  if (newPropRows.length > 0) {
    const { failureCount } = await client.model(SYS_PROPS).insertMany(newPropRows, { sync: true });
    if (failureCount > 0) {
      throw new Error('DESIGNER_PUSH_SYS_PROPS_INSERT_FAILED');
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
  }

  for (const rel of data.relations.filter((r) => !isInheritRelation(r.kind))) {
    const source = data.models.find((m) => m.id === rel.source_model_id);
    const target = data.models.find((m) => m.id === rel.target_model_id);
    if (!source || !target) {
      continue;
    }
    const forward = rel.forward_name ?? rel.kind;
    const partial: Record<string, unknown> = {
      engine_name: forward,
      library_code: code,
      name: rel.forward_name_i18n ?? { en: forward, zh: forward, ja: forward },
      description: rel.description_i18n ?? { en: '', zh: '', ja: '' },
      selfCardinality: rel.self_cardinality ?? '',
      posX: rel.pos_x ?? 0,
      posY: rel.pos_y ?? 0,
      canvas_meta: JSON.stringify({
        forward,
        reverse: rel.reverse_name ?? `${forward}_rev`,
        source: source.model_name,
        target: target.model_name,
      }),
    };
    const exists = await modelRowExists(client, SYS_RELATION_DEF, rel.id);
    if (exists) {
      await client.batchUpdate([{ model: SYS_RELATION_DEF, id: rel.id, partial }], { sync: true });
    } else {
      const { failureCount } = await client
        .model(SYS_RELATION_DEF)
        .insertMany([{ _id: rel.id, ...partial }], { sync: true });
      if (failureCount > 0) {
        throw new Error('DESIGNER_PUSH_SYS_RELATION_INSERT_FAILED');
      }
    }
    if (assetMapId !== undefined) {
      try {
        await client.bindRelation(
          { model: SYS_DATA_ASSET_MAP, id: assetMapId },
          { model: SYS_RELATION_DEF, id: rel.id },
          'assetMapIncludesRelationDefs',
          'relationDefBelongsToAssetMap',
        );
      } catch {
        /* idempotent */
      }
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

  const catalogRelations = new Set(catalog.relations.map((r) => r.forward));
  const newRelations: Array<{
    source: string;
    target: string;
    forward: string;
    reverse: string;
    logic: 'many-to-many';
  }> = [];

  for (const rel of data.relations) {
    if (isInheritRelation(rel.kind)) {
      continue;
    }
    const forward = rel.forward_name ?? rel.kind;
    if (!forward || catalogRelations.has(forward)) {
      continue;
    }
    const source = modelNameById.get(rel.source_model_id);
    const target = modelNameById.get(rel.target_model_id);
    if (!source || !target) {
      continue;
    }
    newRelations.push({
      source,
      target,
      forward,
      reverse: rel.reverse_name ?? `${forward}_rev`,
      logic: 'many-to-many',
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

  const catalogBefore = await readBusinessCatalog({
    host: params.host,
    port: params.port,
    token: params.token,
    businessDb: code,
  });

  const businessClient = await openWorkspaceSession({
    host: params.host,
    port: params.port,
    token: params.token,
    workspace: code,
  });
  try {
    await pruneRemovedBusinessSchema(businessClient, params.data, catalogBefore);
    const catalog = await readBusinessCatalog({
      host: params.host,
      port: params.port,
      token: params.token,
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

  const doc = params.data.toMldgDocument();
  extractEngineModelRelationPayload(doc);
  const bytes = serializeMldgDocumentToUint8Array(doc);
  await pushDesignerSnapshot(params.designerClient, bytes, code);

  params.graphSync.clearDirty();
}
