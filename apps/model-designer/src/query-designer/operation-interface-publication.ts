import type { PublishedOperationExecutionTemplate } from '@mode-db/sdk';
import type { EngineModelNode, EngineRelationEdge } from '../types/engine-schema.js';
import type { InterfaceVersionRecord, OperationInterface } from './types.js';
import { validateEngineInterface } from './validator.js';
import { compilePublishedOperationExecutionTemplate } from './operation-execution-compiler.js';

export interface OperationInterfaceRelease {
  version: string;
  publishedAt: string;
  callableName: string;
  signature: string;
  operationInterface: OperationInterface;
  executionTemplate: PublishedOperationExecutionTemplate;
}

export interface OperationInterfacePublicationIssue {
  code: string;
  message: string;
  path?: string;
}

export type OperationInterfaceReleaseImpactLevel = 'none' | 'patch' | 'minor' | 'major';

export interface OperationInterfaceReleaseChange {
  code:
    | 'callable_name_changed'
    | 'parameter_added_optional'
    | 'parameter_added_required'
    | 'parameter_removed'
    | 'parameter_contract_changed'
    | 'operation_target_changed'
    | 'operation_type_changed'
    | 'input_mapping_changed'
    | 'transaction_changed'
    | 'result_contract_changed'
    | 'access_policy_changed'
    | 'validation_changed'
    | 'metadata_changed';
  level: Exclude<OperationInterfaceReleaseImpactLevel, 'none'>;
  subject?: string;
}

export interface OperationInterfaceReleaseImpact {
  level: OperationInterfaceReleaseImpactLevel;
  compatibility: 'compatible' | 'breaking';
  recommendedVersion: string;
  changes: OperationInterfaceReleaseChange[];
}

export type OperationInterfacePublicationResult =
  | { ok: true; release: OperationInterfaceRelease; operationInterface: OperationInterface }
  | { ok: false; issues: OperationInterfacePublicationIssue[] };

export function operationInterfacePublicationSignature(asset: OperationInterface): string {
  return JSON.stringify({
    name: asset.name,
    displayName: asset.displayName,
    description: asset.description,
    namespace: asset.namespace,
    tags: asset.tags,
    contract: asset.contract,
    designGraph: asset.designGraph,
    operation: asset.operation,
    dependencies: asset.dependencies,
  });
}

export function assessOperationInterfaceReleaseImpact(
  asset: OperationInterface,
  existingRelease?: OperationInterfaceRelease,
): OperationInterfaceReleaseImpact {
  if (!existingRelease) {
    return {
      level: 'none',
      compatibility: 'compatible',
      recommendedVersion: asset.version.current,
      changes: [],
    };
  }
  const previous = existingRelease.operationInterface;
  const changes: OperationInterfaceReleaseChange[] = [];
  const add = (
    code: OperationInterfaceReleaseChange['code'],
    level: OperationInterfaceReleaseChange['level'],
    subject?: string,
  ): void => {
    changes.push({ code, level, ...(subject ? { subject } : {}) });
  };
  if (previous.contract.invocation.callableName !== asset.contract.invocation.callableName) {
    add('callable_name_changed', 'major');
  }
  assessParameters(previous, asset, add);
  if (previous.operation.operationType !== asset.operation.operationType) {
    add('operation_type_changed', 'major');
  }
  if (json(previous.operation.target) !== json(asset.operation.target)) {
    add('operation_target_changed', 'major');
  }
  if (json(previous.operation.inputMapping) !== json(asset.operation.inputMapping)) {
    add('input_mapping_changed', 'major');
  }
  if (json(previous.operation.transactionPolicy) !== json(asset.operation.transactionPolicy)) {
    add('transaction_changed', 'major');
  }
  if (
    json({ result: previous.operation.result, batch: previous.operation.batch }) !==
    json({ result: asset.operation.result, batch: asset.operation.batch })
  ) {
    add('result_contract_changed', 'major');
  }
  if (json(previous.contract.permissions) !== json(asset.contract.permissions)) {
    add('access_policy_changed', 'major');
  }
  if (
    json({ rules: previous.operation.validationRules, errors: previous.contract.errors }) !==
    json({ rules: asset.operation.validationRules, errors: asset.contract.errors })
  ) {
    add('validation_changed', 'patch');
  }
  if (operationMetadataSignature(previous) !== operationMetadataSignature(asset)) {
    add('metadata_changed', 'patch');
  }
  const level = maximumImpact(changes);
  return {
    level,
    compatibility: level === 'major' ? 'breaking' : 'compatible',
    recommendedVersion: publicationVersion(
      asset.version.current,
      existingRelease.version,
      level === 'none' ? 'patch' : level,
    ),
    changes,
  };
}

