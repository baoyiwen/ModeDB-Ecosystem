import type { RemoteModelDBClient } from '@mode-db/sdk';

/** 画布上的模型节点（含继承、坐标、展示字段）。 */
export const SYS_MODEL = 'sys_model';
/**
 * 「关系定义」实体（描述两个模型间的关联语义、Cardinality 一侧等），勿与引擎 RelationDefinition 混淆。
 */
export const SYS_RELATION_DEF = 'sys_relation';
/** 图层 / 分组。 */
export const SYS_LAYERS = 'sys_layers';
/** 图层渲染模式（组 / 页等），偏配置型元模型。 */
export const SYS_LAYER_TYPE = 'sys_layer_type';
/** 模型上的属性定义。 */
export const SYS_PROPS = 'sys_props';
/** 数据资产 / 图谱库登记（与逻辑工作空间等价语义）。 */
export const SYS_DATA_ASSET_MAP = 'sys_data_asset_map';
/** SDK 快照行模型（`graph_b64` push/pull 协议）。 */
export const SYS_DESIGNER_GRAPH = 'sys_designer_graph';
/** Query Designer 接口资产注册表。 */
export const SYS_QUERY_INTERFACE = 'sys_query_interface';
/** 已发布 QueryInterface 的脱敏调用审计。 */
export const SYS_QUERY_INTERFACE_CALL_LOG = 'sys_query_interface_call_log';
/** Operation Designer 写接口资产注册表。 */
export const SYS_OPERATION_INTERFACE = 'sys_operation_interface';
/** 已发布 OperationInterface 的脱敏调用审计。 */
export const SYS_OPERATION_INTERFACE_CALL_LOG = 'sys_operation_interface_call_log';
/** QueryInterface 与 OperationInterface 的版本固定组合注册表。 */
export const SYS_BINDING_SURFACE = 'sys_binding_surface';
/** 已发布 BindingSurface 的脱敏组合调用审计。 */
export const SYS_BINDING_SURFACE_CALL_LOG = 'sys_binding_surface_call_log';

type RelationLogicWire = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

const M2M: RelationLogicWire = 'many-to-many';
const O2M: RelationLogicWire = 'one-to-many';
const M2O: RelationLogicWire = 'many-to-one';
const initialized = new WeakMap<RemoteModelDBClient, Promise<void>>();

export type DesignerBootstrapProgress = {
  readonly stepIndex: number;
  readonly stepTotal: number;
  readonly detail: string;
};

/**
 * 连接工作区后注册设计器专题元数据模型与关系（幂等）。
 * 关系语义见仓库 `AGENTS.md` / 产品建模说明；此处字段类型对齐 `@mode-db/common` DataType 字面量。
 */
export async function ensureDesignerCatalog(
  client: RemoteModelDBClient,
  onProgress?: (p: DesignerBootstrapProgress) => void,
): Promise<void> {
  const existing = initialized.get(client);
  if (existing) return existing;
  const work = initializeDesignerCatalog(client, onProgress);
  initialized.set(client, work);
  try {
    await work;
  } catch (error) {
    initialized.delete(client);
    throw error;
  }
}

