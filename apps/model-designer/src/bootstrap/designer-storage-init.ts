import type { RemoteModelDBClient } from '@mode-db/sdk';

/** 设计器专题库中的节点模型（画布实体）。 */
export const SYS_NODE = 'sys_node';
/** 属性定义（无 owner_id，归属由关系表达）。 */
export const SYS_PROP = 'sys_prop';
/** 图层 / 分组容器。 */
export const SYS_LAYER = 'sys_layer';
/** SDK 快照行模型（`graph_b64` 推送协议）。 */
export const SYS_DESIGNER_GRAPH = 'sys_designer_graph';

const M2M = 'many-to-many' as const;

export type DesignerBootstrapProgress = {
  readonly stepIndex: number;
  readonly stepTotal: number;
  /** 当前步骤标识（模型名或关系 forward 名）。 */
  readonly detail: string;
};

/**
 * 连接工作区后写入专题元数据：**sys_node** / **sys_prop** / **sys_layer** / **sys_designer_graph** 及多对多关系。
 * 通过线协议在服务端引擎上幂等执行（已存在则跳过）。
 */
export async function ensureDesignerCatalog(
  client: RemoteModelDBClient,
  onProgress?: (p: DesignerBootstrapProgress) => void,
): Promise<void> {
  const models: Array<{ name: string; schema: Record<string, unknown> }> = [
    {
      name: SYS_NODE,
      schema: {
        name: 'String',
        posX: 'Number',
        posY: 'Number',
        color: 'String',
        isCollapsed: 'Boolean',
      },
    },
    {
      name: SYS_PROP,
      schema: {
        name: 'String',
        engineType: 'Int',
        isPrimary: 'Boolean',
        vaultKey: 'String',
      },
    },
    {
      name: SYS_LAYER,
      schema: {
        label: 'String',
        isVisible: 'Boolean',
        order: 'Int',
      },
    },
    {
      name: SYS_DESIGNER_GRAPH,
      schema: {
        graph_b64: 'String',
        updated_at: 'String',
      },
    },
  ];

  const relations: Array<{
    source: string;
    target: string;
    forward: string;
    reverse: string;
  }> = [
    { source: SYS_NODE, target: SYS_PROP, forward: 'nodeHasProps', reverse: 'propLinkedNodes' },
    { source: SYS_LAYER, target: SYS_NODE, forward: 'layerHasNodes', reverse: 'nodeInLayers' },
    { source: SYS_LAYER, target: SYS_PROP, forward: 'layerHasProps', reverse: 'propInLayers' },
    { source: SYS_NODE, target: SYS_NODE, forward: 'nodeLinksOut', reverse: 'nodeLinksIn' },
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
    await client.registerRelation(r.source, r.target, r.forward, r.reverse, M2M);
  }
}
