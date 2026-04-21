import type { RemoteModelDBClient } from '@mode-db/sdk';
import { SYS_MODEL, SYS_RELATION_DEF } from '../bootstrap/designer-storage-init.js';
import type { DataManager } from './data-manager.js';

export type GraphSyncPushResult = {
  readonly successCount: number;
  readonly failureCount: number;
};

/** 与 catalog `sys_model` 对齐的 Canvas 节点同步载荷（i18n 字段为 locale → 文案）。 */
export interface CanvasNodeSyncPayload {
  readonly id: string;
  readonly name?: Record<string, string>;
  readonly description?: Record<string, string>;
  /** 引擎 `Color`：hex 字符串或 `{ r,g,b,a? }` */
  readonly color?: unknown;
  readonly x: number;
  readonly y: number;
  readonly parentId?: string | null;
  readonly isCollapsed?: boolean;
}

/** 与 `sys_relation`（关系定义实体）对齐的连线同步载荷。 */
export interface CanvasLinkSyncPayload {
  readonly id: string;
  readonly name?: Record<string, string>;
  /** 基数/语义侧（如 one | many） */
  readonly multiplicity?: string;
  readonly points?: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly sourceModelId: string;
  readonly targetModelId: string;
}

type DirtyKind = 'model' | 'relation';

function hydrateRowData(row: unknown): Record<string, unknown> {
  if (
    row &&
    typeof row === 'object' &&
    'getData' in row &&
    typeof (row as { getData?: unknown }).getData === 'function'
  ) {
    return (row as { getData: () => Record<string, unknown> }).getData();
  }
  throw new Error('GRAPH_SYNC_BAD_ROW');
}

async function modelRowExists(
  client: RemoteModelDBClient,
  model: string,
  id: string,
): Promise<boolean> {
  const raw = await client.model(model).query([id]).execute();
  if (!Array.isArray(raw) || raw.length === 0) {
    return false;
  }
  try {
    hydrateRowData(raw[0]);
    return true;
  } catch {
    return false;
  }
}

function buildModelCanvasMeta(payload: CanvasNodeSyncPayload): string {
  return JSON.stringify({
    x: payload.x,
    y: payload.y,
    isCollapsed: payload.isCollapsed ?? false,
  });
}

/**
 * 状态同步管理器：将前端 Canvas 与 ModelDB 行数据对齐。
 *
 * 说明：浏览器侧仅具备 {@link RemoteModelDBClient}（`insertMany` / `batchUpdate` / `query`），
 * 无设计稿中的 `ModelDBEngine.connect` + `session.createRelation`；层级/继承等**边**的写入需在服务端
 * AuthoringEngine 层落索引，或由后续专用 RPC 批量写关系边。此处对 `layerIds` / 父子仅保留扩展点注释。
 *
 * 设计稿关系名映射：`rel_layer_belongs_sys_model` → 注册名 `layerHasModels`；
 * `rel_model_inheritance` → `modelBelongsToParent`。
 */
export class GraphSyncManager {
  /** 脏标记：实体 id → 类型（后续可扩展为 Map&lt;id, payload&gt;） */
  private readonly dirtyQueue = new Map<string, DirtyKind>();

  get hasDirty(): boolean {
    return this.dirtyQueue.size > 0;
  }

  markModelDirty(modelId: string): void {
    this.dirtyQueue.set(modelId, 'model');
  }

  markRelationDirty(relationId: string): void {
    this.dirtyQueue.set(relationId, 'relation');
  }

  clearDirty(): void {
    this.dirtyQueue.clear();
  }

  peekDirtyModelIds(): readonly string[] {
    return [...this.dirtyQueue.entries()].filter(([, k]) => k === 'model').map(([id]) => id);
  }

  peekDirtyRelationIds(): readonly string[] {
    return [...this.dirtyQueue.entries()].filter(([, k]) => k === 'relation').map(([id]) => id);
  }

  /**
   * 拖拽等产生的布局脏数据：将 `posX`/`posY` 与 `canvas_meta` 写入 `sys_model`。
   * 关系型脏 id 暂不落库（待 `syncLink` / 折点管线）。
   */
  async push(client: RemoteModelDBClient, data: DataManager): Promise<GraphSyncPushResult> {
    const modelIds = this.peekDirtyModelIds();
    if (modelIds.length === 0) {
      return { successCount: 0, failureCount: 0 };
    }

    const updates: { model: string; id: string; partial: Record<string, unknown> }[] = [];

    for (const id of modelIds) {
      const layout = data.getLayout(id);
      if (!layout) {
        continue;
      }
      updates.push({
        model: SYS_MODEL,
        id,
        partial: {
          posX: layout.position.x,
          posY: layout.position.y,
          canvas_meta: JSON.stringify({
            position: layout.position,
            color_theme: layout.color_theme,
            z_index: layout.z_index,
            edge_bend_hints: layout.edge_bend_hints,
          }),
        },
      });
    }

    if (updates.length === 0) {
      return { successCount: 0, failureCount: 0 };
    }

    const result = await client.batchUpdate(updates, { sync: true });
    if (result.failureCount === 0) {
      for (const u of updates) {
        this.dirtyQueue.delete(u.id);
      }
    }
    return result;
  }

