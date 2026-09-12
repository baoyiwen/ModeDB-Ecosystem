import type { EngineModelNode } from '../types/engine-schema.js';
import type { PublishedQueryExecutionTemplate } from '@mode-db/sdk';
import type { InterfaceVersionRecord, QueryInterface, QueryResultField } from './types.js';
import { validateEngineInterface, type QueryDesignerValidationIssue } from './validator.js';

export interface QueryInterfaceRelease {
  version: string;
  publishedAt: string;
  callableName: string;
  signature: string;
  queryInterface: QueryInterface;
  executionTemplate: PublishedQueryExecutionTemplate;
}

export interface QueryInterfacePublicationIssue {
  code: string;
  message: string;
  path?: string;
}

export type QueryInterfaceReleaseImpactLevel = 'none' | 'patch' | 'minor' | 'major';

export interface QueryInterfaceReleaseChange {
  code:
    | 'callable_name_changed'
    | 'parameter_added_optional'
    | 'parameter_added_required'
    | 'parameter_removed'
    | 'parameter_type_changed'
    | 'parameter_required'
    | 'parameter_relaxed'
    | 'parameter_default_changed'
    | 'result_shape_changed'
    | 'result_field_added'
    | 'result_field_removed'
    | 'result_field_type_changed'
    | 'result_field_became_nullable'
    | 'result_field_became_required'
    | 'record_refs_removed'
    | 'record_refs_added'
    | 'pagination_mode_changed'
    | 'access_policy_changed'
    | 'error_contract_changed'
    | 'query_behavior_changed'
    | 'metadata_changed';
  level: Exclude<QueryInterfaceReleaseImpactLevel, 'none'>;
  subject?: string;
}

export interface QueryInterfaceReleaseImpact {
  level: QueryInterfaceReleaseImpactLevel;
  compatibility: 'compatible' | 'breaking';
  recommendedVersion: string;
  changes: QueryInterfaceReleaseChange[];
}

export type QueryInterfacePublicationResult =
  | {
      ok: true;
      release: QueryInterfaceRelease;
      queryInterface: QueryInterface;
    }
  | {
      ok: false;
      issues: QueryInterfacePublicationIssue[];
    };

export function queryInterfacePublicationSignature(queryInterface: QueryInterface): string {
  return JSON.stringify({
    name: queryInterface.name,
    displayName: queryInterface.displayName,
    description: queryInterface.description,
    namespace: queryInterface.namespace,
    tags: queryInterface.tags,
    contract: queryInterface.contract,
    designGraph: queryInterface.designGraph,
    query: queryInterface.query,
    dependencies: queryInterface.dependencies,
  });
}

