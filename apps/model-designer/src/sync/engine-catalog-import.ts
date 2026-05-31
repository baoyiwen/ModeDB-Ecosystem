import { RemoteModelDBClient, type ManagementCatalogResponse } from '@mode-db/sdk';
import {
  SYS_DATA_ASSET_MAP,
  SYS_MODEL,
  SYS_RELATION_DEF,
} from '../bootstrap/designer-storage-init.js';

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
  getData?: () => Record<string, unknown>;
}

function hydrate(row: unknown): Record<string, unknown> {
  if (row && typeof row === 'object' && typeof (row as RowDataLike).getData === 'function') {
    return (row as Required<RowDataLike>).getData();
  }
  // 兼容已经是 plain object 的场景。
  if (row && typeof row === 'object') {
    return row as Record<string, unknown>;
  }
  throw new Error('ENGINE_CATALOG_IMPORT_BAD_ROW');
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
      if (id !== '') {
        modelIdByEngineName.set(d.engine_name, id);
      }
    }
  }

  const existingRelRows = await designerClient.model(SYS_RELATION_DEF).query().execute();
  const relIdByEngineName = new Map<string, string>();
  for (const r of Array.isArray(existingRelRows) ? existingRelRows : []) {
    const d = hydrate(r);
    if (d.library_code === code && typeof d.engine_name === 'string' && d.engine_name !== '') {
      const id = typeof d._id === 'string' ? d._id : '';
      if (id !== '') {
        relIdByEngineName.set(d.engine_name, id);
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
  const newModelRows: Array<Record<string, unknown>> = [];
  const newModelEngineNames: string[] = [];
  for (const m of userModels) {
    if (modelIdByEngineName.has(m.name)) {
      continue;
    }
    const _id = crypto.randomUUID();
    newModelRows.push({
      _id,
      engine_name: m.name,
      library_code: code,
      name: labelI18n(m.name),
      description: emptyI18n(),
      color: '#7c3aed',
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

  // 4. 缺失的 sys_relation 行批量插入；engine_name 取 forward label（业务库内 forward 全局唯一）。
  const newRelRows: Array<Record<string, unknown>> = [];
  const newRelEngineNames: string[] = [];
  for (const r of userRelations) {
    if (relIdByEngineName.has(r.forward)) {
      continue;
    }
    const _id = crypto.randomUUID();
    newRelRows.push({
      _id,
      engine_name: r.forward,
      library_code: code,
      name: labelI18n(r.forward),
      description: emptyI18n(),
      selfCardinality: '',
      posX: 0,
      posY: 0,
      // 把端点信息嵌在 canvas_meta JSON 里，避免新增字段；后续若需要专用关系绑定再迁移。
      canvas_meta: JSON.stringify({
        forward: r.forward,
        reverse: r.reverse,
        source: r.source,
        target: r.target,
      }),
    });
    newRelEngineNames.push(r.forward);
    relIdByEngineName.set(r.forward, _id);
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
      try {
        await designerClient.bindRelation(
          { model: SYS_DATA_ASSET_MAP, id: assetMapId },
          { model: SYS_MODEL, id: targetId },
          'assetMapIncludesModels',
          'modelBelongsToAssetMap',
        );
      } catch {
        /* idempotent */
      }
    }
    for (const engineName of newRelEngineNames) {
      const targetId = relIdByEngineName.get(engineName);
      if (!targetId) continue;
      try {
        await designerClient.bindRelation(
          { model: SYS_DATA_ASSET_MAP, id: assetMapId },
          { model: SYS_RELATION_DEF, id: targetId },
          'assetMapIncludesRelationDefs',
          'relationDefBelongsToAssetMap',
        );
      } catch {
        /* idempotent */
      }
    }
  }

  // 6. parent_id 拓扑（继承树）。对**所有**模型尝试绑定一次（含旧行），idempotent。
  for (const m of userModels) {
    if (!m.parentId) continue;
    const parentId = modelIdByEngineName.get(m.parentId);
    const childId = modelIdByEngineName.get(m.name);
    if (!parentId || !childId) continue;
    try {
      await designerClient.bindRelation(
        { model: SYS_MODEL, id: parentId },
        { model: SYS_MODEL, id: childId },
        'parentModelHasChildren',
        'modelBelongsToParent',
      );
    } catch {
      /* 已存在则忽略 */
    }
  }

  return {
    insertedModels: newModelRows.length,
    insertedRelations: newRelRows.length,
    skippedSystemModels,
    skippedSystemRelations,
  };
}
