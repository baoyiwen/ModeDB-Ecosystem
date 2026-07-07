import type { ManagementCatalogResponse, RemoteModelDBClient } from '@mode-db/sdk';
import { SYS_MODEL, SYS_PROPS, SYS_RELATION_DEF } from '../bootstrap/designer-storage-init.js';
import { DataType } from '../config/engine-prop-types.js';
import {
  GRAPH_INHERIT_KIND,
  GRAPH_NODE_LINK_KIND,
  INHERIT_RELATION_DEFAULT_NAME,
  INHERIT_RELATION_LABEL_I18N,
} from '../config/graph-edge-kinds.js';
import type { DataManager } from '../managers/data-manager.js';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { PropObject } from '../types/prop-object.js';
import type { DesignerModelLayout } from '../types/designer-layout.js';
import type { MldgDocument } from '../types/mldg-document.js';
import { pullLatestDesignerSnapshot } from './sdk-designer-sync.js';
import { parseMldgDocumentFromUint8Array } from './mldg-wire-bytes.js';

interface RowDataLike {
  getData?: (deep?: boolean) => Record<string, unknown>;
}

function hydrateRow(row: unknown): Record<string, unknown> {
  if (row && typeof row === 'object' && typeof (row as RowDataLike).getData === 'function') {
    return (row as Required<RowDataLike>).getData(true);
  }
  if (row && typeof row === 'object') {
    return row as Record<string, unknown>;
  }
  throw new Error('DESIGNER_HYDRATE_BAD_ROW');
}

function parseI18nField(value: unknown, fallback: string): Record<string, string> {
  return parseOptionalI18nField(value) ?? { en: fallback, zh: fallback, ja: fallback };
}

function parseOptionalI18nField(value: unknown): Record<string, string> | undefined {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        if (trimmed !== '') {
          return { en: trimmed, zh: trimmed, ja: trimmed };
        }
        return undefined;
      }
    } else if (trimmed !== '') {
      return { en: trimmed, zh: trimmed, ja: trimmed };
    } else {
      return undefined;
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') {
        out[k] = v;
      }
    }
    if (Object.keys(out).length > 0) {
      return out;
    }
  }
  return undefined;
}

function parseRelationDisplayI18n(
  value: unknown,
  fallback: string,
): Record<string, string> | undefined {
  const parsed = parseOptionalI18nField(value);
  if (!parsed) {
    return undefined;
  }
  const entries = Object.entries(parsed).filter(([, v]) => v.trim() !== '');
  if (
    entries.length > 0 &&
    entries.every(([, v]) => v.trim() === fallback) &&
    entries.every(([k]) => k === 'en' || k === 'zh' || k === 'ja')
  ) {
    return undefined;
  }
  return parsed;
}

function parseLayoutFromModelRow(
  row: Record<string, unknown>,
  fallback: { x: number; y: number },
): DesignerModelLayout {
  let position = { ...fallback };
  let position_locked = false;
  let color_theme = 'default';
  let z_index = 0;
  const rawMeta = row.canvas_meta;
  if (typeof rawMeta === 'string' && rawMeta.trim() !== '') {
    try {
      const meta = JSON.parse(rawMeta) as Record<string, unknown>;
      if (meta.position && typeof meta.position === 'object') {
        const p = meta.position as { x?: unknown; y?: unknown };
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          position = { x: p.x, y: p.y };
        }
      } else if (typeof meta.x === 'number' && typeof meta.y === 'number') {
        position = { x: meta.x, y: meta.y };
      }
      if (meta.position_locked === true) {
        position_locked = true;
      }
      if (typeof meta.color_theme === 'string') {
        color_theme = meta.color_theme;
      }
      if (typeof meta.z_index === 'number') {
        z_index = meta.z_index;
      }
    } catch {
      /* ignore malformed canvas_meta */
    }
  }
  if (typeof row.posX === 'number' && typeof row.posY === 'number') {
    position = { x: row.posX, y: row.posY };
  }
  if (position.x === 0 && position.y === 0) {
    position = { ...fallback };
  }
  const id = typeof row._id === 'string' ? row._id : '';
  return {
    uuid: id,
    position,
    color_theme,
    z_index,
    position_locked,
  };
}