export function publishOperationInterface(input: {
  operationInterface: OperationInterface;
  signature: string;
  executionTemplate: PublishedOperationExecutionTemplate;
  models: readonly EngineModelNode[];
  relations?: readonly EngineRelationEdge[];
  existingRelease?: OperationInterfaceRelease;
  otherReleases?: readonly OperationInterfaceRelease[];
  now?: string;
}): OperationInterfacePublicationResult {
  const callableName = input.operationInterface.contract.invocation.callableName?.trim() ?? '';
  const issues: OperationInterfacePublicationIssue[] = [];
  if (!callableName) {
    issues.push({
      code: 'operation_publication_callable_name_required',
      message: 'Published operation interfaces require a callable name.',
      path: 'contract.invocation.callableName',
    });
  } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(callableName)) {
    issues.push({
      code: 'operation_publication_callable_name_invalid',
      message: 'Callable name must be a valid identifier.',
      path: 'contract.invocation.callableName',
    });
  }
  if (
    input.otherReleases?.some(
      (release) => release.callableName.toLowerCase() === callableName.toLowerCase(),
    )
  ) {
    issues.push({
      code: 'operation_publication_callable_name_conflict',
      message: `Operation callable name "${callableName}" is already published.`,
      path: 'contract.invocation.callableName',
    });
  }
  if (
    input.existingRelease?.signature === input.signature &&
    input.existingRelease.operationInterface.status === 'active'
  ) {
    issues.push({
      code: 'operation_publication_release_unchanged',
      message: 'The current draft is identical to the published operation release.',
    });
  }
  const compilation = compilePublishedOperationExecutionTemplate({
    operationInterface: input.operationInterface,
    models: input.models,
    relations: input.relations,
  });
  if (!compilation.template) {
    const blocking = compilation.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error',
    );
    issues.push(
      ...(blocking.length > 0
        ? blocking.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            path: diagnostic.path,
          }))
        : [
            {
              code: 'operation_publication_compilation_failed',
              message: 'The OperationInterface could not be compiled for publication.',
            },
          ]),
    );
  } else if (JSON.stringify(compilation.template) !== JSON.stringify(input.executionTemplate)) {
    issues.push({
      code: 'operation_publication_template_mismatch',
      message: 'The execution template does not match the current OperationInterface asset.',
      path: 'executionTemplate',
    });
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const now = input.now ?? new Date().toISOString();
  const impact = assessOperationInterfaceReleaseImpact(
    input.operationInterface,
    input.existingRelease,
  );
  const version = publicationVersion(
    input.operationInterface.version.current,
    input.existingRelease?.version,
    impact.level === 'none' ? 'patch' : impact.level,
  );
  const history = appendVersionHistory(
    input.operationInterface.version.history,
    input.existingRelease,
  );
  const activeInterface: OperationInterface = {
    ...input.operationInterface,
    status: 'active',
    version: {
      current: version,
      compatibility: impact.compatibility,
      ...(history.length > 0 ? { history } : {}),
    },
    lifecycle: {
      ...input.operationInterface.lifecycle,
      updatedAt: now,
      lastValidatedAt: now,
      publishedAt: now,
      deprecatedAt: undefined,
    },
  };
  const validation = validateEngineInterface(activeInterface, input.models);
  const blocking = validation.issues.filter((issue) => issue.severity === 'error');
  if (blocking.length > 0) {
    return {
      ok: false,
      issues: blocking.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path,
      })),
    };
  }
  const release: OperationInterfaceRelease = {
    version,
    publishedAt: now,
    callableName,
    signature: input.signature,
    operationInterface: structuredClone(activeInterface),
    executionTemplate: structuredClone(compilation.template!),
  };
  return { ok: true, release, operationInterface: activeInterface };
}

export function deprecateOperationInterfaceRelease(
  release: OperationInterfaceRelease,
  now = new Date().toISOString(),
): OperationInterfaceRelease {
  return {
    ...release,
    operationInterface: {
      ...release.operationInterface,
      status: 'deprecated',
      lifecycle: {
        ...release.operationInterface.lifecycle,
        updatedAt: now,
        deprecatedAt: now,
      },
    },
  };
}

export function appendOperationReleaseHistory(
  history: readonly OperationInterfaceRelease[] | undefined,
  release: OperationInterfaceRelease | undefined,
): OperationInterfaceRelease[] {
  if (!release) {
    return [...(history ?? [])];
  }
  const result = (history ?? []).filter((entry) => entry.version !== release.version);
  result.push(structuredClone(release));
  return result.sort((left, right) => compareVersions(left.version, right.version));
}

export function nextDraftOperationInterface(
  asset: OperationInterface,
  release: OperationInterfaceRelease,
  now: string,
): OperationInterface {
  return {
    ...asset,
    status: 'draft',
    version: {
      ...asset.version,
      current: publicationVersion(asset.version.current, release.version),
      compatibility: 'draft',
    },
    lifecycle: {
      ...asset.lifecycle,
      updatedAt: now,
      publishedAt: undefined,
      deprecatedAt: undefined,
    },
  };
}

function publicationVersion(
  candidate: string,
  previous?: string,
  impact: Exclude<OperationInterfaceReleaseImpactLevel, 'none'> = 'patch',
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
  previous: OperationInterfaceRelease | undefined,
): InterfaceVersionRecord[] {
  const result = [...(history ?? [])];
  if (previous && !result.some((entry) => entry.version === previous.version)) {
    result.push({
      version: previous.version,
      createdAt: previous.publishedAt,
      summary: 'Published operation interface release',
    });
  }
  return result;
}

function assessParameters(
  previous: OperationInterface,
  current: OperationInterface,
  add: (
    code: OperationInterfaceReleaseChange['code'],
    level: OperationInterfaceReleaseChange['level'],
    subject?: string,
  ) => void,
): void {
  const before = new Map(
    previous.contract.parameters.map((parameter) => [parameter.name, parameter]),
  );
  const after = new Map(
    current.contract.parameters.map((parameter) => [parameter.name, parameter]),
  );
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

function operationMetadataSignature(asset: OperationInterface): string {
  return json({
    name: asset.name,
    displayName: asset.displayName,
    description: asset.description,
    namespace: asset.namespace,
    tags: asset.tags,
  });
}

function maximumImpact(
  changes: readonly OperationInterfaceReleaseChange[],
): OperationInterfaceReleaseImpactLevel {
  return changes.reduce<OperationInterfaceReleaseImpactLevel>(
    (current, change) => (impactRank(change.level) > impactRank(current) ? change.level : current),
    'none',
  );
}

function impactRank(level: OperationInterfaceReleaseImpactLevel): number {
  return { none: 0, patch: 1, minor: 2, major: 3 }[level];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
