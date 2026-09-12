import type { PublishedBindingSurfaceContract } from '@mode-db/sdk';
import { compileBindingSurface } from './binding-surface-compiler.js';
import type { OperationInterfaceRelease } from './operation-interface-publication.js';
import type { QueryInterfaceRelease } from './query-interface-publication.js';
import type { BindingSurface, InterfaceVersionRecord } from './types.js';

export interface BindingSurfaceRelease {
  version: string;
  publishedAt: string;
  signature: string;
  bindingSurface: BindingSurface;
  contract: PublishedBindingSurfaceContract;
}

export interface BindingSurfacePublicationIssue {
  code: string;
  message: string;
  path?: string;
}

export type BindingSurfaceReleaseImpactLevel = 'none' | 'patch' | 'minor' | 'major';

export interface BindingSurfaceReleaseChange {
  code:
    | 'surface_name_changed'
    | 'parameter_added_optional'
    | 'parameter_added_required'
    | 'parameter_removed'
    | 'parameter_contract_changed'
    | 'query_binding_changed'
    | 'writeback_mode_changed'
    | 'refresh_policy_changed'
    | 'mutation_added'
    | 'mutation_removed'
    | 'mutation_changed'
    | 'access_policy_changed'
    | 'metadata_changed';
  level: Exclude<BindingSurfaceReleaseImpactLevel, 'none'>;
  subject?: string;
}

export interface BindingSurfaceReleaseImpact {
  level: BindingSurfaceReleaseImpactLevel;
  compatibility: 'compatible' | 'breaking';
  recommendedVersion: string;
  changes: BindingSurfaceReleaseChange[];
}

export type BindingSurfacePublicationResult =
  | { ok: true; release: BindingSurfaceRelease; bindingSurface: BindingSurface }
  | { ok: false; issues: BindingSurfacePublicationIssue[] };

export function bindingSurfacePublicationSignature(surface: BindingSurface): string {
  return JSON.stringify({
    name: surface.name,
    displayName: surface.displayName,
    description: surface.description,
    tags: surface.tags,
    permissions: surface.permissions,
    parameters: surface.parameters,
    query: surface.query,
    writeback: surface.writeback,
  });
}

export function assessBindingSurfaceReleaseImpact(
  surface: BindingSurface,
  existingRelease?: BindingSurfaceRelease,
): BindingSurfaceReleaseImpact {
  if (!existingRelease) {
    return {
      level: 'none',
      compatibility: 'compatible',
      recommendedVersion: surface.version.current,
      changes: [],
    };
  }
  const previous = existingRelease.bindingSurface;
  const changes: BindingSurfaceReleaseChange[] = [];
  const add = (
    code: BindingSurfaceReleaseChange['code'],
    level: BindingSurfaceReleaseChange['level'],
    subject?: string,
  ): void => {
    changes.push({ code, level, ...(subject ? { subject } : {}) });
  };
  if (previous.name !== surface.name) {
    add('surface_name_changed', 'major');
  }
  assessParameters(previous, surface, add);
  if (json(previous.query) !== json(surface.query)) {
    add('query_binding_changed', 'major');
  }
  if (previous.writeback.mode !== surface.writeback.mode) {
    add('writeback_mode_changed', 'major');
  }
  if (previous.writeback.refresh !== surface.writeback.refresh) {
    add('refresh_policy_changed', 'major');
  }
  const beforeMutations = new Map(
    previous.writeback.mutations.map((mutation) => [mutation.id, mutation]),
  );
  const afterMutations = new Map(
    surface.writeback.mutations.map((mutation) => [mutation.id, mutation]),
  );
  for (const [id, mutation] of beforeMutations) {
    const next = afterMutations.get(id);
    if (!next) {
      add('mutation_removed', 'major', id);
    } else if (json(next) !== json(mutation)) {
      add('mutation_changed', 'major', id);
    }
  }
  for (const id of afterMutations.keys()) {
    if (!beforeMutations.has(id)) {
      add('mutation_added', 'minor', id);
    }
  }
  if (json(previous.permissions) !== json(surface.permissions)) {
    add('access_policy_changed', 'major');
  }
  if (surfaceMetadataSignature(previous) !== surfaceMetadataSignature(surface)) {
    add('metadata_changed', 'patch');
  }
  const level = maximumImpact(changes);
  return {
    level,
    compatibility: level === 'major' ? 'breaking' : 'compatible',
    recommendedVersion: publicationVersion(
      surface.version.current,
      existingRelease.version,
      level === 'none' ? 'patch' : level,
    ),
    changes,
  };
}