function spreadGridPosition(index: number): { x: number; y: number } {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return { x: 80 + col * 240, y: 80 + row * 200 };
}

function propsFromCatalogFields(
  fields: readonly string[] | undefined,
  modelEngineName: string,
): PropObject[] {
  if (!fields || fields.length === 0) {
    return [];
  }
  return fields.map((fieldName, sort) => ({
    id: crypto.randomUUID(),
    name: fieldName,
    name_i18n: { en: fieldName, zh: fieldName, ja: fieldName },
    type: DataType.String,
    is_primary: fieldName === 'id' || fieldName === '_id' || fieldName === `${modelEngineName}_id`,
    encrypt_level: 0,
    metadata: {},
    sort,
    is_required: false,
  }));
}

function propFromSysRow(row: Record<string, unknown>): PropObject {
  const fieldName = typeof row.engine_name === 'string' ? row.engine_name : 'field';
  const engineType = typeof row.engineType === 'number' ? row.engineType : 0;
  const types = [
    DataType.String,
    DataType.I18N,
    DataType.Number,
    DataType.Int,
    DataType.Boolean,
    DataType.DateTime,
    DataType.JSON,
    DataType.Color,
    DataType.Unit,
  ];
  return {
    id: typeof row._id === 'string' ? row._id : crypto.randomUUID(),
    name: fieldName,
    name_i18n: parseI18nField(row.name, fieldName),
    description_i18n: parseI18nField(row.description, ''),
    type: types[engineType] ?? DataType.String,
    engine_type: engineType,
    is_primary: row.isPrimary === true,
    is_required: row.isRequired === true,
    encrypt_level: 0,
    metadata: {},
    sort: typeof row.sort === 'number' ? row.sort : 0,
    vault_key: typeof row.vaultKey === 'string' ? row.vaultKey : undefined,
  };
}