export function assessQueryInterfaceReleaseImpact(
  queryInterface: QueryInterface,
  existingRelease?: QueryInterfaceRelease,
): QueryInterfaceReleaseImpact {
  if (!existingRelease) {
    return {
      level: 'none',
      compatibility: 'compatible',
      recommendedVersion: queryInterface.version.current,
      changes: [],
    };
  }

  const previous = existingRelease.queryInterface;
  const changes: QueryInterfaceReleaseChange[] = [];
  const addChange = (
    code: QueryInterfaceReleaseChange['code'],
    level: QueryInterfaceReleaseChange['level'],
    subject?: string,
  ): void => {
    changes.push({ code, level, ...(subject ? { subject } : {}) });
  };

  if (
    previous.contract.invocation.callableName !== queryInterface.contract.invocation.callableName
  ) {
    addChange('callable_name_changed', 'major');
  }

  const previousParameters = new Map(
    previous.contract.parameters.map((parameter) => [parameter.name, parameter]),
  );
  const currentParameters = new Map(
    queryInterface.contract.parameters.map((parameter) => [parameter.name, parameter]),
  );
  for (const [name, parameter] of previousParameters) {
    const current = currentParameters.get(name);
    if (!current) {
      addChange('parameter_removed', 'major', name);
      continue;
    }
    if (current.type !== parameter.type) {
      addChange('parameter_type_changed', 'major', name);
    }
    if (!parameter.required && current.required) {
      addChange('parameter_required', 'major', name);
    } else if (parameter.required && !current.required) {
      addChange('parameter_relaxed', 'minor', name);
    }
    if (JSON.stringify(current.defaultValue) !== JSON.stringify(parameter.defaultValue)) {
      addChange('parameter_default_changed', 'patch', name);
    }
  }
  for (const [name, parameter] of currentParameters) {
    if (!previousParameters.has(name)) {
      addChange(
        parameter.required ? 'parameter_added_required' : 'parameter_added_optional',
        parameter.required ? 'major' : 'minor',
        name,
      );
    }
  }

  if (previous.query.result.shape !== queryInterface.query.result.shape) {
    addChange('result_shape_changed', 'major');
  }
  const previousFields = flattenResultFields(previous.query.result.schema);
  const currentFields = flattenResultFields(queryInterface.query.result.schema);
  for (const [path, field] of previousFields) {
    const current = currentFields.get(path);
    if (!current) {
      addChange('result_field_removed', 'major', path);
      continue;
    }
    if (current.type !== field.type) {
      addChange('result_field_type_changed', 'major', path);
    }
    if (!field.nullable && current.nullable) {
      addChange('result_field_became_nullable', 'major', path);
    } else if (field.nullable && !current.nullable) {
      addChange('result_field_became_required', 'minor', path);
    }
  }
  for (const path of currentFields.keys()) {
    if (!previousFields.has(path)) {
      addChange('result_field_added', 'minor', path);
    }
  }
  if (previous.query.result.includesRecordRefs !== queryInterface.query.result.includesRecordRefs) {
    addChange(
      queryInterface.query.result.includesRecordRefs ? 'record_refs_added' : 'record_refs_removed',
      queryInterface.query.result.includesRecordRefs ? 'minor' : 'major',
    );
  }

  if (
    (previous.query.pagination?.mode ?? 'none') !==
    (queryInterface.query.pagination?.mode ?? 'none')
  ) {
    addChange('pagination_mode_changed', 'major');
  }
  if (
    JSON.stringify(previous.contract.permissions) !==
    JSON.stringify(queryInterface.contract.permissions)
  ) {
    addChange('access_policy_changed', 'major');
  }
  if (JSON.stringify(previous.contract.errors) !== JSON.stringify(queryInterface.contract.errors)) {
    addChange('error_contract_changed', 'patch');
  }
  if (queryExecutionSignature(previous) !== queryExecutionSignature(queryInterface)) {
    addChange('query_behavior_changed', 'patch');
  }
  if (queryMetadataSignature(previous) !== queryMetadataSignature(queryInterface)) {
    addChange('metadata_changed', 'patch');
  }

  const level = changes.reduce<QueryInterfaceReleaseImpactLevel>(
    (current, change) =>
      releaseImpactRank(change.level) > releaseImpactRank(current) ? change.level : current,
    'none',
  );
  return {
    level,
    compatibility: level === 'major' ? 'breaking' : 'compatible',
    recommendedVersion: publicationVersion(
      queryInterface.version.current,
      existingRelease.version,
      level === 'none' ? 'patch' : level,
    ),
    changes,
  };
}

export function publishQueryInterface(input: {
  queryInterface: QueryInterface;
  signature: string;
  executionTemplate: PublishedQueryExecutionTemplate;
  models: readonly EngineModelNode[];
  existingRelease?: QueryInterfaceRelease;
  otherReleases?: readonly QueryInterfaceRelease[];
  now?: string;
}): QueryInterfacePublicationResult {
  const callableName = input.queryInterface.contract.invocation.callableName?.trim() ?? '';
  const issues: QueryInterfacePublicationIssue[] = [];
  if (!callableName) {
    issues.push({
      code: 'publication_callable_name_required',
      message: 'Published interfaces require a callable name.',
      path: 'contract.invocation.callableName',
    });
  } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(callableName)) {
    issues.push({
      code: 'publication_callable_name_invalid',
      message: 'Callable name must be a valid identifier.',
      path: 'contract.invocation.callableName',
    });
  }
  const duplicate = input.otherReleases?.find(
    (release) => release.callableName.toLocaleLowerCase() === callableName.toLocaleLowerCase(),
  );
  if (duplicate) {
    issues.push({
      code: 'publication_callable_name_conflict',
      message: `Callable name "${callableName}" is already published.`,
      path: 'contract.invocation.callableName',
    });
  }
  if (
    input.existingRelease?.signature === input.signature &&
    input.existingRelease.queryInterface.status === 'active'
  ) {
    issues.push({
      code: 'publication_release_unchanged',
      message: 'The current draft is identical to the published release.',
    });
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const now = input.now ?? new Date().toISOString();
  const impact = assessQueryInterfaceReleaseImpact(input.queryInterface, input.existingRelease);
  const version = publicationVersion(
    input.queryInterface.version.current,
    input.existingRelease?.version,
    impact.level === 'none' ? 'patch' : impact.level,
  );
  const history = appendVersionHistory(input.queryInterface.version.history, input.existingRelease);
  const activeInterface: QueryInterface = {
    ...input.queryInterface,
    status: 'active',
    version: {
      current: version,
      compatibility: impact.compatibility,
      ...(history.length > 0 ? { history } : {}),
    },
    lifecycle: {
      ...input.queryInterface.lifecycle,
      updatedAt: now,
      lastValidatedAt: now,
      publishedAt: now,
      deprecatedAt: undefined,
    },
  };
  const validation = validateEngineInterface(activeInterface, input.models);
  const blocking = validation.issues.filter((issue) => issue.severity === 'error');
  if (blocking.length > 0) {
    return { ok: false, issues: blocking.map(publicationIssueFromValidation) };
  }
  const release: QueryInterfaceRelease = {
    version,
    publishedAt: now,
    callableName,
    signature: input.signature,
    queryInterface: structuredClone(activeInterface),
    executionTemplate: structuredClone(input.executionTemplate),
  };
  return { ok: true, release, queryInterface: activeInterface };
}

