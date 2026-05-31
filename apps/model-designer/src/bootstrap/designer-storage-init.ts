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

type RelationLogicWire = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

const M2M: RelationLogicWire = 'many-to-many';
const O2M: RelationLogicWire = 'one-to-many';
const M2O: RelationLogicWire = 'many-to-one';

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

  const total = models.length + relations.length;
  let step = 0;

  for (const m of models) {
    step += 1;
    onProgress?.({ stepIndex: step, stepTotal: total, detail: m.name });
    await client.registerModel(m.name, m.schema);
  }

  for (const r of relations) {
    step += 1;
    onProgress?.({ stepIndex: step, stepTotal: total, detail: r.forward });
    await client.registerRelation(r.source, r.target, r.forward, r.reverse, r.logic);
  }

  // 旧库升级路径（patch: true 时缺则补，已存在则一律忽略）。
  const patches: Array<{ model: string; fields: Record<string, string> }> = [
    { model: SYS_MODEL, fields: { canvas_meta: 'String' } },
    { model: SYS_MODEL, fields: { engine_name: 'String' } },
    { model: SYS_MODEL, fields: { library_code: 'String' } },
    { model: SYS_RELATION_DEF, fields: { canvas_meta: 'String' } },
    { model: SYS_RELATION_DEF, fields: { engine_name: 'String' } },
    { model: SYS_RELATION_DEF, fields: { library_code: 'String' } },
    { model: SYS_PROPS, fields: { engine_name: 'String' } },
    { model: SYS_PROPS, fields: { library_code: 'String' } },
    { model: SYS_DESIGNER_GRAPH, fields: { library_code: 'String' } },
  ];
  for (const p of patches) {
    try {
      await client.alterModel(p.model, p.fields, { patch: true });
    } catch {
      /* 已存在或非 patch 场景可忽略 */
    }
  }
}