function relateChildRows(entity: Record<string, unknown>, slot: string): Record<string, unknown>[] {
  const rel = entity.relates as Record<string, unknown> | undefined;
  const raw = rel?.[slot];
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

function propRowId(row: Record<string, unknown>): string {
  return typeof row._id === 'string' ? row._id : '';
}

/**
 * 从 `sys_model.modelOwnsProps` 与 `sys_props.propOwnedByModel` 双向收集字段行。
 */
async function loadPropsByModelEngine(
  client: RemoteModelDBClient,
  libraryCode: string,
): Promise<Map<string, Record<string, unknown>[]>> {
  const code = libraryCode.trim();
  const byEngine = new Map<string, Map<string, Record<string, unknown>>>();

  const ensureBucket = (engineName: string): Map<string, Record<string, unknown>> => {
    let bucket = byEngine.get(engineName);
    if (!bucket) {
      bucket = new Map();
      byEngine.set(engineName, bucket);
    }
    return bucket;
  };

  const modelRowsRaw = await client
    .model(SYS_MODEL)
    .query()
    .group('modelOwnsProps')
    .execute({ includeRelates: true });
  for (const r of Array.isArray(modelRowsRaw) ? modelRowsRaw : []) {
    const row = hydrateRow(r);
    if (row.library_code !== code || typeof row.engine_name !== 'string') {
      continue;
    }
    const engineName = String(row.engine_name);
    const bucket = ensureBucket(engineName);
    for (const p of relateChildRows(row, 'modelOwnsProps')) {
      const id = propRowId(p);
      if (id) {
        bucket.set(id, p);
      }
    }
  }

  const propRowsRaw = await client
    .model(SYS_PROPS)
    .query()
    .group('propOwnedByModel')
    .execute({ includeRelates: true });
  for (const r of Array.isArray(propRowsRaw) ? propRowsRaw : []) {
    const row = hydrateRow(r);
    if (row.library_code !== code) {
      continue;
    }
    const propId = propRowId(row);
    if (!propId) {
      continue;
    }
    for (const parent of relateChildRows(row, 'propOwnedByModel')) {
      if (typeof parent.engine_name !== 'string' || parent.library_code !== code) {
        continue;
      }
      const engineName = String(parent.engine_name);
      ensureBucket(engineName).set(propId, row);
    }
  }

  const out = new Map<string, Record<string, unknown>[]>();
  for (const [engineName, bucket] of byEngine) {
    const rows = [...bucket.values()].sort(
      (a, b) =>
        (typeof a.sort === 'number' ? a.sort : 0) - (typeof b.sort === 'number' ? b.sort : 0),
    );
    if (rows.length > 0) {
      out.set(engineName, rows);
    }
  }
  return out;
}

function dedupePropsByName(props: readonly PropObject[]): PropObject[] {
  const seen = new Set<string>();
  const out: PropObject[] = [];
  for (const p of props) {
    if (seen.has(p.name)) {
      continue;
    }
    seen.add(p.name);
    out.push(p);
  }
  return out;
}

function parentFieldNamesFor(
  parentEngine: string | undefined,
  propsByModelEngine: Map<string, Record<string, unknown>[]>,
  catalogFieldsByModel: Map<string, readonly string[] | undefined>,
): Set<string> {
  const names = new Set<string>();
  if (!parentEngine) {
    return names;
  }
  for (const row of propsByModelEngine.get(parentEngine) ?? []) {
    if (typeof row.engine_name === 'string') {
      names.add(row.engine_name);
    }
  }
  for (const f of catalogFieldsByModel.get(parentEngine) ?? []) {
    names.add(f);
  }
  return names;
}

function dedupeModelRowsByEngine(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const byEngine = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const engineName = String(row.engine_name);
    const prev = byEngine.get(engineName);
    if (!prev) {
      byEngine.set(engineName, row);
      continue;
    }
    const prevPlaced =
      (typeof prev.posX === 'number' ? prev.posX : 0) +
      (typeof prev.posY === 'number' ? prev.posY : 0);
    const rowPlaced =
      (typeof row.posX === 'number' ? row.posX : 0) + (typeof row.posY === 'number' ? row.posY : 0);
    if (rowPlaced > prevPlaced) {
      byEngine.set(engineName, row);
    }
  }
  return [...byEngine.values()];
}

function dedupeRowsById(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const id = typeof row._id === 'string' ? row._id : '';
    if (!id || byId.has(id)) {
      continue;
    }
    byId.set(id, row);
  }
  return [...byId.values()];
}

export interface DesignerHydratedGraph {
  readonly models: EngineModelNode[];
  readonly relations: EngineRelationEdge[];
  readonly layouts: DesignerModelLayout[];
}

/**
 * 从设计器库 `sys_model` / `sys_props` / `sys_relation` 行重建 schema（名称、字段、关系）。
 */
