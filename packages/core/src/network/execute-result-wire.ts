import { HydratedEntity } from '../runtime/HydratedEntity.js';
import { isAnalysisResult } from '../runtime/transform-engine.js';
import { isPaginatedExecuteResult } from '../runtime/query.js';
import { GroupInstance } from '../runtime/group-instance.js';
import type { WireEntityNode, WireExecuteResultJson } from '@mode-db/shared';

/** Re-exported for core consumers; authoritative definition lives in **@mode-db/shared**. */
export type { WireExecuteResultJson };

function serializeEntityNode(entity: HydratedEntity): WireEntityNode {
  const snap = entity.toSnapshot();
  return {
    model: snap.model,
    data: snap.data,
    ...(snap.relates ? { relates: snap.relates } : {}),
    ...(snap.relationStatus ? { relationStatus: snap.relationStatus } : {}),
  };
}

function serializeRows(rows: HydratedEntity[]): WireExecuteResultJson {
  return {
    kind: 'rows',
    rows: rows.map((h) => serializeEntityNode(h)),
  };
}

function serializeGroups(instances: GroupInstance[]): WireExecuteResultJson {
  if (instances.length === 0) {
    return {
      kind: 'groups',
      dimensionKeys: [],
      groups: [],
    };
  }
  const dimensionKeys = instances[0]!.dimensionKeys;
  return {
    kind: 'groups',
    dimensionKeys: [...dimensionKeys],
    groups: instances.map((g) => ({
      dimensionValues: [...g.dimensionValues],
      aggregates: g.getData(),
      members: g.getEntities().map((e) => serializeEntityNode(e)),
    })),
  };
}

export function serializeExecuteResultForWire(result: unknown): WireExecuteResultJson {
  if (isPaginatedExecuteResult(result)) {
    return {
      kind: 'paginated',
      page: result.page,
      total: result.total,
      limit: result.limit,
      pageCount: result.pageCount,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      items: serializeExecuteResultForWire(result.items),
    };
  }
  if (Array.isArray(result)) {
    if (result.length === 0) {
      return { kind: 'rows', rows: [] };
    }
    if (result[0] instanceof HydratedEntity) {
      return serializeRows(result as HydratedEntity[]);
    }
    if (result[0] instanceof GroupInstance) {
      return serializeGroups(result as GroupInstance[]);
    }
  }
  if (isAnalysisResult(result)) {
    const tree = result.asTree();
    return {
      kind: 'analysis',
      dimensionKeys: result.dimensionKeys,
      shape: 'tree',
      rows: [...result.asFlatTable()] as Record<string, unknown>[],
      tree,
    };
  }
  throw new Error(`Wire serialize: unsupported execute result type ${typeof result}`);
}
