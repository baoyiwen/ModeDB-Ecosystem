import type { AuthoringEngine } from '../../authoring/engine.js';

/** Model names registered by {@link registerPipeGalleryModels}. */
export type PipeGalleryModelNames = 'Pipe' | 'Node' | 'Monitor';

/**
 * 管廊行业预置 Schema：**Pipe（管段）**、**Node（节点）**、**Monitor（监测器）**。
 * 含 **required**、**Unit**（压力 Pa、管径 mm）、**Color**（管段色 / 状态色）。
 *
 * 调用方在 **`registerPipeGalleryModels(engine)`** 之后可 **`writeAtlasManifest`** / **`flushAll`**；
 * 千万级压测使用单文件 **`atlas.mld`** vault；密钥由 **`connectToken`** 派生。
 */
export function registerPipeGalleryModels(engine: AuthoringEngine): void {
  engine.registerModel('Pipe', {
    id: { type: 'String', required: true },
    name: { type: 'String', required: true },
    pressure: { type: 'Unit', unit: 'Pa', required: true },
    diameter: { type: 'Unit', unit: 'mm', required: true },
    segmentColor: { type: 'Color', required: true },
    lengthM: { type: 'Number', required: false },
  });

  engine.registerModel('Node', {
    id: { type: 'String', required: true },
    code: { type: 'String', required: true },
    position: { type: 'JSON', required: true },
    label: { type: 'String', required: false },
  });

  engine.registerModel('Monitor', {
    id: { type: 'String', required: true },
    nodeId: { type: 'String', required: true },
    pressureReading: { type: 'Unit', unit: 'Pa', required: true },
    statusColor: { type: 'Color', required: true },
    installedAt: { type: 'DateTime', required: false },
  });
}
