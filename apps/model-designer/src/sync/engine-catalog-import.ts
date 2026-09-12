import { RemoteModelDBClient, type ManagementCatalogResponse } from '@mode-db/sdk';
import {
  SYS_DATA_ASSET_MAP,
  SYS_MODEL,
  SYS_PROPS,
  SYS_RELATION_DEF,
} from '../bootstrap/designer-storage-init.js';
import { DataType, dataTypeToEngineCode } from '../config/engine-prop-types.js';
import { pickNewModelColorFromUsed } from '../utils/model-color-pick.js';
import { createUuid } from '../utils/random-id.js';

/**
 * 业务库 → 设计器库的**反向导入**：
 *
 * - 设计器库（`FIXED_MODEL_DESIGNER_DATABASE`）只持有 **layout / layer 等表现域**。
 * - 真正的 schema（Model / Relation / Props）住在用户业务库（Model Engine 底层）。
 * - 用户首次进入某业务库时（甚至每次进入做 diff），需要把业务库里**已经注册**过的引擎
 *   实体在设计器库内"编号入库"：写入 `sys_model` / `sys_relation` 行，并建立必要的拓扑
 *   关系（`assetMapIncludes*` / `parentModelHasChildren`），为后续保存位置 / 图层归属做铺垫。
 *
 * 当前实现：
 * - 行匹配键：`(library_code, engine_name)`；已存在则跳过，保证幂等。
 * - 不做删除（业务库内已不存在的引擎实体在设计器库保留，避免误删用户的布局）。
 * - 跳过 `sys_*` 前缀的引擎模型/关系：这些是设计器自身的 catalog（或后续可能新增的系统表），
 *   不应作为"用户业务模型"导入。
 */

interface RowDataLike {
  getData?: (deep?: boolean) => Record<string, unknown>;
}

function hydrate(row: unknown): Record<string, unknown> {
  if (row && typeof row === 'object' && typeof (row as RowDataLike).getData === 'function') {
    return (row as Required<RowDataLike>).getData(true);
  }
  // 兼容已经是 plain object 的场景。
  if (row && typeof row === 'object') {
    return row as Record<string, unknown>;
  }
  throw new Error('ENGINE_CATALOG_IMPORT_BAD_ROW');
}

async function bindRelationIdempotently(
  client: RemoteModelDBClient,
  source: { readonly model: string; readonly id: string },
  target: { readonly model: string; readonly id: string },
  forward: string,
  reverse: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await client.bindRelation(source, target, forward, reverse);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('atlas.mld')) {
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 150));
    }
  }
  throw lastError;
}

function isSystemName(name: string): boolean {
  return name.startsWith('sys_');
}

export interface BusinessCatalogParams {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly businessDb: string;
}

/**
 * 通过 REST 管理 API（`GET /api/v1/management/databases/:name/catalog`）拉取业务库的
 * 模型/关系摘要。当前接口**只**返回 `name / parentId / fields[]`，**不**含字段类型或
 * Prop 详细元数据 —— 字段类型的同步需要 server 扩展，留作下一阶段。
 */
export async function readBusinessCatalog(
  params: BusinessCatalogParams,
): Promise<ManagementCatalogResponse> {
  return RemoteModelDBClient.getDatabaseCatalog({
    host: params.host.trim(),
    port: params.port,
    token: params.token.trim(),
    database: params.businessDb.trim(),
  });
}

const emptyI18n = (): Record<string, string> => ({ en: '', zh: '', ja: '' });

const labelI18n = (s: string): Record<string, string> => ({ en: s, zh: s, ja: s });

function relationCatalogKey(input: {
  readonly source: string;
  readonly target: string;
  readonly forward: string;
  readonly reverse: string;
}): string {
  return `${input.source}\0${input.target}\0${input.forward}\0${input.reverse}`;
}

function relationRowKey(row: Record<string, unknown>): string | null {
  let forward = typeof row.engine_name === 'string' ? row.engine_name : '';
  let reverse = '';
  let source = '';
  let target = '';
  if (typeof row.canvas_meta === 'string' && row.canvas_meta.trim() !== '') {
    try {
      const meta = JSON.parse(row.canvas_meta) as Record<string, unknown>;
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
    } catch {
      /* ignore malformed relation metadata */
    }
  }
  if (!forward || !source || !target) {
    return null;
  }
  return relationCatalogKey({ source, target, forward, reverse });
}