export async function fetchGraphFromDesignerRows(
  client: RemoteModelDBClient,
  libraryCode: string,
  catalog?: ManagementCatalogResponse,
): Promise<DesignerHydratedGraph> {
  const code = libraryCode.trim();
  if (!code) {
    throw new Error('DESIGNER_HYDRATE_NO_LIBRARY_CODE');
  }

  const catalogFieldsByModel = new Map(
    (catalog?.models ?? []).map((m) => [m.name, m.fields] as const),
  );
  const catalogParentByModel = new Map(
    (catalog?.models ?? []).filter((m) => m.parentId).map((m) => [m.name, m.parentId!] as const),
  );
  const catalogRelationKeys = new Set(
    (catalog?.relations ?? []).map((r) => `${r.source}\0${r.target}\0${r.forward}\0${r.reverse}`),
  );
  const propsByModelEngine = await loadPropsByModelEngine(client, code);

  const modelRowsRaw = await client.model(SYS_MODEL).query().execute();
  const modelRows = dedupeModelRowsByEngine(
    (Array.isArray(modelRowsRaw) ? modelRowsRaw : [])
      .map((r) => hydrateRow(r))
      .filter((d) => d.library_code === code && typeof d.engine_name === 'string'),
  );

  const relRowsRaw = await client.model(SYS_RELATION_DEF).query().execute();
  const relRows = dedupeRowsById(
    (Array.isArray(relRowsRaw) ? relRowsRaw : [])
      .map((r) => hydrateRow(r))
      .filter((d) => d.library_code === code && typeof d.engine_name === 'string'),
  );

  const engineNameToId = new Map<string, string>();
  for (const row of modelRows) {
    const engineName = String(row.engine_name);
    const id = typeof row._id === 'string' ? row._id : '';
    if (id) {
      engineNameToId.set(engineName, id);
    }
  }

  const models: EngineModelNode[] = [];
  const layouts: DesignerModelLayout[] = [];

  modelRows.forEach((row, index) => {
    const id = typeof row._id === 'string' ? row._id : '';
    const engineName = String(row.engine_name);
    if (!id) {
      return;
    }

    const propRows = propsByModelEngine.get(engineName) ?? [];
    const parentEngine = catalogParentByModel.get(engineName);
    let props =
      propRows.length > 0
        ? propRows.map((p) => propFromSysRow(p))
        : propsFromCatalogFields(catalogFieldsByModel.get(engineName), engineName);
    const parentNames = parentFieldNamesFor(parentEngine, propsByModelEngine, catalogFieldsByModel);
    if (parentNames.size > 0) {
      props = props.filter((p) => !parentNames.has(p.name));
    }
    props = dedupePropsByName(props);

    const parent_id =
      parentEngine !== undefined ? (engineNameToId.get(parentEngine) ?? null) : null;

    models.push({
      id,
      model_name: engineName,
      parent_id,
      props_objects_array: props,
      name_i18n: parseI18nField(row.name, engineName),
      description_i18n: parseI18nField(row.description, ''),
      color_value: typeof row.color === 'string' ? row.color : '#7c3aed',
    });

    layouts.push(parseLayoutFromModelRow(row, spreadGridPosition(index)));
  });

  const modelIds = new Set(models.map((m) => m.id));
  const relations: EngineRelationEdge[] = [];
  for (const row of relRows) {
    const id = typeof row._id === 'string' ? row._id : '';
    if (!id) {
      continue;
    }
    let engineForward = String(row.engine_name);
    let forward = engineForward;
    let engineReverse = '';
    let reverse = '';
    let sourceEngine = '';
    let targetEngine = '';
    let sourceIdFromMeta = '';
    let targetIdFromMeta = '';
    let sourceCardinality = '';
    let targetCardinality = '';
    let selfLoopPolicy: 'deny' | 'allow' | undefined =
      row.selfLoopPolicy === 'allow' ? 'allow' : row.selfLoopPolicy === 'deny' ? 'deny' : undefined;
    let forwardNameI18nRaw: unknown = row.name;
    let reverseNameI18nRaw: unknown;
    let forwardDescriptionRaw: unknown = row.forwardDescription;
    let reverseDescriptionRaw: unknown = row.reverseDescription;
    if (typeof row.canvas_meta === 'string' && row.canvas_meta.trim() !== '') {
      try {
        const meta = JSON.parse(row.canvas_meta) as Record<string, unknown>;
        if (typeof meta.engineForward === 'string') {
          engineForward = meta.engineForward;
        }
        if (typeof meta.forward === 'string') {
          forward = meta.forward;
        }
        if (typeof meta.engineReverse === 'string') {
          engineReverse = meta.engineReverse;
        }
        if (typeof meta.reverse === 'string') {
          reverse = meta.reverse;
          if (!engineReverse) {
            engineReverse = meta.reverse;
          }
        }
        if (meta.forwardNameI18n !== undefined) {
          forwardNameI18nRaw = meta.forwardNameI18n;
        }
        if (meta.reverseNameI18n !== undefined) {
          reverseNameI18nRaw = meta.reverseNameI18n;
        }
        if (typeof meta.source === 'string') {
          sourceEngine = meta.source;
        }
        if (typeof meta.target === 'string') {
          targetEngine = meta.target;
        }
        if (typeof meta.sourceId === 'string') {
          sourceIdFromMeta = meta.sourceId;
        }
        if (typeof meta.targetId === 'string') {
          targetIdFromMeta = meta.targetId;
        }
        if (typeof meta.sourceCardinality === 'string') {
          sourceCardinality = meta.sourceCardinality;
        }
        if (typeof meta.targetCardinality === 'string') {
          targetCardinality = meta.targetCardinality;
        }
        if (meta.selfLoopPolicy === 'allow' || meta.selfLoopPolicy === 'deny') {
          selfLoopPolicy = meta.selfLoopPolicy;
        }
        if (meta.forwardDescription !== undefined) {
          forwardDescriptionRaw = meta.forwardDescription;
        }
        if (meta.reverseDescription !== undefined) {
          reverseDescriptionRaw = meta.reverseDescription;
        }
      } catch {
        /* ignore */
      }
    }
    if (!sourceCardinality && typeof row.sourceCardinality === 'string') {
      sourceCardinality = row.sourceCardinality;
    }
    if (!targetCardinality && typeof row.targetCardinality === 'string') {
      targetCardinality = row.targetCardinality;
    }
    const sourceId =
      sourceIdFromMeta && modelIds.has(sourceIdFromMeta)
        ? sourceIdFromMeta
        : engineNameToId.get(sourceEngine);
    const targetId =
      targetIdFromMeta && modelIds.has(targetIdFromMeta)
        ? targetIdFromMeta
        : engineNameToId.get(targetEngine);
    if (!sourceId || !targetId) {
      continue;
    }
    if (!engineReverse) {
      engineReverse = reverse || `${engineForward}_rev`;
    }
    const catalogRelationKey = `${sourceEngine}\0${targetEngine}\0${engineForward}\0${engineReverse}`;
    if (catalog && !catalogRelationKeys.has(catalogRelationKey)) {
      continue;
    }
    relations.push({
      id,
      source_model_id: sourceId,
      target_model_id: targetId,
      forward_name: forward,
      reverse_name: reverse || `${forward}_rev`,
      engine_forward_name: engineForward,
      engine_reverse_name: engineReverse,
      forward_name_i18n: parseRelationDisplayI18n(forwardNameI18nRaw, forward),
      reverse_name_i18n: parseRelationDisplayI18n(reverseNameI18nRaw, reverse || `${forward}_rev`),
      description_i18n: parseI18nField(row.description, ''),
      forward_description_i18n: parseI18nField(forwardDescriptionRaw ?? row.description, ''),
      reverse_description_i18n: parseI18nField(reverseDescriptionRaw ?? row.description, ''),
      self_cardinality: typeof row.selfCardinality === 'string' ? row.selfCardinality : undefined,
      source_cardinality: sourceCardinality || undefined,
      target_cardinality: targetCardinality || undefined,
      self_loop_policy: selfLoopPolicy,
      pos_x: typeof row.posX === 'number' ? row.posX : undefined,
      pos_y: typeof row.posY === 'number' ? row.posY : undefined,
      canvas_meta_str: typeof row.canvas_meta === 'string' ? row.canvas_meta : undefined,
      kind: GRAPH_NODE_LINK_KIND,
    });
  }

  for (const m of models) {
    if (!m.parent_id) {
      continue;
    }
    const inheritKey = `${m.parent_id}:${m.id}`;
    if (
      relations.some(
        (r) =>
          r.kind === GRAPH_INHERIT_KIND &&
          inheritKey === `${r.source_model_id}:${r.target_model_id}`,
      )
    ) {
      continue;
    }
    relations.push({
      id: crypto.randomUUID(),
      source_model_id: m.parent_id,
      target_model_id: m.id,
      forward_name: INHERIT_RELATION_DEFAULT_NAME,
      forward_name_i18n: { ...INHERIT_RELATION_LABEL_I18N },
      kind: GRAPH_INHERIT_KIND,
    });
  }

  return { models, relations, layouts };
}

