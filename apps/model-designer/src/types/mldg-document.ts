import type { DesignerLayout } from './designer-layout.js';
import type { EngineSchema } from './engine-schema.js';

export interface MldgDocument {
  format: 'mldg';
  version: string;
  engine_schema: EngineSchema;
  /** 表现域（与 `designer_config` 二选一写入时以本字段为准） */
  designer_layout: DesignerLayout;
}

export function createEmptyMldgDocument(): MldgDocument {
  return {
    format: 'mldg',
    version: '1.0.0',
    engine_schema: { models: [], relations: [] },
    designer_layout: { models: [], viewport: { zoom: 1, pan_x: 0, pan_y: 0 } },
  };
}
