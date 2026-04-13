import { createHash } from 'node:crypto';
import type { MatchPredicate, RelationLogic } from './types.js';
import { ModelRegistry } from './registry.js';
import { AtlasManifestError } from './errors.js';
import type { FieldTypeDef } from './data-types.js';

/** Logical format version embedded in `atlas-manifest.json`. */
export const ATLAS_MANIFEST_FORMAT_VERSION = '1.0.0';

export const ATLAS_MANIFEST_FILENAME = 'atlas-manifest.json';

/** Serialized field type entry in the manifest. */
export interface AtlasManifestFieldTypeJson {
  readonly type: string;
  readonly required?: boolean;
  readonly unit?: string;
}

export interface AtlasManifestModelJson {
  readonly name: string;
  readonly parentId: string | null;
  readonly fields: readonly string[];
  readonly fieldTypes?: Readonly<Record<string, AtlasManifestFieldTypeJson>>;
}

export interface AtlasManifestRelationJson {
  readonly source: string;
  readonly target: string;
  readonly forward: string;
  readonly reverse: string;
  readonly logic: RelationLogic | null;
  readonly matchOn: MatchPredicate | null;
}

export interface AtlasManifestFileJson {
  readonly version: string;
  readonly atlas: string;
  readonly models: readonly AtlasManifestModelJson[];
  readonly relations: readonly AtlasManifestRelationJson[];
  readonly checksum: string;
}

function sha256Hex(utf8: string): string {
  return createHash('sha256').update(utf8, 'utf8').digest('hex');
}

/**
 * Deterministic JSON for checksums (sorted object keys, sorted arrays where required).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function normalizeModelsForChecksum(
  models: readonly AtlasManifestModelJson[],
): AtlasManifestModelJson[] {
  return [...models]
    .map((m) => ({
      name: m.name,
      parentId: m.parentId,
      fields: [...m.fields].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeRelationsForChecksum(
  relations: readonly AtlasManifestRelationJson[],
): AtlasManifestRelationJson[] {
  return [...relations]
    .map((r) => ({
      forward: r.forward,
      logic: r.logic,
      matchOn: r.matchOn,
      reverse: r.reverse,
      source: r.source,
      target: r.target,
    }))
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target) ||
        a.forward.localeCompare(b.forward),
    );
}

/**
 * Canonical payload string used for `checksum` (excludes the checksum field itself).
 */
export function atlasManifestChecksumPayload(data: {
  version: string;
  atlas: string;
  models: readonly AtlasManifestModelJson[];
  relations: readonly AtlasManifestRelationJson[];
}): string {
  return stableStringify({
    atlas: data.atlas,
    models: normalizeModelsForChecksum(data.models),
    relations: normalizeRelationsForChecksum(data.relations),
    version: data.version,
  });
}

export function computeAtlasManifestChecksum(data: {
  version: string;
  atlas: string;
  models: readonly AtlasManifestModelJson[];
  relations: readonly AtlasManifestRelationJson[];
}): string {
  return sha256Hex(atlasManifestChecksumPayload(data));
}

function deserializeFieldTypes(
  raw?: Readonly<Record<string, AtlasManifestFieldTypeJson>>,
): Map<string, FieldTypeDef> {
  if (!raw) {
    return new Map();
  }
  const map = new Map<string, FieldTypeDef>();
  for (const [k, v] of Object.entries(raw)) {
    const def: FieldTypeDef = { type: v.type as FieldTypeDef['type'] };
    if (v.required) {
      (def as { required: boolean }).required = v.required;
    }
    if (v.unit) {
      (def as { unit: string }).unit = v.unit;
    }
    map.set(k, def);
  }
  return map;
}