function overlayLayoutsFromMldg(
  hydrated: DesignerHydratedGraph,
  doc: MldgDocument,
): DesignerModelLayout[] {
  const layoutById = new Map(doc.designer_layout.models.map((l) => [l.uuid, l] as const));
  const layoutByEngineName = new Map<string, DesignerModelLayout>();
  for (const m of doc.engine_schema.models) {
    const layout = layoutById.get(m.id);
    if (layout) {
      layoutByEngineName.set(m.model_name, layout);
    }
  }

  return hydrated.layouts.map((layout, index) => {
    const model = hydrated.models[index];
    if (!model) {
      return layout;
    }
    const overlay = layoutByEngineName.get(model.model_name) ?? layoutById.get(model.id);
    if (!overlay) {
      return layout;
    }
    return {
      ...overlay,
      uuid: model.id,
    };
  });
}

/** 从 mldg 快照恢复继承边的展示名 / 描述 / 画布元数据（catalog 行不存继承边）。 */
function overlayModelsFromMldg(
  models: readonly EngineModelNode[],
  doc: MldgDocument,
): EngineModelNode[] {
  const overlayById = new Map(doc.engine_schema.models.map((m) => [m.id, m] as const));
  const overlayByEngineName = new Map(
    doc.engine_schema.models.map((m) => [m.model_name, m] as const),
  );
  return models.map((model) => {
    const overlay = overlayById.get(model.id) ?? overlayByEngineName.get(model.model_name);
    if (!overlay) {
      return model;
    }
    const propsById = new Map(overlay.props_objects_array.map((p) => [p.id, p] as const));
    const propsByName = new Map(overlay.props_objects_array.map((p) => [p.name, p] as const));
    const seenPropIds = new Set<string>();
    const seenPropNames = new Set<string>();
    const props = model.props_objects_array.map((prop) => {
      const propOverlay = propsById.get(prop.id) ?? propsByName.get(prop.name);
      if (!propOverlay) {
        seenPropIds.add(prop.id);
        seenPropNames.add(prop.name);
        return prop;
      }
      seenPropIds.add(propOverlay.id);
      seenPropNames.add(propOverlay.name);
      return {
        ...prop,
        ...propOverlay,
        name_i18n: propOverlay.name_i18n ? { ...propOverlay.name_i18n } : prop.name_i18n,
        description_i18n: propOverlay.description_i18n
          ? { ...propOverlay.description_i18n }
          : prop.description_i18n,
        metadata: { ...prop.metadata, ...propOverlay.metadata },
      };
    });
    for (const propOverlay of overlay.props_objects_array) {
      if (seenPropIds.has(propOverlay.id) || seenPropNames.has(propOverlay.name)) {
        continue;
      }
      props.push({
        ...propOverlay,
        name_i18n: propOverlay.name_i18n ? { ...propOverlay.name_i18n } : undefined,
        description_i18n: propOverlay.description_i18n
          ? { ...propOverlay.description_i18n }
          : undefined,
        metadata: { ...propOverlay.metadata },
      });
    }
    return {
      ...model,
      props_objects_array: props,
      name_i18n: overlay.name_i18n ? { ...overlay.name_i18n } : model.name_i18n,
      description_i18n: overlay.description_i18n
        ? { ...overlay.description_i18n }
        : model.description_i18n,
      color_value: overlay.color_value ?? model.color_value,
    };
  });
}

