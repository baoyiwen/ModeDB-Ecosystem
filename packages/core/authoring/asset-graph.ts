import {
  assertFlatGraphSegment,
  computeAtlasManifestChecksum,
  isDeletedRecord,
  parseAtlasManifestJson,
  stableStringify,
  validateFieldValue,
  type AtlasManifestFileJson,
  type AtlasManifestModelJson,
  type AtlasManifestRelationJson,
  type FieldTypeDef,
  type ModelRecord,
  type RelationIndexData,
} from '@mode-db/common';
import { AtlasSingleVault } from './atlas-single-vault.js';

/** Portable, selected business content. No source vault, keys or runtime state. */
export interface AssetGraph {
  readonly version: 1;
  readonly atlas: string;
  readonly includeData: boolean;
  readonly models: readonly {
    readonly definition: AtlasManifestModelJson;
    readonly rows: readonly ModelRecord[];
  }[];
  readonly relations: readonly {
    readonly definition: AtlasManifestRelationJson;
    readonly index: RelationIndexData;
  }[];
}
export interface AssetSelection {
  readonly models: readonly string[];
  readonly includeData: boolean;
}
const fail = (): never => {
  throw new Error('ASSET_GRAPH_INVALID');
};
const check = (value: unknown): void => {
  if (!value) {
    fail();
  }
};
function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function fields(value: unknown, required: string[], optional: string[] = []): void {
  const item = object(value);
  check(required.every((key) => Object.hasOwn(item, key)));
  check(Object.keys(item).every((key) => required.includes(key) || optional.includes(key)));
}
function name(value: unknown): asserts value is string {
  check(typeof value === 'string');
  assertFlatGraphSegment(value as string, 'asset name');
  check(!['__proto__', 'prototype', 'constructor'].includes(value as string));
  check(!/[\x00-\x1f\x7f:<>"|?*]/.test(value as string));
}
const relationKey = (r: AtlasManifestRelationJson) => `${r.source}-${r.target}-${r.forward}`;
export function assetGraphStatistics(graph: AssetGraph): {
  models: number;
  fields: number;
  records: number;
  relations: number;
  edges: number;
} {
  return {
    models: graph.models.length,
    fields: graph.models.reduce((n, m) => n + m.definition.fields.length, 0),
    records: graph.models.reduce((n, m) => n + m.rows.length, 0),
    relations: graph.relations.length,
    edges: graph.relations.reduce(
      (n, r) => n + Object.values(r.index.fwd).reduce((s, ids) => s + ids.length, 0),
      0,
    ),
  };
}

/** Validate independently of the sender; rebuild both directions from the exact edge set. */
export function validateAssetGraph(value: unknown): asserts value is AssetGraph {
  fields(value, ['version', 'atlas', 'includeData', 'models', 'relations']);
  const graph = value as AssetGraph;
  check(graph.version === 1 && typeof graph.includeData === 'boolean');
  name(graph.atlas);
  check(Array.isArray(graph.models) && graph.models.length > 0 && graph.models.length <= 1000);
  check(Array.isArray(graph.relations) && graph.relations.length <= 10000);
  const ids = new Map<string, Set<string>>(),
    keys = new Set<string>();
  let total = 0;
  for (const model of graph.models) {
    fields(model, ['definition', 'rows']);
    fields(model.definition, ['name', 'parentId', 'fields'], ['fieldTypes']);
    const def = model.definition;
    name(def.name);
    check(!def.name.startsWith('sys_') && !ids.has(def.name));
    if (def.parentId !== null) {
      name(def.parentId);
    }
    check(
      Array.isArray(def.fields) &&
        def.fields.length <= 1000 &&
        new Set(def.fields).size === def.fields.length,
    );
    for (const field of def.fields) {
      name(field);
      check(!field.startsWith('_'));
    }
    if (def.fieldTypes !== undefined) {
      object(def.fieldTypes);
    }
    for (const [field, type] of Object.entries(def.fieldTypes ?? {})) {
      check(def.fields.includes(field));
      fields(type, ['type'], ['required', 'unit', 'default']);
      check(
        [
          'String',
          'I18N',
          'Number',
          'Int',
          'Boolean',
          'DateTime',
          'JSON',
          'Color',
          'Unit',
        ].includes(type.type),
      );
      check(type.required === undefined || typeof type.required === 'boolean');
      check(type.unit === undefined || typeof type.unit === 'string');
      if (type.default !== undefined) {
        check(
          validateFieldValue(field, type.default, { ...type, required: false } as FieldTypeDef, {
            diagnostics: [],
          }),
        );
      }
    }
    check(Array.isArray(model.rows) && (graph.includeData || model.rows.length === 0));
    const modelIds = new Set<string>();
    ids.set(def.name, modelIds);
    for (const row of model.rows) {
      object(row);
      name(row._id);
      check(!modelIds.has(row._id) && !isDeletedRecord(row));
      modelIds.add(row._id);
      check(typeof row._createdAt === 'string' && Number.isFinite(Date.parse(row._createdAt)));
      check(
        Object.keys(row).every(
          (field) => ['_id', '_createdAt'].includes(field) || def.fields.includes(field),
        ),
      );
      for (const field of def.fields) {
        const diagnostics: Parameters<typeof validateFieldValue>[3] = { diagnostics: [] };
        const type = def.fieldTypes?.[field];
        if (type) {
          check(validateFieldValue(field, row[field], type as FieldTypeDef, diagnostics));
        }
      }
      check(++total <= 100000);
    }
  }
  const manifest = manifestFor(graph, graph.atlas);
  // Also validates hierarchy, duplicate directed-pair labels and registered endpoints.
  parseAtlasManifestJson(JSON.stringify(manifest), graph.atlas);
  const ancestors = new Map<string, Set<string>>();
  const recordOwners = new Map<string, string[]>();
  const definitions = new Map(
    graph.models.map((model) => [model.definition.name, model.definition]),
  );
  for (const model of graph.models) {
    const names = new Set<string>([model.definition.name]);
    let parent = model.definition.parentId;
    while (parent !== null) {
      names.add(parent);
      parent = definitions.get(parent)!.parentId;
    }
    ancestors.set(model.definition.name, names);
    for (const id of ids.get(model.definition.name)!) {
      const owners = recordOwners.get(id) ?? [];
      owners.push(model.definition.name);
      recordOwners.set(id, owners);
    }
  }
  const ownsRecord = (model: string, id: string): boolean =>
    recordOwners.get(id)?.some((owner) => ancestors.get(owner)!.has(model)) ?? false;
  for (const relation of graph.relations) {
    fields(relation, ['definition', 'index']);
    fields(
      relation.definition,
      ['source', 'target', 'forward', 'reverse', 'logic', 'matchOn'],
      ['selfLoopPolicy'],
    );
    const def = relation.definition;
    for (const label of [def.source, def.target, def.forward, def.reverse]) {
      name(label);
    }
    check(
      def.logic === null ||
        ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'].includes(def.logic),
    );
    check(def.selfLoopPolicy === undefined || ['allow', 'deny'].includes(def.selfLoopPolicy));
    if (def.matchOn !== null) {
      fields(def.matchOn, ['sourceField', 'targetField']);
      name(def.matchOn.sourceField);
      name(def.matchOn.targetField);
      check(
        graph.models
          .find((m) => m.definition.name === def.source)
          ?.definition.fields.includes(def.matchOn.sourceField),
      );
      check(
        graph.models
          .find((m) => m.definition.name === def.target)
          ?.definition.fields.includes(def.matchOn.targetField),
      );
    }
    check(!keys.has(relationKey(def)));
    keys.add(relationKey(def));
    fields(relation.index, ['fwd', 'rev']);
    const expected: Record<string, string[]> = Object.create(null);
    for (const [source, targets] of Object.entries(object(relation.index.fwd))) {
      check(ownsRecord(def.source, source));
      check(
        Array.isArray(targets) &&
          targets.length > 0 &&
          targets.length <= 100000 &&
          new Set(targets).size === targets.length,
      );
      check(
        !['one-to-one', 'many-to-one'].includes(def.logic ?? '') ||
          (targets as unknown[]).length <= 1,
      );
      for (const target of targets as string[]) {
        check(ownsRecord(def.target, target));
        check(def.source !== def.target || source !== target || def.selfLoopPolicy === 'allow');
        (expected[target] ??= []).push(source);
        check(++total <= 200000);
      }
    }
    const normalize = (index: Record<string, string[]>) =>
      Object.fromEntries(
        Object.entries(index).map(([id, items]) => {
          check(Array.isArray(items) && new Set(items).size === items.length);
          check(!['one-to-one', 'one-to-many'].includes(def.logic ?? '') || items.length <= 1);
          return [id, [...items].sort()];
        }),
      );
    check(
      stableStringify(normalize(expected)) ===
        stableStringify(normalize(object(relation.index.rev) as Record<string, string[]>)),
    );
  }
}
function manifestFor(graph: AssetGraph, atlas: string): AtlasManifestFileJson {
  const manifest = {
    version: '1.0.0',
    atlas,
    models: graph.models.map((m) => m.definition),
    relations: graph.relations.map((r) => r.definition),
  };
  return { ...manifest, checksum: computeAtlasManifestChecksum(manifest) };
}

/** Caller owns a write barrier/offline lease and has flushed all buffered changes. */
export function collectAssetGraph(vault: AtlasSingleVault, selection: AssetSelection): AssetGraph {
  fields(selection, ['models', 'includeData']);
  check(
    typeof selection.includeData === 'boolean' &&
      Array.isArray(selection.models) &&
      selection.models.length > 0 &&
      selection.models.length <= 1000,
  );
  check(new Set(selection.models).size === selection.models.length);
  const raw = vault.get(AtlasSingleVault.manifestKey) ?? fail();
  const manifest = JSON.parse(raw) as AtlasManifestFileJson;
  parseAtlasManifestJson(raw, manifest.atlas);
  const selected = new Set<string>();
  const add = (modelName: string): void => {
    name(modelName);
    const model = manifest.models.find((m) => m.name === modelName) ?? fail();
    if (selected.has(modelName)) {
      return;
    }
    selected.add(modelName);
    if (model.parentId !== null) {
      add(model.parentId);
    }
  };
  selection.models.forEach(add);
  const graph: AssetGraph = {
    version: 1,
    atlas: manifest.atlas,
    includeData: selection.includeData,
    models: manifest.models
      .filter((m) => selected.has(m.name))
      .map((definition) => {
        const compact = new Map<string, ModelRecord>();
        if (selection.includeData) {
          for (const line of (vault.get(AtlasSingleVault.modelKey(definition.name)) ?? '').split(
            '\n',
          )) {
            if (!line.trim()) {
              continue;
            }
            const row = JSON.parse(line) as ModelRecord;
            if (!Object.hasOwn(row, '__schema__')) {
              compact.set(row._id, row);
            }
          }
        }
        return { definition, rows: [...compact.values()].filter((row) => !isDeletedRecord(row)) };
      }),
    relations: manifest.relations
      .filter((r) => selected.has(r.source) && selected.has(r.target))
      .map((definition) => {
        const index: RelationIndexData = selection.includeData
          ? (JSON.parse(
              vault.get(AtlasSingleVault.relationKey(relationKey(definition))) ??
                '{"fwd":{},"rev":{}}',
            ) as RelationIndexData)
          : { fwd: {}, rev: {} };
        return {
          definition,
          index: {
            fwd: Object.fromEntries(Object.entries(index.fwd).filter(([, ids]) => ids.length)),
            rev: Object.fromEntries(Object.entries(index.rev).filter(([, ids]) => ids.length)),
          },
        };
      }),
  };
  validateAssetGraph(graph);
  return graph;
}

/** Build a clean destination Vault; source catalog extras and unrelated entries are excluded. */
export function assetGraphVault(graph: AssetGraph, destination: string): AtlasSingleVault {
  validateAssetGraph(graph);
  name(destination);
  const vault = new AtlasSingleVault();
  vault.set(AtlasSingleVault.manifestKey, JSON.stringify(manifestFor(graph, destination)));
  for (const { definition, rows } of graph.models) {
    const header = {
      __schema__: { fields: definition.fields, fieldTypes: definition.fieldTypes ?? {} },
    };
    vault.set(
      AtlasSingleVault.modelKey(definition.name),
      [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n',
    );
  }
  for (const { definition, index } of graph.relations) {
    vault.set(AtlasSingleVault.relationKey(relationKey(definition)), JSON.stringify(index));
  }
  return vault;
}