  /**
   * 同步模型节点行（`sys_model`）。若行已存在则 `batchUpdate`，否则 `insertMany`。
   * `layerIds` / `parentId`：全关系边需引擎侧写索引，当前 wire 未暴露 `createRelation`，调用方后续可接 server 批处理。
   */
  async syncNode(
    client: RemoteModelDBClient,
    canvasNode: CanvasNodeSyncPayload,
    _layerIds: readonly string[],
  ): Promise<void> {
    const canvas_meta = buildModelCanvasMeta(canvasNode);
    const exists = await modelRowExists(client, SYS_MODEL, canvasNode.id);

    if (exists) {
      const { failureCount } = await client.batchUpdate(
        [
          {
            model: SYS_MODEL,
            id: canvasNode.id,
            partial: {
              ...(canvasNode.name !== undefined ? { name: canvasNode.name } : {}),
              ...(canvasNode.description !== undefined
                ? { description: canvasNode.description }
                : {}),
              ...(canvasNode.color !== undefined ? { color: canvasNode.color } : {}),
              posX: canvasNode.x,
              posY: canvasNode.y,
              canvas_meta,
            },
          },
        ],
        { sync: true },
      );
      if (failureCount > 0) {
        throw new Error('GRAPH_SYNC_SYS_MODEL_UPDATE_FAILED');
      }
      return;
    }

    const row: Record<string, unknown> = {
      _id: canvasNode.id,
      name: canvasNode.name ?? { en: '' },
      description: canvasNode.description ?? {},
      color: canvasNode.color ?? '#2563eb',
      posX: canvasNode.x,
      posY: canvasNode.y,
      canvas_meta,
    };

    const { failureCount } = await client.model(SYS_MODEL).insertMany([row], { sync: true });
    if (failureCount > 0) {
      throw new Error('GRAPH_SYNC_SYS_MODEL_INSERT_FAILED');
    }

    void _layerIds;
    void canvasNode.parentId;
  }

  /**
   * 同步「关系定义」行（`sys_relation`）及折点等 `canvas_meta`。
   * 端点 `sourceModelId`/`targetModelId` 与画布边 `modelLinksOut` 的实例边对齐需引擎写边表，此处仅占位。
   */
  async syncLink(
    client: RemoteModelDBClient,
    canvasLink: CanvasLinkSyncPayload,
    _layerIds: readonly string[],
  ): Promise<void> {
    const canvas_meta = JSON.stringify({
      points: canvasLink.points ?? [],
      sourceModelId: canvasLink.sourceModelId,
      targetModelId: canvasLink.targetModelId,
    });

    const exists = await modelRowExists(client, SYS_RELATION_DEF, canvasLink.id);

    if (exists) {
      const { failureCount } = await client.batchUpdate(
        [
          {
            model: SYS_RELATION_DEF,
            id: canvasLink.id,
            partial: {
              ...(canvasLink.name !== undefined ? { name: canvasLink.name } : {}),
              ...(canvasLink.multiplicity !== undefined
                ? { selfCardinality: canvasLink.multiplicity }
                : {}),
              posX: canvasLink.points?.[0]?.x ?? 0,
              posY: canvasLink.points?.[0]?.y ?? 0,
              canvas_meta,
            },
          },
        ],
        { sync: true },
      );
      if (failureCount > 0) {
        throw new Error('GRAPH_SYNC_SYS_RELATION_UPDATE_FAILED');
      }
      return;
    }

    const row: Record<string, unknown> = {
      _id: canvasLink.id,
      name: canvasLink.name ?? { en: '' },
      description: {},
      selfCardinality: canvasLink.multiplicity ?? 'many',
      posX: canvasLink.points?.[0]?.x ?? 0,
      posY: canvasLink.points?.[0]?.y ?? 0,
      canvas_meta,
    };

    const { failureCount } = await client.model(SYS_RELATION_DEF).insertMany([row], { sync: true });
    if (failureCount > 0) {
      throw new Error('GRAPH_SYNC_SYS_RELATION_INSERT_FAILED');
    }

    void _layerIds;
  }

  /**
   * 仅批量更新坐标与 `canvas_meta` 中的 x/y（拖拽结束轻量同步）。
   */
  async batchUpdatePositions(
    client: RemoteModelDBClient,
    nodes: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>,
  ): Promise<GraphSyncPushResult> {
    if (nodes.length === 0) {
      return { successCount: 0, failureCount: 0 };
    }
    const updates = nodes.map((n) => ({
      model: SYS_MODEL,
      id: n.id,
      partial: {
        posX: n.x,
        posY: n.y,
        canvas_meta: JSON.stringify({ x: n.x, y: n.y }),
      },
    }));
    return client.batchUpdate(updates, { sync: true });
  }

  /**
   * 预留：按 `sys_data_asset_map` 递归加载 Layer → Model → Props → Relation。
   * 需与 `query().execute()` 及关系遍历 API 对齐后实现。
   */
  async loadFullGraph(_client: RemoteModelDBClient, _assetMapId: string): Promise<unknown> {
    throw new Error('GRAPH_SYNC_LOAD_FULL_GRAPH_NOT_IMPLEMENTED');
  }

  /**
   * 预留：同步 `sys_props` 并校验引擎数据类型。
   */
  async syncProperty(_client: RemoteModelDBClient, _prop: unknown): Promise<void> {
    throw new Error('GRAPH_SYNC_PROP_NOT_IMPLEMENTED');
  }
}
