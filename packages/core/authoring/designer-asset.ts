import {
  computeAtlasManifestChecksum,
  fileDigest,
  isDeletedRecord,
  parseAtlasManifestJson,
  stableStringify,
  validateFieldValue,
  type AtlasManifestFileJson,
  type FieldTypeDef,
  type ModelRecord,
  type RelationIndexData,
} from '@mode-db/common';
import { AtlasSingleVault } from './atlas-single-vault.js';
import { designerInheritanceRelationId } from '@mode-db/shared';
import {
  collectAssetGraph,
  validateAssetGraph,
  type AssetGraph,
  type AssetSelection,
} from './asset-graph.js';

/** Only these Designer records are portable. Snapshots, call logs and access state are excluded. */
export const DESIGNER_ASSET_SCHEMAS = {
  sys_data_asset_map: { name: 'I18N', description: 'I18N', code: 'String' },
  sys_model: {
    name: 'I18N',
    description: 'I18N',
    color: 'Color',
    posX: 'Number',
    posY: 'Number',
    canvas_meta: 'String',
    engine_name: 'String',
    library_code: 'String',
  },
  sys_props: {
    name: 'I18N',
    description: 'I18N',
    engineType: 'Int',
    sort: 'Int',
    isRequired: 'Boolean',
    isPrimary: 'Boolean',
    vaultKey: 'String',
    engine_name: 'String',
    model_engine_name: 'String',
    library_code: 'String',
  },
  sys_relation: {
    name: 'I18N',
    description: 'I18N',
    selfCardinality: 'String',
    sourceCardinality: 'String',
    targetCardinality: 'String',
    selfLoopPolicy: 'String',
    posX: 'Number',
    posY: 'Number',
    canvas_meta: 'String',
    engine_name: 'String',
    library_code: 'String',
  },
  sys_query_interface: {
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
  sys_operation_interface: {
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
  sys_binding_surface: {
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
} as const;
export type DesignerAssetModel = keyof typeof DESIGNER_ASSET_SCHEMAS;
export interface DesignerAssetGraph {
  readonly version: 1;
  readonly rows: readonly { readonly model: DesignerAssetModel; readonly data: ModelRecord }[];
}
export interface DesignerAssetSelection extends AssetSelection {
  readonly designer: {
    readonly queries: readonly string[];
    readonly operations: readonly string[];
    readonly bindings: readonly string[];
  };
}
type Obj = Record<string, unknown>;
const fail = (): never => {
  throw new Error('DESIGNER_ASSET_INVALID');
};
const check = (value: unknown): void => {
  if (!value) {
    fail();
  }
};
const object = (value: unknown): Obj => {
  check(value && typeof value === 'object' && !Array.isArray(value));
  return value as Obj;
};
const id = (value: unknown): string => {
  check(
    typeof value === 'string' &&
      /^[\w-]{1,160}$/.test(value) &&
      !['__proto__', 'constructor', 'prototype'].includes(value),
  );
  return value as string;
};
const json = (value: unknown): Obj => object(JSON.parse(String(value)));
const jsonFields = [
  'query_json',
  'chain_json',
  'operation_json',
  'surface_json',
  'release_json',
  'release_history_json',
];
const interfaceModels = [
  'sys_query_interface',
  'sys_operation_interface',
  'sys_binding_surface',
] as const;
const logicalId = (row: ModelRecord) => String(row.interface_id ?? row.surface_id);
const draftKey = (model: string) =>
  model === 'sys_query_interface'
    ? 'query_json'
    : model === 'sys_operation_interface'
      ? 'operation_json'
      : 'surface_json';
const documentKey = (model: string) =>
  model === 'sys_query_interface'
    ? 'queryInterface'
    : model === 'sys_operation_interface'
      ? 'operationInterface'
      : 'bindingSurface';

/** Bounded JSON traversal also applies to JSON embedded in string columns. */
function visit(value: unknown, fn: (obj: Obj) => void, depth = 0, budget = { nodes: 0 }): void {
  check(depth <= 32 && ++budget.nodes <= 1000000);
  if (!value || typeof value !== 'object') {
    return;
  }
  check(
    Object.keys(value).every((key) => !['__proto__', 'constructor', 'prototype'].includes(key)),
  );
  if (!Array.isArray(value)) {
    fn(value as Obj);
  }
  for (const child of Object.values(value)) {
    visit(child, fn, depth + 1, budget);
  }
}
/** Literal/default values are data, even if their keys resemble reference fields. */
function visitReferences(value: unknown, fn: (obj: Obj) => void): void {
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (!Array.isArray(value)) {
      fn(value as Obj);
    }
    for (const [key, child] of Object.entries(value)) {
      if (!['value', 'defaultValue', 'data', 'partial', 'rows', 'sample'].includes(key)) {
        walk(child);
      }
    }
  };
  walk(value);
}
function documents(model: string, row: ModelRecord): Obj[] {
  const result = [json(row[draftKey(model)])];
  const history: unknown = row.release_history_json
    ? JSON.parse(String(row.release_history_json))
    : [];
  check(Array.isArray(history) && history.length <= 100);
  const releases = [...(history as unknown[])];
  if (row.release_json) {
    releases.push(json(row.release_json));
  }
  const versions = new Map<string, string>();
  for (const value of releases) {
    const release = object(value),
      version = String(release.version);
    check(/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(version));
    const previous = versions.get(version);
    check(!previous || previous === stableStringify(release));
    versions.set(version, stableStringify(release));
    const doc = object(release[documentKey(model)]);
    check(typeof release.signature === 'string');
    const releaseFields =
      model === 'sys_binding_surface'
        ? ['version', 'publishedAt', 'signature', 'bindingSurface', 'contract']
        : [
            'version',
            'publishedAt',
            'callableName',
            'signature',
            documentKey(model),
            'executionTemplate',
          ];
    check(Object.keys(release).every((key) => releaseFields.includes(key)));
    if (model === 'sys_binding_surface') {
      object(release.contract);
    } else {
      check(typeof release.callableName === 'string' && release.callableName.length > 0);
      object(release.executionTemplate);
    }
    check(doc.id === logicalId(row));
    result.push(doc);
  }
  check(result[0]!.id === logicalId(row));
  check(
    result.every(
      (doc) =>
        doc.kind ===
        (model === 'sys_query_interface'
          ? 'query'
          : model === 'sys_operation_interface'
            ? 'operation'
            : 'binding'),
    ),
  );
  const common = [
    'id',
    'kind',
    'name',
    'displayName',
    'description',
    'status',
    'version',
    'lifecycle',
    'tags',
  ];
  const allowed =
    model === 'sys_binding_surface'
      ? [...common, 'permissions', 'parameters', 'query', 'writeback']
      : [
          ...common,
          'namespace',
          'contract',
          'designGraph',
          'dependencies',
          model === 'sys_query_interface' ? 'query' : 'operation',
        ];
  check(result.every((doc) => Object.keys(doc).every((key) => allowed.includes(key))));
  return result;
}
/** Source policies are discarded; exported and imported releases require target reauthorization. */
function sanitize(value: unknown): unknown {
  const copy: unknown = structuredClone(value);
  visit(copy, () => undefined);
  visitReferences(copy, (obj) => {
    if (obj.kind === 'query' || obj.kind === 'operation') {
      object(obj.contract).permissions = { mode: 'disabled' };
    }
    if (obj.kind === 'binding') {
      obj.permissions = { mode: 'disabled' };
    }
    if (obj.format === 1 && obj.surfaceId && obj.writeback) {
      obj.permissions = { mode: 'disabled' };
    }
    if (obj.queryInterface || obj.operationInterface || obj.bindingSurface) {
      obj.signature = '';
    }
    if (Object.hasOwn(obj, 'permissions')) {
      obj.permissions = { mode: 'disabled' };
    }
    delete obj.createdBy;
    delete obj.updatedBy;
    delete obj.lastExecutedAt;
    if (Object.hasOwn(obj, 'sample')) {
      delete obj.sample;
    }
  });
  return copy;
}
export function designerAssetRows(vault: AtlasSingleVault, model: string): ModelRecord[] {
  const rows = new Map<string, ModelRecord>();
  for (const line of (vault.get(AtlasSingleVault.modelKey(model)) ?? '').split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const row = JSON.parse(line) as ModelRecord;
    if (!Object.hasOwn(row, '__schema__')) {
      rows.set(id(row._id), row);
    }
    check(rows.size <= 100000);
  }
  return [...rows.values()].filter((row) => !isDeletedRecord(row));
}
const modelCanvasKeys = ['position', 'color_theme', 'z_index', 'position_locked'];
const relationCanvasKeys = [
  'forward',
  'reverse',
  'engineForward',
  'engineReverse',
  'source',
  'target',
  'sourceId',
  'targetId',
  'forwardNameI18n',
  'reverseNameI18n',
  'forwardDescription',
  'reverseDescription',
  'sourceCardinality',
  'targetCardinality',
  'selfLoopPolicy',
];
function project(model: DesignerAssetModel, row: ModelRecord): ModelRecord {
  const out = Object.fromEntries(
    Object.entries(row).filter(
      ([key]) =>
        key === '_id' || key === '_createdAt' || Object.hasOwn(DESIGNER_ASSET_SCHEMAS[model], key),
    ),
  ) as ModelRecord;
  if (out.canvas_meta) {
    const meta = json(out.canvas_meta),
      keys = model === 'sys_model' ? modelCanvasKeys : relationCanvasKeys;
    out.canvas_meta = stableStringify(
      Object.fromEntries(Object.entries(meta).filter(([key]) => keys.includes(key))),
    );
  }
  for (const key of jsonFields) {
    if (out[key]) {
      out[key] = stableStringify(sanitize(JSON.parse(String(out[key]))));
    }
  }
  // A source signature no longer attests to the policy-sanitized document.
  if (interfaceModels.includes(model as (typeof interfaceModels)[number])) {
    out.signature = '';
  }
  return out;
}
function relationFor(row: ModelRecord, graph: AssetGraph) {
  const meta = json(row.canvas_meta);
  return graph.relations.find(
    ({ definition: r }) =>
      r.source === meta.source &&
      r.target === meta.target &&
      r.forward === (meta.engineForward ?? row.engine_name) &&
      r.reverse === meta.engineReverse,
  )?.definition;
}

/** Bind old ephemeral inheritance IDs to a verified direct link in the business hierarchy. */
function inheritedReferences(designer: DesignerAssetGraph, graph: AssetGraph) {
  const models = designer.rows.filter((r) => r.model === 'sys_model').map((r) => r.data);
  const refs = new Map<string, { parent: ModelRecord; child: ModelRecord }>();
  const model = (key: unknown) => {
    const found = models.filter((r) => r._id === key || r.engine_name === key);
    check(found.length === 1);
    return found[0]!;
  };
  const inspect = (obj: Obj) => {
    if (obj.inheritRelationId === undefined) {
      return;
    }
    const owner = model(obj.ownerModelId);
    let child = model(obj.childModelId);
    check(child !== owner && typeof obj.inheritRelationId === 'string');
    const visited = new Set<string>();
    while (true) {
      const name = String(child.engine_name);
      check(!visited.has(name));
      visited.add(name);
      const parentName = graph.models.find((m) => m.definition.name === name)?.definition.parentId;
      check(typeof parentName === 'string');
      if (parentName === owner.engine_name) {
        break;
      }
      child = model(parentName);
    }
    const key = String(obj.inheritRelationId);
    // A virtual identity cannot alias any persisted entity or logical/model alias.
    check(
      !designer.rows.some(
        (r) => r.data._id === key || r.data.engine_name === key || logicalId(r.data) === key,
      ),
    );
    const previous = refs.get(key);
    check(!previous || (previous.parent === owner && previous.child === child));
    refs.set(key, { parent: owner, child });
  };
  for (const { model, data } of designer.rows) {
    if (interfaceModels.includes(model as (typeof interfaceModels)[number])) {
      for (const column of jsonFields) {
        if (data[column]) {
          const decoded: unknown = JSON.parse(String(data[column]));
          visit(decoded, () => undefined);
          visitReferences(decoded, inspect);
        }
      }
    }
  }
  return refs;
}
function references(
  model: string,
  row: ModelRecord,
): { kind: string; id: string; version?: string }[] {
  const refs: { kind: string; id: string; version?: string }[] = [];
  for (const doc of documents(model, row)) {
    if (model === 'sys_binding_surface') {
      const query = object(doc.query),
        writeback = object(doc.writeback);
      refs.push({
        kind: 'sys_query_interface',
        id: id(query.interfaceId),
        version: String(query.version),
      });
      check(Array.isArray(writeback.mutations));
      for (const mutation of writeback.mutations as unknown[]) {
        const op = object(object(mutation).operation);
        refs.push({
          kind: 'sys_operation_interface',
          id: id(op.interfaceId),
          version: String(op.version),
        });
      }
    } else {
      const deps = object(doc.dependencies);
      check(
        Array.isArray(deps.models) && Array.isArray(deps.fields) && Array.isArray(deps.relations),
      );
      check(
        deps.interfaces === undefined ||
          (Array.isArray(deps.interfaces) && deps.interfaces.length === 0),
      );
      // Unversioned interface dependencies cannot be resolved safely in this format.
      visitReferences(doc, (obj) => {
        if (obj.operationInterfaceId !== undefined) {
          refs.push({ kind: 'sys_operation_interface', id: id(obj.operationInterfaceId) });
        }
      });
    }
  }
  return refs;
}
function hasVersion(row: ModelRecord, version: string): boolean {
  const releases: unknown[] = row.release_history_json
    ? JSON.parse(String(row.release_history_json))
    : [];
  if (row.release_json) {
    releases.push(json(row.release_json));
  }
  return releases.some((r) => object(r).version === version);
}

/** Compute the interface/version/model closure before collecting any business data. */
export function collectDesignerAsset(
  business: AtlasSingleVault,
  workspace: AtlasSingleVault,
  selection: DesignerAssetSelection,
): { graph: AssetGraph; designer: DesignerAssetGraph } {
  check(Object.keys(selection).sort().join() === 'designer,includeData,models');
  check(Object.keys(object(selection.designer)).sort().join() === 'bindings,operations,queries');
  check(
    Array.isArray(selection.models) &&
      selection.models.length <= 1000 &&
      new Set(selection.models).size === selection.models.length &&
      typeof selection.includeData === 'boolean',
  );
  const raw = business.get(AtlasSingleVault.manifestKey) ?? fail();
  const manifest = JSON.parse(raw) as AtlasManifestFileJson;
  parseAtlasManifestJson(raw, manifest.atlas);
  const code = manifest.atlas;
  const rows = new Map<DesignerAssetModel, ModelRecord[]>();
  for (const model of Object.keys(DESIGNER_ASSET_SCHEMAS) as DesignerAssetModel[]) {
    rows.set(
      model,
      designerAssetRows(workspace, model).filter((r) =>
        model === 'sys_data_asset_map' ? r.code === code : r.library_code === code,
      ),
    );
  }
  const maps = rows.get('sys_data_asset_map')!;
  check(maps.length <= 1);
  const selected = new Map<string, { model: DesignerAssetModel; data: ModelRecord }>();
  const include = (model: DesignerAssetModel, key: string, version?: string): void => {
    const matches = rows.get(model)!.filter((r) => logicalId(r) === key);
    check(matches.length === 1);
    const row = matches[0]!;
    if (version) {
      check(hasVersion(row, version));
    }
    const compound = model + ':' + key;
    if (selected.has(compound)) {
      return;
    }
    check(selected.size < 1000);
    selected.set(compound, { model, data: project(model, row) });
    for (const ref of references(model, row)) {
      include(ref.kind as DesignerAssetModel, ref.id, ref.version);
    }
  };
  for (const [key, model] of [
    ['queries', 'sys_query_interface'],
    ['operations', 'sys_operation_interface'],
    ['bindings', 'sys_binding_surface'],
  ] as const) {
    const list = selection.designer[key];
    check(Array.isArray(list) && list.length <= 1000 && new Set(list).size === list.length);
    for (const key of list) {
      include(model, id(key));
    }
  }
  const models = new Set(selection.models);
  const sourceModels = rows.get('sys_model')!;
  const modelName = (key: unknown): string => {
    const matches = sourceModels.filter((r) => r._id === key || r.engine_name === key);
    const name = matches.length ? String(matches[0]!.engine_name) : String(key);
    check(matches.length <= 1 && manifest.models.some((m) => m.name === name));
    return name;
  };
  for (const { model, data } of selected.values()) {
    for (const doc of documents(model, data)) {
      visitReferences(doc, (obj) => {
        for (const key of [
          'modelId',
          'rootModelId',
          'sourceModelId',
          'activeModelId',
          'targetModelId',
          'childModelId',
          'ownerModelId',
        ]) {
          if (typeof obj[key] === 'string') {
            models.add(modelName(obj[key]));
          }
        }
      });
      if (doc.dependencies) {
        for (const key of object(doc.dependencies).models as unknown[]) {
          models.add(modelName(key));
        }
      }
      const addRelation = (key: unknown): void => {
        const matches = rows.get('sys_relation')!.filter((r) => r._id === key);
        check(matches.length === 1);
        const meta = json(matches[0]!.canvas_meta);
        models.add(modelName(meta.sourceId));
        models.add(modelName(meta.targetId));
      };
      visitReferences(doc, (obj) => {
        if (typeof obj.relationId === 'string') {
          addRelation(obj.relationId);
        }
      });
      if (doc.dependencies) {
        for (const key of object(doc.dependencies).relations as unknown[]) {
          addRelation(key);
        }
      }
    }
  }
  const graph = collectAssetGraph(business, {
    models: [...models],
    includeData: selection.includeData,
  });
  const includedNames = new Set(graph.models.map((m) => m.definition.name));
  const metadata: { model: DesignerAssetModel; data: ModelRecord }[] = [];
  if (maps[0]) {
    metadata.push({ model: 'sys_data_asset_map', data: project('sys_data_asset_map', maps[0]) });
  }
  for (const model of ['sys_model', 'sys_props', 'sys_relation'] as const) {
    for (const row of rows.get(model)!) {
      if (model === 'sys_model' && !includedNames.has(String(row.engine_name))) {
        continue;
      }
      if (model === 'sys_props' && !includedNames.has(String(row.model_engine_name))) {
        continue;
      }
      if (model === 'sys_relation' && !relationFor(row, graph)) {
        continue;
      }
      metadata.push({ model, data: project(model, row) });
    }
  }
  metadata.push(...selected.values());
  const now = new Date().toISOString();
  const syntheticId = (key: string) => 'catalog_' + fileDigest(Buffer.from(key)).slice(0, 40);
  if (!maps.length) {
    metadata.push({
      model: 'sys_data_asset_map',
      data: {
        _id: syntheticId('library:' + code),
        _createdAt: now,
        code,
        name: {},
        description: {},
      },
    });
  }
  for (const { definition } of graph.models) {
    if (
      !metadata.some((row) => row.model === 'sys_model' && row.data.engine_name === definition.name)
    ) {
      metadata.push({
        model: 'sys_model',
        data: {
          _id: syntheticId('model:' + definition.name),
          _createdAt: now,
          library_code: code,
          engine_name: definition.name,
          name: {},
          description: {},
        },
      });
    }
    for (const field of definition.fields) {
      if (
        !metadata.some(
          (row) =>
            row.model === 'sys_props' &&
            row.data.model_engine_name === definition.name &&
            row.data.engine_name === field,
        )
      ) {
        metadata.push({
          model: 'sys_props',
          data: {
            _id: syntheticId('property:' + definition.name + ':' + field),
            _createdAt: now,
            library_code: code,
            model_engine_name: definition.name,
            engine_name: field,
            name: {},
            description: {},
          },
        });
      }
    }
  }
  const designer: DesignerAssetGraph = { version: 1, rows: metadata };
  validateDesignerAsset(designer, graph);
  return { graph, designer };
}

/** Independent receiver validation; no execution or whole-workspace snapshot is accepted. */
export function validateDesignerAsset(
  value: unknown,
  graph: AssetGraph,
): asserts value is DesignerAssetGraph {
  validateAssetGraph(graph);
  const root = object(value);
  check(
    Object.keys(root).sort().join() === 'rows,version' &&
      root.version === 1 &&
      Array.isArray(root.rows) &&
      root.rows.length <= 20000,
  );
  const designer = value as DesignerAssetGraph;
  check(
    designer.rows.filter((row) =>
      interfaceModels.includes(row.model as (typeof interfaceModels)[number]),
    ).length <= 1000,
  );
  const ids = new Set<string>(),
    names = new Set<string>();
  const byModel = (model: string) =>
    designer.rows.filter((row) => row.model === model).map((row) => row.data);
  const modelRows = byModel('sys_model');
  const relationIds = new Set(byModel('sys_relation').map((row) => row._id));
  const inherited = inheritedReferences(designer, graph);
  const modelName = (key: unknown): string => {
    const matches = modelRows.filter((r) => r._id === key || r.engine_name === key);
    check(matches.length <= 1);
    const name = matches.length ? String(matches[0]!.engine_name) : String(key);
    check(graph.models.some((m) => m.definition.name === name));
    return name;
  };
  const validateUsage = (value: unknown, key: string, direction: string): void => {
    const usage = object(value);
    check(usage.kind === undefined || usage.kind === 'direct' || usage.kind === 'inherited');
    if (usage.kind === 'direct') {
      check(Object.keys(usage).join() === 'kind');
      return;
    }
    check(
      Object.keys(usage).every((key) =>
        ['kind', 'childModelId', 'ownerModelId', 'inheritRelationId'].includes(key),
      ),
    );
    check(inherited.has(String(usage.inheritRelationId)));
    check(direction === 'forward' || direction === 'reverse');
    const row = byModel('sys_relation').find((r) => r._id === key) ?? fail();
    const def = relationFor(row, graph) ?? fail();
    check(modelName(usage.ownerModelId) === (direction === 'forward' ? def.source : def.target));
  };
  for (const row of designer.rows) {
    check(
      Object.keys(object(row)).sort().join() === 'data,model' &&
        Object.hasOwn(DESIGNER_ASSET_SCHEMAS, row.model),
    );
    const schema = DESIGNER_ASSET_SCHEMAS[row.model],
      data = object(row.data) as ModelRecord;
    check(!ids.has(id(data._id)));
    ids.add(data._id);
    check(typeof data._createdAt === 'string' && Number.isFinite(Date.parse(data._createdAt)));
    check(
      Object.keys(data).every(
        (key) => ['_id', '_createdAt'].includes(key) || Object.hasOwn(schema, key),
      ),
    );
    check(
      row.model === 'sys_data_asset_map'
        ? data.code === graph.atlas
        : data.library_code === graph.atlas,
    );
    for (const [key, value] of Object.entries(data)) {
      const type = (schema as Record<string, string>)[key];
      if (type) {
        check(validateFieldValue(key, value, { type } as FieldTypeDef, { diagnostics: [] }));
      }
    }
    visit(data, () => undefined);
    if (row.model === 'sys_model') {
      check(!names.has(String(data.engine_name)));
      names.add(String(data.engine_name));
      modelName(data.engine_name);
    }
    if (row.model === 'sys_props') {
      const name = modelName(data.model_engine_name),
        def = graph.models.find((m) => m.definition.name === name)!.definition;
      check(def.fields.includes(String(data.engine_name)));
      const key = name + '.' + String(data.engine_name);
      check(!names.has(key));
      names.add(key);
    }
    if (row.model === 'sys_model' || row.model === 'sys_relation') {
      if (data.canvas_meta) {
        const meta = json(data.canvas_meta),
          keys = row.model === 'sys_model' ? modelCanvasKeys : relationCanvasKeys;
        check(Object.keys(meta).every((key) => keys.includes(key)));
        visit(meta, () => undefined);
        if (row.model === 'sys_model') {
          if (meta.position) {
            const p = object(meta.position);
            check(
              Object.keys(p).sort().join() === 'x,y' &&
                typeof p.x === 'number' &&
                Number.isFinite(p.x) &&
                typeof p.y === 'number' &&
                Number.isFinite(p.y),
            );
          }
          if (meta.z_index !== undefined) {
            check(typeof meta.z_index === 'number' && Number.isFinite(meta.z_index));
          }
          if (meta.position_locked !== undefined) {
            check(typeof meta.position_locked === 'boolean');
          }
          if (meta.color_theme !== undefined) {
            check(typeof meta.color_theme === 'string');
          }
        }
      }
    }
    if (row.model === 'sys_relation') {
      const def = relationFor(data, graph) ?? fail(),
        meta = json(data.canvas_meta);
      check(modelName(meta.sourceId) === def.source && modelName(meta.targetId) === def.target);
      const key = stableStringify([def.source, def.target, def.forward]);
      check(!names.has(key));
      names.add(key);
    }
    if (interfaceModels.includes(row.model as (typeof interfaceModels)[number])) {
      id(logicalId(data));
      const key = row.model + ':' + logicalId(data);
      check(!names.has(key));
      names.add(key);
      for (const column of jsonFields) {
        if (data[column]) {
          const decoded: unknown = JSON.parse(String(data[column]));
          visit(decoded, () => undefined);
          visitReferences(decoded, (obj) => {
            check(!Object.hasOwn(obj, 'accessKeyDigest'));
            if (obj.permissions !== undefined) {
              check(stableStringify(obj.permissions) === '{"mode":"disabled"}');
            }
            for (const key of [
              'modelId',
              'rootModelId',
              'sourceModelId',
              'activeModelId',
              'targetModelId',
              'childModelId',
              'ownerModelId',
            ]) {
              if (typeof obj[key] === 'string') {
                modelName(obj[key]);
              }
            }
            if (typeof obj.originModel === 'string') {
              check(graph.models.some((m) => m.definition.name === obj.originModel));
            }
            if (typeof obj.relationId === 'string') {
              check(relationIds.has(obj.relationId));
              if (obj.inherited !== undefined) {
                validateUsage(obj.inherited, obj.relationId, String(obj.traversal));
              }
            }
            if (typeof obj.inheritRelationId === 'string') {
              check(inherited.has(obj.inheritRelationId));
            }
            if (typeof obj.model === 'string') {
              check(graph.models.some((m) => m.definition.name === obj.model));
            }
            if (typeof obj.modelId === 'string' && typeof obj.fieldId === 'string') {
              const name = modelName(obj.modelId),
                props = byModel('sys_props').filter(
                  (r) =>
                    r.model_engine_name === name &&
                    (r._id === obj.fieldId || r.engine_name === obj.fieldId),
                );
              check(props.length <= 1);
              check(
                graph.models
                  .find((m) => m.definition.name === name)!
                  .definition.fields.includes(String(props[0]?.engine_name ?? obj.fieldId)) ||
                  obj.fieldId === '_id',
              );
            }
            if (obj.dependencies) {
              const deps = object(obj.dependencies);
              check(Array.isArray(deps.models));
              for (const key of deps.models as unknown[]) {
                modelName(key);
              }
              check(Array.isArray(deps.relations));
              for (const key of deps.relations as unknown[]) {
                check(relationIds.has(String(key)));
              }
            }
            for (const key of [
              'primaryRelationIds',
              'branchRelationIds',
              'constraintRelationIds',
            ]) {
              if (obj[key] !== undefined) {
                check(Array.isArray(obj[key]));
                for (const value of obj[key] as unknown[]) {
                  check(typeof value === 'string');
                  const match =
                    /^(forward:|reverse:)?([^:]+)(?:::source::(.+))?$/.exec(value as string) ??
                    fail();
                  const key = match[2]!;
                  check(relationIds.has(key));
                  if (match[3] !== undefined) {
                    check(column === 'chain_json' && row.model === 'sys_query_interface');
                    const draftGraph = object(json(data.query_json).designGraph);
                    check(Array.isArray(draftGraph.nodes));
                    const nodes = (draftGraph.nodes as unknown[])
                      .map(object)
                      .filter((node) => node.id === match[3]);
                    check(nodes.length === 1);
                    const relation = byModel('sys_relation').find((r) => r._id === key) ?? fail();
                    const def = relationFor(relation, graph) ?? fail();
                    const usage = obj.relationUsages
                      ? object(obj.relationUsages)[value as string]
                      : undefined;
                    const ref = usage === undefined ? undefined : object(usage);
                    const source =
                      ref?.kind === 'inherited'
                        ? modelName(ref.childModelId)
                        : match[1] === 'reverse:'
                          ? def.target
                          : def.source;
                    check(modelName(nodes[0]!.modelId) === source);
                  }
                }
              }
            }
            if (obj.relationUsages !== undefined) {
              const usages = object(obj.relationUsages);
              const keys = [
                'primaryRelationIds',
                'branchRelationIds',
                'constraintRelationIds',
              ].flatMap((key) => (Array.isArray(obj[key]) ? (obj[key] as unknown[]) : []));
              for (const [key, usage] of Object.entries(usages)) {
                check(keys.includes(key));
                const ref = object(usage);
                check(ref.kind === 'direct' || ref.kind === 'inherited');
                const match = /^(forward:|reverse:)?([^:]+)(::source::.*)?$/.exec(key) ?? fail();
                validateUsage(usage, match[2]!, match[1] === 'reverse:' ? 'reverse' : 'forward');
              }
            }
          });
        }
      }
      for (const doc of documents(row.model, data)) {
        const policy =
          row.model === 'sys_binding_surface' ? doc.permissions : object(doc.contract).permissions;
        check(stableStringify(policy) === '{"mode":"disabled"}');
      }
      for (const column of ['release_json', 'release_history_json']) {
        if (data[column]) {
          const value: unknown = JSON.parse(String(data[column]));
          for (const release of Array.isArray(value) ? value : [value]) {
            const r = object(release);
            check(r.signature === '');
            if (row.model === 'sys_binding_surface') {
              check(stableStringify(object(r.contract).permissions) === '{"mode":"disabled"}');
            }
          }
        }
      }
      for (const ref of references(row.model, data)) {
        const matches = byModel(ref.kind).filter((r) => logicalId(r) === ref.id);
        check(matches.length === 1 && (!ref.version || hasVersion(matches[0]!, ref.version)));
      }
    }
  }
  check(byModel('sys_data_asset_map').length <= 1);
  check(graph.models.every((m) => modelRows.some((row) => row.engine_name === m.definition.name)));
  // The portable reference vocabulary must be unambiguous before constructing its map.
  const aliases = new Map(designer.rows.map((row) => [row.data._id, row.data]));
  for (const { model, data } of designer.rows) {
    const alias =
      model === 'sys_model'
        ? String(data.engine_name)
        : interfaceModels.includes(model as (typeof interfaceModels)[number])
          ? logicalId(data)
          : undefined;
    if (alias !== undefined) {
      check(!aliases.has(alias) || aliases.get(alias) === data);
      aliases.set(alias, data);
    }
  }
}

/** Contextual identity mapping, never a global replacement of arbitrary string values. */
export function mapDesignerAsset(
  designer: DesignerAssetGraph,
  graph: AssetGraph,
  target: string,
  mapId: (kind: string, source: string) => string,
): DesignerAssetGraph {
  validateDesignerAsset(designer, graph);
  const mappings = new Map<string, string>();
  for (const { model, data } of designer.rows) {
    mappings.set(data._id, mapId(model, data._id));
    if (interfaceModels.includes(model as (typeof interfaceModels)[number])) {
      mappings.set(logicalId(data), mapId(model, logicalId(data)));
    }
  }
  for (const { model, data } of designer.rows) {
    if (model === 'sys_model') {
      check(!mappings.has(String(data.engine_name)) || data.engine_name === data._id);
      mappings.set(String(data.engine_name), mapId(model, data._id));
    }
  }
  for (const [key, { parent, child }] of inheritedReferences(designer, graph)) {
    mappings.set(
      key,
      designerInheritanceRelationId(
        String(mappings.get(parent._id)),
        String(mappings.get(child._id)),
      ),
    );
  }
  const mapped = (key: unknown) => (typeof key === 'string' ? (mappings.get(key) ?? key) : key);
  const identityKeys = [
    'modelId',
    'rootModelId',
    'sourceModelId',
    'activeModelId',
    'targetModelId',
    'childModelId',
    'ownerModelId',
    'fieldId',
    'relationId',
    'inheritRelationId',
    'interfaceId',
    'operationInterfaceId',
    'sourceId',
    'targetId',
    'nodeId',
    'rootNodeId',
    'activeNodeId',
    'fromNodeId',
    'toNodeId',
    'sourceNodeId',
    'targetNodeId',
    'edgeId',
  ];
  const propertyId = (modelId: unknown, fieldId: unknown): unknown => {
    const model = designer.rows.find(
      (row) =>
        row.model === 'sys_model' && (row.data._id === modelId || row.data.engine_name === modelId),
    );
    const prop = designer.rows.find(
      (row) =>
        row.model === 'sys_props' &&
        row.data.model_engine_name === model?.data.engine_name &&
        (row.data._id === fieldId || row.data.engine_name === fieldId),
    );
    return prop ? mapped(prop.data._id) : mapped(fieldId);
  };
  const relationKey = (value: unknown): unknown => {
    if (typeof value !== 'string') {
      return fail();
    }
    const match = /^(forward:|reverse:)?([^:]+)(::source::.*)?$/.exec(value) ?? fail();
    let sourceNode = match[3] ?? '';
    if (sourceNode) {
      for (const [from, to] of mappings) {
        const part = from.replace(/[^a-zA-Z0-9_-]/g, '_');
        const prefix = '::source::qnode_' + part + '_';
        if (sourceNode.startsWith(prefix) && /^\d+$/.test(sourceNode.slice(prefix.length))) {
          sourceNode = '::source::qnode_' + to + '_' + sourceNode.slice(prefix.length);
          break;
        }
      }
    }
    return (match[1] ?? '') + String(mapped(match[2])) + sourceNode;
  };
  // These IDs are local to a query document, but generated IDs must follow the mapped
  // model/relation identity so reopening a chain recreates the same nodes and edges.
  const localMappings = new Map<string, string>();
  const stablePart = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  const addLocal = (from: string, to: string) => {
    check(!localMappings.has(from) || localMappings.get(from) === to);
    localMappings.set(from, to);
  };
  for (const { model, data } of designer.rows) {
    if (!interfaceModels.includes(model as (typeof interfaceModels)[number])) {
      continue;
    }
    for (const column of jsonFields) {
      if (!data[column]) {
        continue;
      }
      visitReferences(JSON.parse(String(data[column])), (obj) => {
        if (typeof obj.id === 'string' && typeof obj.modelId === 'string') {
          const prefix = 'qnode_' + stablePart(obj.modelId) + '_';
          if (obj.id.startsWith(prefix) && /^\d+$/.test(obj.id.slice(prefix.length))) {
            addLocal(
              obj.id,
              'qnode_' +
                stablePart(String(mapped(obj.modelId))) +
                '_' +
                obj.id.slice(prefix.length),
            );
          } else if (obj.id === 'node_' + obj.modelId) {
            addLocal(obj.id, 'node_' + String(mapped(obj.modelId)));
          }
        }
        for (const [column, role] of [
          ['primaryRelationIds', 'primary'],
          ['branchRelationIds', 'branch'],
          ['constraintRelationIds', 'constraint'],
        ] as const) {
          if (Array.isArray(obj[column])) {
            obj[column].forEach((key, index) => {
              check(typeof key === 'string');
              addLocal(
                'edge_qedge_' + role + '_' + stablePart(String(key)) + '_' + index,
                'edge_qedge_' + role + '_' + stablePart(String(relationKey(key))) + '_' + index,
              );
            });
          }
        }
        if (
          typeof obj.id === 'string' &&
          typeof obj.relationId === 'string' &&
          obj.id === 'edge_' + obj.relationId
        ) {
          addLocal(obj.id, 'edge_' + String(mapped(obj.relationId)));
        }
      });
    }
  }
  const identity = (value: unknown) =>
    typeof value === 'string' ? (localMappings.get(value) ?? mapped(value)) : value;
  const rewrite = (value: unknown): unknown => {
    const clone: unknown = structuredClone(value);
    visitReferences(clone, (obj) => {
      if (typeof obj.modelId === 'string' && typeof obj.fieldId === 'string') {
        obj.fieldId = propertyId(obj.modelId, obj.fieldId);
      }
      for (const key of identityKeys) {
        if (obj[key] !== undefined) {
          obj[key] = identity(obj[key]);
        }
      }
      if (typeof obj.id === 'string' && localMappings.has(obj.id)) {
        obj.id = localMappings.get(obj.id);
      }
      for (const key of [
        'readableNodes',
        'writableNodes',
        'primaryPathNodeIds',
        'primaryPath',
        'path',
      ]) {
        if (Array.isArray(obj[key])) {
          obj[key] = (obj[key] as unknown[]).map(identity);
        }
      }
      for (const key of ['fieldsByNode', 'edgesBySource']) {
        if (obj[key] !== undefined) {
          obj[key] = Object.fromEntries(
            Object.entries(object(obj[key])).map(([key, value]) => [String(identity(key)), value]),
          );
        }
      }
      for (const key of ['primaryRelationIds', 'branchRelationIds', 'constraintRelationIds']) {
        if (Array.isArray(obj[key])) {
          obj[key] = (obj[key] as unknown[]).map(relationKey);
        }
      }
      if (obj.relationUsages) {
        obj.relationUsages = Object.fromEntries(
          Object.entries(object(obj.relationUsages)).map(([key, value]) => [
            String(relationKey(key)),
            value,
          ]),
        );
      }
      if (obj.dependencies) {
        const deps = object(obj.dependencies);
        for (const key of ['models', 'relations', 'interfaces']) {
          if (Array.isArray(deps[key])) {
            deps[key] = (deps[key] as unknown[]).map(mapped);
          }
        }
        if (Array.isArray(deps.fields)) {
          deps.fields = deps.fields.map((field) => {
            if (typeof field !== 'string') {
              return fail();
            }
            const index = field.indexOf('.');
            return index < 0
              ? mapped(field)
              : String(mapped(field.slice(0, index))) +
                  '.' +
                  String(propertyId(field.slice(0, index), field.slice(index + 1)));
          });
        }
      }
    });
    return clone;
  };
  return {
    version: 1,
    rows: designer.rows.map(({ model, data }) => {
      const out: ModelRecord = { ...data, _id: String(mapped(data._id)) };
      if (model === 'sys_data_asset_map') {
        out.code = target;
      } else {
        out.library_code = target;
      }
      if (out.interface_id) {
        out.interface_id = mapped(out.interface_id);
      }
      if (out.surface_id) {
        out.surface_id = mapped(out.surface_id);
      }
      for (const key of [...jsonFields, 'canvas_meta']) {
        if (out[key]) {
          const value = rewrite(JSON.parse(String(out[key])));
          if (key === draftKey(model)) {
            object(value).id = mapped(object(value).id);
          }
          if (key === 'release_json' || key === 'release_history_json') {
            const releases = Array.isArray(value) ? value : [value];
            for (const release of releases) {
              const r = object(release),
                doc = object(r[documentKey(model)]);
              doc.id = mapped(doc.id);
              r.signature = '';
              if (model === 'sys_binding_surface') {
                object(r.contract).surfaceId = mapped(object(r.contract).surfaceId);
              }
            }
          }
          out[key] = stableStringify(value);
        }
      }
      return { model, data: out };
    }),
  };
}

/** Merge only the selected rows into a copy; existing libraries and unrelated entries survive. */
export function mergeDesignerAsset(
  vault: AtlasSingleVault,
  designer: DesignerAssetGraph,
  workspace: string,
  businessGraph?: AssetGraph,
): AtlasSingleVault {
  const copy = new AtlasSingleVault();
  for (const key of vault.keys()) {
    copy.set(key, vault.get(key)!);
  }
  const raw = copy.get(AtlasSingleVault.manifestKey);
  const manifest: AtlasManifestFileJson = raw
    ? JSON.parse(raw)
    : { version: '1.0.0', atlas: workspace, models: [], relations: [], checksum: '' };
  if (raw) {
    parseAtlasManifestJson(raw, workspace);
  }
  const models = [...manifest.models],
    relations = [...manifest.relations];
  for (const model of Object.keys(DESIGNER_ASSET_SCHEMAS) as DesignerAssetModel[]) {
    const schema = DESIGNER_ASSET_SCHEMAS[model],
      existing = models.find((m) => m.name === model);
    if (existing) {
      check(existing.parentId === null);
      for (const [key, type] of Object.entries(schema)) {
        check(!existing.fields.includes(key) || existing.fieldTypes?.[key]?.type === type);
      }
    }
    const definition = {
      name: model,
      parentId: null,
      fields: [...new Set([...(existing?.fields ?? []), ...Object.keys(schema)])],
      fieldTypes: {
        ...Object.fromEntries(Object.entries(schema).map(([key, type]) => [key, { type }])),
        ...existing?.fieldTypes,
      },
    };
    if (existing) {
      models[models.indexOf(existing)] = definition;
    } else {
      models.push(definition);
    }
    const rows = designerAssetRows(copy, model),
      ids = new Set(rows.map((r) => r._id));
    for (const row of designer.rows.filter((r) => r.model === model)) {
      check(!ids.has(row.data._id));
      rows.push(row.data);
    }
    copy.set(
      AtlasSingleVault.modelKey(model),
      [
        JSON.stringify({
          __schema__: { fields: definition.fields, fieldTypes: definition.fieldTypes },
        }),
        ...rows.map((r) => JSON.stringify(r)),
      ].join('\n') + '\n',
    );
  }
  // Rebuild ownership links for the imported subset, using the new entity identities.
  const map = designer.rows.find((r) => r.model === 'sys_data_asset_map')?.data;
  const modelRows = designer.rows.filter((r) => r.model === 'sys_model').map((r) => r.data);
  const links = [
    ['sys_data_asset_map', 'sys_model', 'assetMapIncludesModels', 'modelBelongsToAssetMap'],
    ['sys_data_asset_map', 'sys_props', 'assetMapIncludesProps', 'propBelongsToAssetMap'],
    [
      'sys_data_asset_map',
      'sys_relation',
      'assetMapIncludesRelationDefs',
      'relationDefBelongsToAssetMap',
    ],
    ['sys_model', 'sys_props', 'modelOwnsProps', 'propOwnedByModel'],
    ['sys_model', 'sys_relation', 'modelOwnsRelationDefs', 'relationDefOwnedByModel'],
  ];
  for (const [source, target, forward, reverse] of links) {
    const existing = relations.find(
      (r) => r.source === source && r.target === target && r.forward === forward,
    );
    check(!existing || (existing.reverse === reverse && existing.logic === 'one-to-many'));
    if (!existing) {
      relations.push({
        source: source!,
        target: target!,
        forward: forward!,
        reverse: reverse!,
        logic: 'one-to-many',
        matchOn: null,
      });
    }
    const key = AtlasSingleVault.relationKey(`${source}-${target}-${forward}`);
    const index: RelationIndexData = JSON.parse(copy.get(key) ?? '{"fwd":{},"rev":{}}');
    for (const row of designer.rows.filter((r) => r.model === target).map((r) => r.data)) {
      const owner =
        source === 'sys_data_asset_map'
          ? map
          : modelRows.find(
              (m) =>
                m.engine_name ===
                (target === 'sys_props' ? row.model_engine_name : json(row.canvas_meta).source),
            );
      if (!owner) {
        continue;
      }
      (index.fwd[owner._id] ??= []).push(row._id);
      (index.rev[row._id] ??= []).push(owner._id);
    }
    copy.set(key, JSON.stringify(index));
  }
  if (businessGraph?.models.some((m) => m.definition.parentId !== null)) {
    const forward = 'modelBelongsToParent',
      reverse = 'parentModelHasChildren';
    const existing = relations.find(
      (r) => r.source === 'sys_model' && r.target === 'sys_model' && r.forward === forward,
    );
    check(!existing || (existing.reverse === reverse && existing.logic === 'many-to-one'));
    if (!existing) {
      relations.push({
        source: 'sys_model',
        target: 'sys_model',
        forward,
        reverse,
        logic: 'many-to-one',
        matchOn: null,
      });
    }
    const key = AtlasSingleVault.relationKey('sys_model-sys_model-' + forward);
    const index: RelationIndexData = JSON.parse(copy.get(key) ?? '{"fwd":{},"rev":{}}');
    for (const { definition } of businessGraph.models) {
      if (definition.parentId === null) {
        continue;
      }
      const child = modelRows.find((r) => r.engine_name === definition.name) ?? fail();
      const parent = modelRows.find((r) => r.engine_name === definition.parentId) ?? fail();
      (index.fwd[child._id] ??= []).push(parent._id);
      (index.rev[parent._id] ??= []).push(child._id);
    }
    copy.set(key, JSON.stringify(index));
  }
  const updated = { version: manifest.version, atlas: workspace, models, relations };
  const text = JSON.stringify({ ...updated, checksum: computeAtlasManifestChecksum(updated) });
  parseAtlasManifestJson(text, workspace);
  copy.set(AtlasSingleVault.manifestKey, text);
  return copy;
}