async function initializeDesignerCatalog(
  client: RemoteModelDBClient,
  onProgress?: (p: DesignerBootstrapProgress) => void,
): Promise<void> {
  const models: Array<{ name: string; schema: Record<string, unknown> }> = [
    {
      name: SYS_LAYER_TYPE,
      schema: {
        name: 'String',
        description: 'String',
        code: 'String',
      },
    },
    {
      name: SYS_LAYERS,
      schema: {
        name: 'I18N',
        description: 'I18N',
        forwardDescription: 'I18N',
        reverseDescription: 'I18N',
        sort: 'Int',
        icon: 'String',
        isVisible: 'Boolean',
      },
    },
    {
      name: SYS_DATA_ASSET_MAP,
      schema: {
        name: 'I18N',
        description: 'I18N',
        code: 'String',
      },
    },
    {
      name: SYS_MODEL,
      schema: {
        name: 'I18N',
        color: 'Color',
        description: 'I18N',
        posX: 'Number',
        posY: 'Number',
        /** 画布表现域 JSON（坐标、折点、折叠等），与 posX/posY 可并存 */
        canvas_meta: 'String',
        /** 业务库内引擎模型的真实标识（`ManagementCatalogModelInfo.name`）。 */
        engine_name: 'String',
        /** 隶属业务库逻辑标签（= `sys_data_asset_map.code`），与 engine_name 形成组合主键。 */
        library_code: 'String',
      },
    },
    {
      name: SYS_PROPS,
      schema: {
        name: 'I18N',
        engineType: 'Int',
        description: 'I18N',
        sort: 'Int',
        isRequired: 'Boolean',
        isPrimary: 'Boolean',
        vaultKey: 'String',
        /** 业务库模型上的字段名（与 sys_model.engine_name 共同定位）。 */
        engine_name: 'String',
        model_engine_name: 'String',
        library_code: 'String',
      },
    },
    {
      name: SYS_RELATION_DEF,
      schema: {
        name: 'I18N',
        description: 'I18N',
        /** 本侧在关系中的角色：`one` | `many`（与反向行共同描述完整 Cardinality）。 */
        selfCardinality: 'String',
        sourceCardinality: 'String',
        targetCardinality: 'String',
        selfLoopPolicy: 'String',
        posX: 'Number',
        posY: 'Number',
        canvas_meta: 'String',
        /** 业务库关系正向 label（`ManagementCatalogRelationInfo.forward`），作为业务库内唯一标识。 */
        engine_name: 'String',
        library_code: 'String',
      },
    },
    {
      name: SYS_DESIGNER_GRAPH,
      schema: {
        graph_b64: 'String',
        updated_at: 'String',
        /** 用户业务库的逻辑标签（= `sys_data_asset_map.code`），用于在共享元数据库内做多库隔离。 */
        library_code: 'String',
      },
    },
    {
      name: SYS_QUERY_INTERFACE,
      schema: {
        library_code: 'String',
        interface_id: 'String',
        display_name: 'String',
        description: 'String',
        query_json: 'String',
        chain_json: 'String',
        signature: 'String',
        created_at: 'String',
        updated_at: 'String',
        projection_configured: 'Boolean',
        release_json: 'String',
        release_history_json: 'String',
      },
    },
    {
      name: SYS_QUERY_INTERFACE_CALL_LOG,
      schema: {
        library_code: 'String',
        callable_name: 'String',
        requested_version: 'String',
        resolved_version: 'String',
        status: 'String',
        error_code: 'String',
        started_at: 'String',
        duration_ms: 'Number',
        row_count: 'Int',
        parameter_count: 'Int',
        pagination_mode: 'String',
      },
    },
    {
      name: SYS_OPERATION_INTERFACE,
      schema: {
        library_code: 'String',
        interface_id: 'String',
        display_name: 'String',
        description: 'String',
        operation_json: 'String',
        signature: 'String',
        created_at: 'String',
        updated_at: 'String',
        release_json: 'String',
        release_history_json: 'String',
      },
    },
    {
      name: SYS_OPERATION_INTERFACE_CALL_LOG,
      schema: {
        library_code: 'String',
        callable_name: 'String',
        requested_version: 'String',
        resolved_version: 'String',
        operation_type: 'String',
        status: 'String',
        error_code: 'String',
        started_at: 'String',
        duration_ms: 'Number',
        parameter_count: 'Int',
      },
    },
    {
      name: SYS_BINDING_SURFACE,
      schema: {
        library_code: 'String',
        surface_id: 'String',
        display_name: 'String',
        description: 'String',
        surface_json: 'String',
        signature: 'String',
        created_at: 'String',
        updated_at: 'String',
        release_json: 'String',
        release_history_json: 'String',
      },
    },
    {
      name: SYS_BINDING_SURFACE_CALL_LOG,
      schema: {
        library_code: 'String',
        surface_id: 'String',
        requested_version: 'String',
        resolved_version: 'String',
        action: 'String',
        mutation_id: 'String',
        status: 'String',
        error_code: 'String',
        started_at: 'String',
        duration_ms: 'Number',
        parameter_count: 'Int',
        row_count: 'Int',
      },
    },
  ];

  const relations: Array<{
    source: string;
    target: string;
    forward: string;
    reverse: string;
    logic: RelationLogicWire;
  }> = [
    /** 模型继承：子 → 父（多对一）。 */
    {
      source: SYS_MODEL,
      target: SYS_MODEL,
      forward: 'modelBelongsToParent',
      reverse: 'parentModelHasChildren',
      logic: M2O,
    },
    /** 画布上模型间无向关联（实例层连线），与继承树正交。 */
    {
      source: SYS_MODEL,
      target: SYS_MODEL,
      forward: 'modelLinksOut',
      reverse: 'modelLinksIn',
      logic: M2M,
    },
    /** 模型拥有的「关系定义」行。 */
    {
      source: SYS_MODEL,
      target: SYS_RELATION_DEF,
      forward: 'modelOwnsRelationDefs',
      reverse: 'relationDefOwnedByModel',
      logic: O2M,
    },
    /** 模型拥有的属性定义。 */
    {
      source: SYS_MODEL,
      target: SYS_PROPS,
      forward: 'modelOwnsProps',
      reverse: 'propOwnedByModel',
      logic: O2M,
    },
    /** 图层包含模型（多对多）。 */
    {
      source: SYS_LAYERS,
      target: SYS_MODEL,
      forward: 'layerHasModels',
      reverse: 'modelInLayers',
      logic: M2M,
    },
    /** 图层包含属性定义（多对多）。 */
    {
      source: SYS_LAYERS,
      target: SYS_PROPS,
      forward: 'layerHasProps',
      reverse: 'propInLayers',
      logic: M2M,
    },
    /** 图层包含关系定义（多对多）。 */
    {
      source: SYS_LAYERS,
      target: SYS_RELATION_DEF,
      forward: 'layerHasRelationDefs',
      reverse: 'relationDefInLayers',
      logic: M2M,
    },
    /** 图层类型：多图层指向同一类型（组 / 页）。 */
    {
      source: SYS_LAYERS,
      target: SYS_LAYER_TYPE,
      forward: 'layerPointsToType',
      reverse: 'layerTypeHasLayers',
      logic: M2O,
    },
    /** 数据资产图库登记 → 模型（一对多）。 */
    {
      source: SYS_DATA_ASSET_MAP,
      target: SYS_MODEL,
      forward: 'assetMapIncludesModels',
      reverse: 'modelBelongsToAssetMap',
      logic: O2M,
    },
    {
      source: SYS_DATA_ASSET_MAP,
      target: SYS_PROPS,
      forward: 'assetMapIncludesProps',
      reverse: 'propBelongsToAssetMap',
      logic: O2M,
    },
    {
      source: SYS_DATA_ASSET_MAP,
      target: SYS_RELATION_DEF,
      forward: 'assetMapIncludesRelationDefs',
      reverse: 'relationDefBelongsToAssetMap',
      logic: O2M,
    },
    {
      source: SYS_DATA_ASSET_MAP,
      target: SYS_LAYERS,
      forward: 'assetMapIncludesLayers',
      reverse: 'layerBelongsToAssetMap',
      logic: O2M,
    },
    {
      source: SYS_DATA_ASSET_MAP,
      target: SYS_LAYER_TYPE,
      forward: 'assetMapIncludesLayerTypes',
      reverse: 'layerTypeBelongsToAssetMap',
      logic: O2M,
    },
  ];

  // 旧库升级路径（patch: true 时缺则补，已存在则一律忽略）。
  const patches: Array<{ model: string; fields: Record<string, string> }> = [
    { model: SYS_MODEL, fields: { canvas_meta: 'String' } },
    { model: SYS_MODEL, fields: { engine_name: 'String' } },
    { model: SYS_MODEL, fields: { library_code: 'String' } },
    { model: SYS_RELATION_DEF, fields: { canvas_meta: 'String' } },
    { model: SYS_RELATION_DEF, fields: { forwardDescription: 'I18N' } },
    { model: SYS_RELATION_DEF, fields: { reverseDescription: 'I18N' } },
    { model: SYS_RELATION_DEF, fields: { sourceCardinality: 'String' } },
    { model: SYS_RELATION_DEF, fields: { targetCardinality: 'String' } },
    { model: SYS_RELATION_DEF, fields: { selfLoopPolicy: 'String' } },
    { model: SYS_RELATION_DEF, fields: { engine_name: 'String' } },
    { model: SYS_RELATION_DEF, fields: { library_code: 'String' } },
    { model: SYS_PROPS, fields: { engine_name: 'String' } },
    { model: SYS_PROPS, fields: { model_engine_name: 'String' } },
    { model: SYS_PROPS, fields: { library_code: 'String' } },
    { model: SYS_DESIGNER_GRAPH, fields: { library_code: 'String' } },
    { model: SYS_QUERY_INTERFACE, fields: { library_code: 'String' } },
    { model: SYS_QUERY_INTERFACE, fields: { interface_id: 'String' } },
    { model: SYS_QUERY_INTERFACE, fields: { release_json: 'String' } },
    { model: SYS_QUERY_INTERFACE, fields: { release_history_json: 'String' } },
    { model: SYS_OPERATION_INTERFACE, fields: { library_code: 'String' } },
    { model: SYS_OPERATION_INTERFACE, fields: { interface_id: 'String' } },
    { model: SYS_OPERATION_INTERFACE, fields: { release_json: 'String' } },
    { model: SYS_OPERATION_INTERFACE, fields: { release_history_json: 'String' } },
    { model: SYS_BINDING_SURFACE, fields: { library_code: 'String' } },
    { model: SYS_BINDING_SURFACE, fields: { surface_id: 'String' } },
    { model: SYS_BINDING_SURFACE, fields: { release_json: 'String' } },
    { model: SYS_BINDING_SURFACE, fields: { release_history_json: 'String' } },
    { model: SYS_BINDING_SURFACE_CALL_LOG, fields: { library_code: 'String' } },
    { model: SYS_BINDING_SURFACE_CALL_LOG, fields: { surface_id: 'String' } },
    { model: SYS_BINDING_SURFACE_CALL_LOG, fields: { status: 'String' } },
    { model: SYS_BINDING_SURFACE_CALL_LOG, fields: { error_code: 'String' } },
  ];
  const byModel = new Map<string, Record<string, string>>();
  for (const patch of patches) {
    byModel.set(patch.model, { ...byModel.get(patch.model), ...patch.fields });
  }
  for (const model of models) Object.assign(model.schema, byModel.get(model.name));
  // One authorized DDL request instead of dozens of independently audited round trips.
  const result = await client.batchRegister({ models, relations });
  const upgrades = [...byModel].filter(([model]) => result.skipped.models.includes(model));
  onProgress?.({ stepIndex: 1, stepTotal: upgrades.length + 1, detail: SYS_DATA_ASSET_MAP });
  let step = 1;
  for (const [model, fields] of upgrades) {
    await client.alterModel(model, fields, { patch: true });
    onProgress?.({ stepIndex: ++step, stepTotal: upgrades.length + 1, detail: model });
  }
}