function overlayRelationsFromMldg(
  relations: readonly EngineRelationEdge[],
  doc: MldgDocument,
): EngineRelationEdge[] {
  const overlayById = new Map<string, EngineRelationEdge>();
  const inheritByPair = new Map<string, EngineRelationEdge>();
  for (const overlay of doc.engine_schema.relations) {
    overlayById.set(overlay.id, overlay);
    if (overlay.kind === GRAPH_INHERIT_KIND) {
      inheritByPair.set(`${overlay.source_model_id}:${overlay.target_model_id}`, overlay);
    }
  }
  if (overlayById.size === 0 && inheritByPair.size === 0) {
    return [...relations];
  }

  return relations.map((rel) => {
    const overlay =
      overlayById.get(rel.id) ??
      (rel.kind === GRAPH_INHERIT_KIND
        ? inheritByPair.get(`${rel.source_model_id}:${rel.target_model_id}`)
        : undefined);
    if (!overlay) {
      return rel;
    }
    return {
      ...rel,
      forward_name: overlay.forward_name ?? rel.forward_name,
      reverse_name: overlay.reverse_name ?? rel.reverse_name,
      engine_forward_name: overlay.engine_forward_name ?? rel.engine_forward_name,
      engine_reverse_name: overlay.engine_reverse_name ?? rel.engine_reverse_name,
      forward_name_i18n: overlay.forward_name_i18n
        ? { ...overlay.forward_name_i18n }
        : rel.forward_name_i18n,
      reverse_name_i18n: overlay.reverse_name_i18n
        ? { ...overlay.reverse_name_i18n }
        : rel.reverse_name_i18n,
      description_i18n: overlay.description_i18n
        ? { ...overlay.description_i18n }
        : rel.description_i18n,
      forward_description_i18n: overlay.forward_description_i18n
        ? { ...overlay.forward_description_i18n }
        : rel.forward_description_i18n,
      reverse_description_i18n: overlay.reverse_description_i18n
        ? { ...overlay.reverse_description_i18n }
        : rel.reverse_description_i18n,
      self_cardinality: overlay.self_cardinality ?? rel.self_cardinality,
      source_cardinality: overlay.source_cardinality ?? rel.source_cardinality,
      target_cardinality: overlay.target_cardinality ?? rel.target_cardinality,
      self_loop_policy: overlay.self_loop_policy ?? rel.self_loop_policy,
      canvas_meta_str: overlay.canvas_meta_str ?? rel.canvas_meta_str,
      pos_x: overlay.pos_x ?? rel.pos_x,
      pos_y: overlay.pos_y ?? rel.pos_y,
    };
  });
}