function hydrateRegistryFromManifest(data: {
  version: string;
  atlas: string;
  models: readonly AtlasManifestModelJson[];
  relations: readonly AtlasManifestRelationJson[];
}): ModelRegistry {
  const registry = new ModelRegistry();
  const pending = [...data.models];

  while (pending.length > 0) {
    const idx = pending.findIndex(
      (m) => m.parentId === null || registry.getModel(m.parentId) !== undefined,
    );
    if (idx === -1) {
      throw new AtlasManifestError(
        'Invalid model hierarchy in atlas-manifest.json (missing parent or cycle).',
      );
    }
    const m = pending[idx]!;
    pending.splice(idx, 1);
    registry.registerModel(
      m.name,
      new Set(m.fields),
      m.parentId,
      deserializeFieldTypes(m.fieldTypes),
    );
  }

  for (const r of data.relations) {
    registry.registerRelation(r.source, r.target, r.forward, r.reverse, r.logic, r.matchOn);
  }

  return registry;
}

/**
 * Parse manifest JSON, verify checksum and atlas id, return an isolated registry for runtime.
 */
export function parseAtlasManifestJson(raw: string, expectedAtlas: string): ModelRegistry {
  let data: AtlasManifestFileJson;
  try {
    data = JSON.parse(raw) as AtlasManifestFileJson;
  } catch (err) {
    throw new AtlasManifestError('atlas-manifest.json is not valid JSON.', { cause: err });
  }

  if (typeof data.checksum !== 'string' || data.checksum.length === 0) {
    throw new AtlasManifestError('atlas-manifest.json is missing checksum.');
  }

  if (!Array.isArray(data.models) || !Array.isArray(data.relations)) {
    throw new AtlasManifestError('atlas-manifest.json has invalid models/relations arrays.');
  }

  if (typeof data.version !== 'string' || typeof data.atlas !== 'string') {
    throw new AtlasManifestError('atlas-manifest.json is missing version or atlas.');
  }

  if (data.atlas !== expectedAtlas) {
    throw new AtlasManifestError(
      `Manifest atlas "${data.atlas}" does not match requested atlas "${expectedAtlas}".`,
    );
  }

  const payload = {
    atlas: data.atlas,
    models: data.models,
    relations: data.relations,
    version: data.version,
  };
  const expectedChecksum = computeAtlasManifestChecksum(payload);

  if (data.checksum !== expectedChecksum) {
    throw new AtlasManifestError(
      'atlas-manifest.json checksum mismatch — metadata may be tampered or out of sync.',
    );
  }

  return hydrateRegistryFromManifest(payload);
}

function serializeFieldTypes(
  ft: Map<string, FieldTypeDef>,
): Record<string, AtlasManifestFieldTypeJson> | undefined {
  if (ft.size === 0) {
    return undefined;
  }
  const out: Record<string, AtlasManifestFieldTypeJson> = {};
  for (const [k, v] of ft) {
    const entry: { type: string; required?: boolean; unit?: string } = {
      type: v.type,
    };
    if (v.required) {
      entry.required = v.required;
    }
    if (v.unit) {
      entry.unit = v.unit;
    }
    out[k] = entry;
  }
  return out;
}

export function buildAtlasManifestFileJson(
  registry: ModelRegistry,
  atlas: string,
): AtlasManifestFileJson {
  const models: AtlasManifestModelJson[] = registry
    .getModelDefinitions()
    .map((m) => {
      const base: AtlasManifestModelJson = {
        name: m.name,
        parentId: m.parentId,
        fields: [...m.fields].sort((a, b) => a.localeCompare(b)),
      };
      const ft = serializeFieldTypes(m.fieldTypes);
      if (ft) {
        return { ...base, fieldTypes: ft };
      }
      return base;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const relations: AtlasManifestRelationJson[] = [...registry.getRelations()]
    .map((r) => ({
      forward: r.forward,
      logic: r.logic,
      matchOn: r.matchOn,
      reverse: r.reverse,
      source: r.source,
      target: r.target,
    }))
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target) ||
        a.forward.localeCompare(b.forward),
    );

  const version = ATLAS_MANIFEST_FORMAT_VERSION;
  const checksum = computeAtlasManifestChecksum({ version, atlas, models, relations });

  return {
    atlas,
    checksum,
    models,
    relations,
    version,
  };
}

export function serializeAtlasManifestFile(registry: ModelRegistry, atlas: string): string {
  const file = buildAtlasManifestFileJson(registry, atlas);
  return JSON.stringify(file, null, 2) + '\n';
}