export function publishBindingSurface(input: {
  bindingSurface: BindingSurface;
  signature: string;
  queryReleases: readonly QueryInterfaceRelease[];
  operationReleases: readonly OperationInterfaceRelease[];
  existingRelease?: BindingSurfaceRelease;
  now?: string;
}): BindingSurfacePublicationResult {
  const expectedSignature = bindingSurfacePublicationSignature(input.bindingSurface);
  const issues: BindingSurfacePublicationIssue[] = [];
  if (input.signature !== expectedSignature) {
    issues.push({
      code: 'binding_surface_publication_signature_mismatch',
      message: 'The BindingSurface signature does not match the current draft.',
      path: 'signature',
    });
  }
  if (
    input.existingRelease?.signature === expectedSignature &&
    input.existingRelease.bindingSurface.status === 'active'
  ) {
    issues.push({
      code: 'binding_surface_publication_release_unchanged',
      message: 'The current BindingSurface draft is identical to the published release.',
    });
  }

  const compilation = compileBindingSurface({
    surface: input.bindingSurface,
    queryReleases: input.queryReleases,
    operationReleases: input.operationReleases,
  });
  issues.push(
    ...compilation.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path,
      })),
  );
  if (!compilation.contract && issues.length === 0) {
    issues.push({
      code: 'binding_surface_publication_compilation_failed',
      message: 'The BindingSurface could not be compiled for publication.',
    });
  }
  if (issues.length > 0 || !compilation.contract) {
    return { ok: false, issues };
  }

  const now = input.now ?? new Date().toISOString();
  const impact = assessBindingSurfaceReleaseImpact(input.bindingSurface, input.existingRelease);
  const version = publicationVersion(
    input.bindingSurface.version.current,
    input.existingRelease?.version,
    impact.level === 'none' ? 'patch' : impact.level,
  );
  const history = appendVersionHistory(input.bindingSurface.version.history, input.existingRelease);
  const activeSurface: BindingSurface = {
    ...input.bindingSurface,
    status: 'active',
    version: {
      current: version,
      compatibility: impact.compatibility,
      ...(history.length > 0 ? { history } : {}),
    },
    lifecycle: {
      ...input.bindingSurface.lifecycle,
      updatedAt: now,
      lastValidatedAt: now,
      lastCompiledAt: now,
      publishedAt: now,
      deprecatedAt: undefined,
    },
  };
  const release: BindingSurfaceRelease = {
    version,
    publishedAt: now,
    signature: expectedSignature,
    bindingSurface: structuredClone(activeSurface),
    contract: structuredClone({ ...compilation.contract, version }),
  };
  return { ok: true, release, bindingSurface: activeSurface };
}

export function deprecateBindingSurfaceRelease(
  release: BindingSurfaceRelease,
  now = new Date().toISOString(),
): BindingSurfaceRelease {
  return {
    ...release,
    bindingSurface: {
      ...release.bindingSurface,
      status: 'deprecated',
      lifecycle: {
        ...release.bindingSurface.lifecycle,
        updatedAt: now,
        deprecatedAt: now,
      },
    },
  };
}

export function appendBindingSurfaceReleaseHistory(
  history: readonly BindingSurfaceRelease[] | undefined,
  release: BindingSurfaceRelease | undefined,
): BindingSurfaceRelease[] {
  if (!release) {
    return [...(history ?? [])];
  }
  const result = (history ?? []).filter((entry) => entry.version !== release.version);
  result.push(structuredClone(release));
  return result.sort((left, right) => compareVersions(left.version, right.version));
}

export function nextDraftBindingSurface(
  surface: BindingSurface,
  release: BindingSurfaceRelease,
  now: string,
): BindingSurface {
  return {
    ...surface,
    status: 'draft',
    version: {
      ...surface.version,
      current: publicationVersion(surface.version.current, release.version),
      compatibility: 'draft',
    },
    lifecycle: {
      ...surface.lifecycle,
      updatedAt: now,
      publishedAt: undefined,
      deprecatedAt: undefined,
    },
  };
}

function publicationVersion(
  candidate: string,
  previous?: string,
  impact: Exclude<BindingSurfaceReleaseImpactLevel, 'none'> = 'patch',
): string {
  if (!previous) {
    return candidate;
  }
  const parsed = parseVersion(previous);
  if (!parsed) {
    return compareVersions(candidate, previous) > 0 ? candidate : `${previous}.1`;
  }
  const required =
    impact === 'major'
      ? `${parsed.major + 1}.0.0`
      : impact === 'minor'
        ? `${parsed.major}.${parsed.minor + 1}.0`
        : `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  return compareVersions(candidate, required) >= 0 ? candidate : required;
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    return left.localeCompare(right, undefined, { numeric: true });
  }
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function parseVersion(
  version: string,
): { major: number; minor: number; patch: number } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : undefined;
}

function appendVersionHistory(
  history: readonly InterfaceVersionRecord[] | undefined,
  previous: BindingSurfaceRelease | undefined,
): InterfaceVersionRecord[] {
  const result = [...(history ?? [])];
  if (previous && !result.some((entry) => entry.version === previous.version)) {
    result.push({
      version: previous.version,
      createdAt: previous.publishedAt,
      summary: 'Published binding surface release',
    });
  }
  return result;
}

function assessParameters(
  previous: BindingSurface,
  current: BindingSurface,
  add: (
    code: BindingSurfaceReleaseChange['code'],
    level: BindingSurfaceReleaseChange['level'],
    subject?: string,
  ) => void,
): void {
  const before = new Map(previous.parameters.map((parameter) => [parameter.name, parameter]));
  const after = new Map(current.parameters.map((parameter) => [parameter.name, parameter]));
  for (const [name, parameter] of before) {
    const next = after.get(name);
    if (!next) {
      add('parameter_removed', 'major', name);
    } else if (
      next.type !== parameter.type ||
      next.required !== parameter.required ||
      json(next.defaultValue) !== json(parameter.defaultValue)
    ) {
      add('parameter_contract_changed', 'major', name);
    }
  }
  for (const [name, parameter] of after) {
    if (!before.has(name)) {
      add(
        parameter.required ? 'parameter_added_required' : 'parameter_added_optional',
        parameter.required ? 'major' : 'minor',
        name,
      );
    }
  }
}

function surfaceMetadataSignature(surface: BindingSurface): string {
  return json({
    displayName: surface.displayName,
    description: surface.description,
    tags: surface.tags,
  });
}

function maximumImpact(
  changes: readonly BindingSurfaceReleaseChange[],
): BindingSurfaceReleaseImpactLevel {
  return changes.reduce<BindingSurfaceReleaseImpactLevel>(
    (current, change) => (impactRank(change.level) > impactRank(current) ? change.level : current),
    'none',
  );
}

function impactRank(level: BindingSurfaceReleaseImpactLevel): number {
  return { none: 0, patch: 1, minor: 2, major: 3 }[level];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