export function deprecateQueryInterfaceRelease(
  release: QueryInterfaceRelease,
  now = new Date().toISOString(),
): QueryInterfaceRelease {
  return {
    ...release,
    queryInterface: {
      ...release.queryInterface,
      status: 'deprecated',
      lifecycle: {
        ...release.queryInterface.lifecycle,
        updatedAt: now,
        deprecatedAt: now,
      },
    },
  };
}

export function appendExecutableReleaseHistory(
  history: readonly QueryInterfaceRelease[] | undefined,
  release: QueryInterfaceRelease | undefined,
): QueryInterfaceRelease[] {
  if (!release) {
    return [...(history ?? [])];
  }
  const result = (history ?? []).filter((entry) => entry.version !== release.version);
  result.push(structuredClone(release));
  return result.sort((left, right) => compareVersions(left.version, right.version));
}

export function nextDraftInterface(
  queryInterface: QueryInterface,
  release: QueryInterfaceRelease,
  now: string,
): QueryInterface {
  return {
    ...queryInterface,
    status: 'draft',
    version: {
      ...queryInterface.version,
      current: publicationVersion(queryInterface.version.current, release.version),
      compatibility: 'draft',
    },
    lifecycle: {
      ...queryInterface.lifecycle,
      updatedAt: now,
      publishedAt: undefined,
      deprecatedAt: undefined,
    },
  };
}

function publicationVersion(
  candidate: string,
  previous?: string,
  impact: Exclude<QueryInterfaceReleaseImpactLevel, 'none'> = 'patch',
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
  previous: QueryInterfaceRelease | undefined,
): InterfaceVersionRecord[] {
  const result = [...(history ?? [])];
  if (previous && !result.some((entry) => entry.version === previous.version)) {
    result.push({
      version: previous.version,
      createdAt: previous.publishedAt,
      summary: 'Published query interface release',
    });
  }
  return result;
}

function publicationIssueFromValidation(
  issue: QueryDesignerValidationIssue,
): QueryInterfacePublicationIssue {
  return { code: issue.code, message: issue.message, path: issue.path };
}

function flattenResultFields(
  fields: readonly QueryResultField[],
  prefix = '',
): ReadonlyMap<string, QueryResultField> {
  const result = new Map<string, QueryResultField>();
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    result.set(path, field);
    for (const [childPath, child] of flattenResultFields(field.children ?? [], path)) {
      result.set(childPath, child);
    }
  }
  return result;
}

function queryExecutionSignature(queryInterface: QueryInterface): string {
  return JSON.stringify({
    designGraph: queryInterface.designGraph,
    traversal: queryInterface.query.traversal,
    filterTree: queryInterface.query.filterTree,
    filters: queryInterface.query.filters,
    aggregation: queryInterface.query.aggregation,
    sorts: queryInterface.query.sorts,
    projection: queryInterface.query.projection,
    pagination: queryInterface.query.pagination,
    dependencies: queryInterface.dependencies,
  });
}

function queryMetadataSignature(queryInterface: QueryInterface): string {
  return JSON.stringify({
    name: queryInterface.name,
    displayName: queryInterface.displayName,
    description: queryInterface.description,
    namespace: queryInterface.namespace,
    tags: queryInterface.tags,
  });
}

function releaseImpactRank(level: QueryInterfaceReleaseImpactLevel): number {
  return { none: 0, patch: 1, minor: 2, major: 3 }[level];
}
