/** Explicit new-instance deployment. No default config discovery and no service restart. */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { DeploymentDraft, DeploymentPlan, DeploymentWizardStatus } from '@mode-db/shared';
import { SecurityRegistry, type SecurityRegistryOptions } from './security-registry.js';
import { SecurityError } from './security-errors.js';
import { deploymentHash, previewDeployment } from './deployment-wizard.js';
import { loadHostedAssets } from './browser-hosting.js';
import { SecurityNetworkPolicy } from './network-policy.js';
import { SecurityProtection } from './security-protection.js';

export const BOOTSTRAP_CONFIG = 'modeldb.bootstrap.json',
  DEPLOYED_CONFIG = 'modeldb.deployment.json';
const MARKER = '.modeldb-deployment.json',
  CLAIM = '.modeldb-deployment-commit.json';
const invalid = (): never => {
  throw new SecurityError('SECURITY_INVALID_REQUEST');
};
/** Reject links/junctions and ambiguous names along the entire explicit path. */
export function deploymentPath(value: string, existing = true): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    value !== value.trim() ||
    /[\u0000-\u001f<>|?*]/.test(value) ||
    /^(?:\\\\|\/\/)/.test(value) ||
    value.includes('://') ||
    value.split(/[\\/]/).some((s) => s === '.' || s === '..' || /[. ]$/.test(s)) ||
    value.slice(3).includes(':')
  ) {
    return invalid();
  }
  const full = resolve(value);
  let current = parse(full).root;
  for (const segment of full.slice(current.length).split(sep)) {
    current = join(current, segment);
    if (!existing && current === full && !existsSync(current)) {
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== full)) {
      return invalid();
    }
  }
  return full;
}
function readBounded(path: string, max: number): Buffer {
  deploymentPath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) {
    return invalid();
  }
  return readFileSync(path);
}
function writeNew(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
interface Marker {
  format: 'modeldb.deployment-bootstrap.v1';
  instanceId: string;
  bootstrapSha256: string;
  designerDirectory: string;
}
function context(registry: SecurityRegistry, configFile: string): Marker {
  const root = dirname(configFile),
    marker = JSON.parse(readBounded(join(root, MARKER), 4096).toString('utf8')) as Marker;
  if (
    Object.keys(marker).sort().join(',') !==
      'bootstrapSha256,designerDirectory,format,instanceId' ||
    marker.format !== 'modeldb.deployment-bootstrap.v1' ||
    marker.instanceId !== registry.status().instanceId ||
    typeof marker.designerDirectory !== 'string' ||
    !isAbsolute(marker.designerDirectory) ||
    !/^[a-f0-9]{64}$/.test(marker.bootstrapSha256) ||
    marker.bootstrapSha256.length !== 64 ||
    basename(configFile) !== BOOTSTRAP_CONFIG ||
    existsSync(join(root, CLAIM)) ||
    existsSync(join(root, DEPLOYED_CONFIG)) ||
    deploymentHash(readBounded(configFile, 8192)) !== marker.bootstrapSha256
  ) {
    throw new SecurityError('SECURITY_POLICY_CONFLICT');
  }
  const bootstrap = JSON.parse(readBounded(configFile, 8192).toString('utf8')) as {
    security?: { hosting?: { designerDirectory?: unknown } };
  };
  if (bootstrap.security?.hosting?.designerDirectory !== marker.designerDirectory) {
    throw new SecurityError('SECURITY_POLICY_CONFLICT');
  }
  registry.assertDeploymentUnused();
  return marker;
}
export class DeploymentWizard {
  constructor(
    private readonly registry: SecurityRegistry,
    private readonly configFile: string,
  ) {}
  status(): DeploymentWizardStatus {
    try {
      const c = context(this.registry, this.configFile);
      return { instanceId: c.instanceId, eligible: true, bootstrapSha256: c.bootstrapSha256 };
    } catch {
      return { instanceId: this.registry.status().instanceId, eligible: false };
    }
  }
  preview(draft: DeploymentDraft) {
    const c = context(this.registry, this.configFile);
    const result = previewDeployment(
      {
        format: 'modeldb.deployment-plan.v1',
        instanceId: c.instanceId,
        bootstrapSha256: c.bootstrapSha256,
        preparedAtUtc: new Date().toISOString(),
        draft,
      },
      c,
    );
    // Audit metadata only, before returning the plan. Never log PEM, paths or the request body.
    this.registry.recordDeploymentPreview();
    return result;
  }
}
/** Test options are explicit injection only; CLI always uses native OS protection. */
export function initializeDeployment(
  target: string,
  designer: string,
  port: number,
  options: SecurityRegistryOptions = {},
) {
  deploymentPath(target, false);
  deploymentPath(designer);
  if (existsSync(target) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return invalid();
  }
  loadHostedAssets(designer, [target]);
  mkdirSync(target);
  const configFile = join(target, BOOTSTRAP_CONFIG);
  const registry = SecurityRegistry.open(join(target, 'security'), options);
  try {
    const c = {
      instanceId: registry.status().instanceId,
      bootstrapSha256: '',
      designerDirectory: resolve(designer),
    };
    const config = previewDeployment(
      {
        format: 'modeldb.deployment-plan.v1',
        instanceId: c.instanceId,
        bootstrapSha256: '',
        preparedAtUtc: new Date().toISOString(),
        draft: { mode: 'local', port },
      },
      c,
    ).config;
    writeNew(configFile, config);
    c.bootstrapSha256 = deploymentHash(readBounded(configFile, 8192));
    writeNew(join(target, MARKER), { format: 'modeldb.deployment-bootstrap.v1', ...c });
    return { instanceId: c.instanceId, configFile };
  } finally {
    registry.close();
  }
}
export function finalizeDeployment(
  target: string,
  planFile: string,
  digest: string,
  options: SecurityRegistryOptions = {},
) {
  deploymentPath(target);
  deploymentPath(planFile);
  if (!/^[a-f0-9]{64}$/.test(digest) || digest.length !== 64) {
    return invalid();
  }
  const plan = JSON.parse(readBounded(planFile, 32768).toString('utf8')) as DeploymentPlan;
  // Existing marker required before opening; never initialize an arbitrary instance during finalize.
  if (
    !existsSync(join(target, MARKER)) ||
    !existsSync(join(target, 'security', 'registry.ready'))
  ) {
    return invalid();
  }
  const registry = SecurityRegistry.open(join(target, 'security'), options);
  let protection: SecurityProtection | undefined;
  try {
    const c = context(registry, join(target, BOOTSTRAP_CONFIG)),
      preview = previewDeployment(plan, c);
    if (preview.digest !== digest) {
      throw new SecurityError('SECURITY_POLICY_CONFLICT');
    }
    loadHostedAssets(c.designerDirectory, [target]);
    if (preview.plan.draft.mode === 'lan') {
      const draft = preview.plan.draft;
      const bytes = readBounded(draft.certificateFile!, 16384);
      if (!new X509Certificate(bytes).raw.equals(new X509Certificate(draft.certificatePem!).raw)) {
        throw new SecurityError('SECURITY_POLICY_CONFLICT');
      }
      // Validate metadata/path only. Private key contents are read only by normal TLS startup.
      deploymentPath(draft.privateKeyFile!);
      const key = lstatSync(draft.privateKeyFile!);
      if (!key.isFile() || key.nlink !== 1) {
        return invalid();
      }
    }
    if (registry.protectionState()?.pending) {
      throw new SecurityError('SECURITY_POLICY_CONFLICT');
    }
    const network = new SecurityNetworkPolicy(
      {},
      { host: '127.0.0.1', port: plan.draft.port, directory: target },
    );
    protection = new SecurityProtection(registry, network);
    const next = {
      data: preview.config.security.network.data,
      management: preview.config.security.network.management,
      rate: protection.snapshot().config.rate,
    };
    const checked = protection.preview(next);
    // A durable one-shot marker makes partial commits explicit and prevents blind retries.
    writeNew(join(target, CLAIM), {
      format: 'modeldb.deployment-commit.v1',
      instanceId: c.instanceId,
      digest,
      startedAtUtc: new Date().toISOString(),
    });
    const applied = protection.apply(next, checked.revision, checked.id);
    protection.confirm(applied.pending!.id);
    const configFile = join(target, DEPLOYED_CONFIG);
    writeNew(configFile, preview.config);
    return { instanceId: c.instanceId, configFile, digest };
  } catch (error) {
    if (existsSync(join(target, CLAIM))) {
      throw new SecurityError('SECURITY_OUTCOME_UNCONFIRMED');
    }
    throw error;
  } finally {
    protection?.close();
    registry.close();
  }
}