export interface EngineCatalogImportReport {
  readonly insertedModels: number;
  readonly insertedRelations: number;
  readonly skippedSystemModels: number;
  readonly skippedSystemRelations: number;
}

/**
 * 将 {@link readBusinessCatalog} 的产物登记到设计器库。**调用前**应保证
 * `seedDefaultWorkspaceRecords` 已写入 `sys_data_asset_map.code = libraryCode` 行。
 */
export async function importEngineCatalogIntoDesignerDb(
  designerClient: RemoteModelDBClient,
  libraryCode: string,
  catalog: ManagementCatalogResponse,
): Promise<EngineCatalogImportReport> {
  const code = libraryCode.trim();
  if (!code) {
    throw new Error('ENGINE_CATALOG_IMPORT_NO_LIBRARY_CODE');
  }

  // 业务库内的实际 sys_* 不应进入用户视图；统计供观察。
  const userModels = catalog.models.filter((m) => !isSystemName(m.name));
  const userRelations = catalog.relations.filter(
    (r) => !isSystemName(r.source) && !isSystemName(r.target),
  );
  const skippedSystemModels = catalog.models.length - userModels.length;
  const skippedSystemRelations = catalog.relations.length - userRelations.length;

  // 1. 取当前 library_code 已存在的 designer-side 行索引（engine_name → designer _id）。
  const existingModelRows = await designerClient.model(SYS_MODEL).query().execute();
  const modelIdByEngineName = new Map<string, string>();
  for (const r of Array.isArray(existingModelRows) ? existingModelRows : []) {
    const d = hydrate(r);
    if (d.library_code === code && typeof d.engine_name === 'string' && d.engine_name !== '') {
      const id = typeof d._id === 'string' ? d._id : '';
      if (id !== '' && !modelIdByEngineName.has(d.engine_name)) {
        modelIdByEngineName.set(d.engine_name, id);
      }
    }
  }

  const existingRelRows = await designerClient.model(SYS_RELATION_DEF).query().execute();
  const relIdByCatalogKey = new Map<string, string>();
  for (const r of Array.isArray(existingRelRows) ? existingRelRows : []) {
    const d = hydrate(r);
    if (d.library_code === code && typeof d.engine_name === 'string' && d.engine_name !== '') {
      const id = typeof d._id === 'string' ? d._id : '';
      const key = relationRowKey(d);
      if (id !== '' && key && !relIdByCatalogKey.has(key)) {
        relIdByCatalogKey.set(key, id);
      }
    }
  }

  // 2. 取该 library 的 sys_data_asset_map 行 _id（由 seedDefaultWorkspaceRecords 写入）。
  const assetRows = await designerClient.model(SYS_DATA_ASSET_MAP).query().execute();
  let assetMapId: string | undefined;
  for (const r of Array.isArray(assetRows) ? assetRows : []) {
    const d = hydrate(r);
    if (d.code === code && typeof d._id === 'string') {
      assetMapId = d._id;
      break;
    }
  }

  // 3. 缺失的 sys_model 行批量插入；同步登记到 modelIdByEngineName。
  const usedModelColors: string[] = [];
  for (const r of Array.isArray(existingModelRows) ? existingModelRows : []) {
    const d = hydrate(r);
    if (d.library_code === code && typeof d.color === 'string') {
      usedModelColors.push(d.color);
    }
  }
  const newModelRows: Array<Record<string, unknown>> = [];
  const newModelEngineNames: string[] = [];
  for (const m of userModels) {
    if (modelIdByEngineName.has(m.name)) {
      continue;
    }
    const _id = createUuid();
    const color = pickNewModelColorFromUsed(usedModelColors);
    usedModelColors.push(color);
    newModelRows.push({
      _id,
      engine_name: m.name,
      library_code: code,
      name: labelI18n(m.name),
      description: emptyI18n(),
      color,
      posX: 0,
      posY: 0,
      canvas_meta: '',
    });
    newModelEngineNames.push(m.name);
    modelIdByEngineName.set(m.name, _id);
  }
  if (newModelRows.length > 0) {
    const { failureCount } = await designerClient
      .model(SYS_MODEL)
      .insertMany(newModelRows, { sync: true });
    if (failureCount > 0) {
      throw new Error('ENGINE_CATALOG_IMPORT_INSERT_MODEL_FAILED');
    }
  }

  // 3a. 补全已有 sys_model 行的展示名（历史导入可能只有 engine_name、无 I18N name）。
  const nameUpdates: Array<{ model: string; id: string; partial: Record<string, unknown> }> = [];
  for (const r of Array.isArray(existingModelRows) ? existingModelRows : []) {
    const d = hydrate(r);
    if (d.library_code !== code || typeof d.engine_name !== 'string') {
      continue;
    }
    const id = typeof d._id === 'string' ? d._id : '';
    if (!id) {
      continue;
    }
    const rawName = d.name;
    let needsName = rawName === undefined || rawName === null;
    if (!needsName && typeof rawName === 'object' && !Array.isArray(rawName)) {
      needsName = Object.values(rawName as Record<string, unknown>).every(
        (v) => typeof v !== 'string' || v.trim() === '',
      );
    }
    if (needsName) {
      nameUpdates.push({
        model: SYS_MODEL,
        id,
        partial: { name: labelI18n(String(d.engine_name)) },
      });
    }
  }
  if (nameUpdates.length > 0) {
    await designerClient.batchUpdate(nameUpdates, { sync: true });
  }

  // 3b. 为业务库模型字段写入 sys_props（按 catalog.fields；已绑定到模型的字段跳过）。
  const propsByModelEngine = new Map<string, Set<string>>();
  const propIdByModelField = new Map<string, Map<string, string>>();
  const boundPropIds = new Set<string>();
  const modelRowsWithProps = await designerClient
    .model(SYS_MODEL)
    .query()
    .group('modelOwnsProps')
    .execute({ includeRelates: true });
  for (const r of Array.isArray(modelRowsWithProps) ? modelRowsWithProps : []) {
    const d = hydrate(r);
    if (d.library_code !== code || typeof d.engine_name !== 'string') {
      continue;
    }
    const engineModel = String(d.engine_name);
    const set = propsByModelEngine.get(engineModel) ?? new Set<string>();
    const idMap = propIdByModelField.get(engineModel) ?? new Map<string, string>();
    const rel = d.relates as Record<string, unknown> | undefined;
    const slot = rel?.modelOwnsProps;
    if (Array.isArray(slot)) {
      for (const p of slot as Record<string, unknown>[]) {
        if (typeof p.engine_name === 'string') {
          set.add(p.engine_name);
          if (typeof p._id === 'string') {
            idMap.set(p.engine_name, p._id);
            boundPropIds.add(p._id);
          }
        }
      }
    }
    propsByModelEngine.set(engineModel, set);
    propIdByModelField.set(engineModel, idMap);
  }

  const existingPropRows = await designerClient.model(SYS_PROPS).query().execute();
  const reusablePropIdsByField = new Map<string, string[]>();
  for (const r of Array.isArray(existingPropRows) ? existingPropRows : []) {
    const d = hydrate(r);
    if (d.library_code !== code || typeof d.engine_name !== 'string') {
      continue;
    }
    const id = typeof d._id === 'string' ? d._id : '';
    if (!id) {
      continue;
    }
    if (boundPropIds.has(id)) {
      continue;
    }
    reusablePropIdsByField.set(d.engine_name, [
      ...(reusablePropIdsByField.get(d.engine_name) ?? []),
      id,
    ]);
  }

  const newPropRows: Array<Record<string, unknown>> = [];
  const propUpdates: Array<{ model: string; id: string; partial: Record<string, unknown> }> = [];
  const propBindings: Array<{ modelId: string; propId: string }> = [];
  for (const m of userModels) {
    const modelId = modelIdByEngineName.get(m.name);
    if (!modelId) {
      continue;
    }
    const existingFields = propsByModelEngine.get(m.name) ?? new Set<string>();
    const existingFieldIds = propIdByModelField.get(m.name) ?? new Map<string, string>();
    const fields = m.fields ?? [];
    for (let sort = 0; sort < fields.length; sort++) {
      const fieldName = fields[sort]!;
      if (existingFields.has(fieldName)) {
        continue;
      }
      const reusable = reusablePropIdsByField.get(fieldName)?.shift();
      const propId = reusable ?? createUuid();
      const partial = {
        engine_name: fieldName,
        library_code: code,
        name: labelI18n(fieldName),
        description: emptyI18n(),
        engineType: dataTypeToEngineCode(DataType.String),
        sort,
        isRequired: false,
        isPrimary: fieldName === 'id' || fieldName === '_id',
        vaultKey: '',
      };
      if (reusable) {
        propUpdates.push({ model: SYS_PROPS, id: propId, partial });
      } else {
        newPropRows.push({
          _id: propId,
          ...partial,
        });
      }
      propBindings.push({ modelId, propId });
      existingFields.add(fieldName);
      existingFieldIds.set(fieldName, propId);
    }
    propsByModelEngine.set(m.name, existingFields);
    propIdByModelField.set(m.name, existingFieldIds);
  }
  if (propUpdates.length > 0) {
    const { failureCount } = await designerClient.batchUpdate(propUpdates, { sync: true });
    if (failureCount > 0) {
      throw new Error('ENGINE_CATALOG_IMPORT_UPDATE_PROP_FAILED');
    }
  }
  if (newPropRows.length > 0) {
    const { failureCount } = await designerClient
      .model(SYS_PROPS)
      .insertMany(newPropRows, { sync: true });
    if (failureCount > 0) {
      throw new Error('ENGINE_CATALOG_IMPORT_INSERT_PROP_FAILED');
    }
  }
  if (propBindings.length > 0) {
    for (const { modelId, propId } of propBindings) {
      await bindRelationIdempotently(
        designerClient,
        { model: SYS_MODEL, id: modelId },
        { model: SYS_PROPS, id: propId },
        'modelOwnsProps',
        'propOwnedByModel',
      );
    }
  }

  // 4. 缺失的 sys_relation 行批量插入；关系名只在端点模型对内局部唯一。
  const newRelRows: Array<Record<string, unknown>> = [];
  const newRelationIds: string[] = [];
  for (const r of userRelations) {
    const relationKey = relationCatalogKey(r);
    if (relIdByCatalogKey.has(relationKey)) {
      continue;
    }
    const _id = createUuid();
    newRelRows.push({
      _id,
      engine_name: r.forward,
      library_code: code,
      name: labelI18n(r.forward),
      description: emptyI18n(),
      selfCardinality: '',
      selfLoopPolicy: r.selfLoopPolicy ?? 'deny',
      posX: 0,
      posY: 0,
      // 把端点信息嵌在 canvas_meta JSON 里，避免新增字段；后续若需要专用关系绑定再迁移。
      canvas_meta: JSON.stringify({
        forward: r.forward,
        reverse: r.reverse,
        source: r.source,
        target: r.target,
        selfLoopPolicy: r.selfLoopPolicy ?? 'deny',
      }),
    });
    newRelationIds.push(_id);
    relIdByCatalogKey.set(relationKey, _id);
  }
  if (newRelRows.length > 0) {
    const { failureCount } = await designerClient
      .model(SYS_RELATION_DEF)
      .insertMany(newRelRows, { sync: true });
    if (failureCount > 0) {
      throw new Error('ENGINE_CATALOG_IMPORT_INSERT_RELATION_FAILED');
    }
  }

  // 5. 建立拓扑关系：assetMap → 新模型 / 新关系；parent → child；失败一律吞掉（多为「已绑定」）。
  if (assetMapId !== undefined) {
    for (const engineName of newModelEngineNames) {
      const targetId = modelIdByEngineName.get(engineName);
      if (!targetId) continue;
      await bindRelationIdempotently(
        designerClient,
        { model: SYS_DATA_ASSET_MAP, id: assetMapId },
        { model: SYS_MODEL, id: targetId },
        'assetMapIncludesModels',
        'modelBelongsToAssetMap',
      );
    }
    for (const targetId of newRelationIds) {
      await bindRelationIdempotently(
        designerClient,
        { model: SYS_DATA_ASSET_MAP, id: assetMapId },
        { model: SYS_RELATION_DEF, id: targetId },
        'assetMapIncludesRelationDefs',
        'relationDefBelongsToAssetMap',
      );
    }
  }

  // 6. parent_id 拓扑（继承树）。对**所有**模型尝试绑定一次（含旧行），idempotent。
  for (const m of userModels) {
    if (!m.parentId) continue;
    const parentId = modelIdByEngineName.get(m.parentId);
    const childId = modelIdByEngineName.get(m.name);
    if (!parentId || !childId) continue;
    await bindRelationIdempotently(
      designerClient,
      { model: SYS_MODEL, id: childId },
      { model: SYS_MODEL, id: parentId },
      'modelBelongsToParent',
      'parentModelHasChildren',
    );
  }

  return {
    insertedModels: newModelRows.length,
    insertedRelations: newRelRows.length,
    skippedSystemModels,
    skippedSystemRelations,
  };
}