/**
 * 当 `sys_designer_graph` 尚无快照时，从设计器 catalog 行 hydration。
 */
export async function hydrateCanvasFromDesignerRows(
  client: RemoteModelDBClient,
  data: DataManager,
  libraryCode: string,
  catalog?: ManagementCatalogResponse,
): Promise<void> {
  const graph = await fetchGraphFromDesignerRows(client, libraryCode, catalog);
  data.loadHydratedGraph(graph.models, graph.relations, graph.layouts);
}

/**
 * 加载业务库画布：schema 始终来自设计器 catalog 行；布局优先叠加 mldg 快照。
 */
export async function loadLibraryCanvas(
  client: RemoteModelDBClient,
  data: DataManager,
  libraryCode: string,
  catalog?: ManagementCatalogResponse,
): Promise<void> {
  const hydrated = await fetchGraphFromDesignerRows(client, libraryCode, catalog);
  if (hydrated.models.length === 0) {
    throw new Error('DESIGNER_HYDRATE_NO_MODELS');
  }

  let models = hydrated.models;
  let layouts = hydrated.layouts;
  let relations = hydrated.relations;
  let designerLayout: MldgDocument['designer_layout'] | undefined;
  try {
    const bytes = await pullLatestDesignerSnapshot(client, libraryCode);
    const doc = parseMldgDocumentFromUint8Array(bytes);
    if (doc.engine_schema.models.length > 0) {
      models = overlayModelsFromMldg(models, doc);
      layouts = overlayLayoutsFromMldg(hydrated, doc);
      relations = overlayRelationsFromMldg(relations, doc);
      designerLayout = doc.designer_layout;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      !msg.includes('DESIGNER_SYNC_EMPTY') &&
      !msg.includes('DESIGNER_SYNC_NO_PAYLOAD') &&
      !msg.includes('DESIGNER_HYDRATE_NO_MODELS')
    ) {
      throw e;
    }
  }

  data.loadHydratedGraph(models, relations, layouts, designerLayout);
}
