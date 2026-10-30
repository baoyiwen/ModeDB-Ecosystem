/** Pure deployment preview. It does not resolve DNS, fetch URLs, open paths or write configuration. */
import { createHash, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import type {
  DeploymentDraft,
  DeploymentPlan,
  DeploymentPreview,
  DeploymentCandidateConfig,
  DeviceRegistrationConnectionDescriptorV1,
  SecuritySourcePolicy,
} from '@mode-db/shared';
import { assertDeviceRegistrationConnectionDescriptor } from '@mode-db/shared';
import { SecurityError } from './security-errors.js';
import { validateSourcePolicy } from './network-policy.js';

export const deploymentHash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const fail = (): never => {
  throw new SecurityError('SECURITY_INVALID_REQUEST');
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail();
  }
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((k) => !keys.includes(k))) {
    fail();
  }
}
function text(value: unknown, max = 1024): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return fail();
  }
  return value;
}
function file(value: unknown): string {
  const path = text(value);
  if (
    !isAbsolute(path) ||
    /[<>|?*]/.test(path) ||
    /^(?:\\\\|\/\/|\\\?\?\\)/.test(path) ||
    path.includes('://') ||
    path.split(/[\\/]/).some((p) => p === '.' || p === '..') ||
    path.slice(3).includes(':')
  ) {
    return fail();
  }
  return path;
}
const loopback = (): SecuritySourcePolicy => ({
  allowListEnabled: true,
  allow: [
    { id: 'local-v4', source: '127.0.0.0/8' },
    { id: 'local-v6', source: '::1/128' },
  ],
});
export function parseDeploymentDraft(input: unknown): DeploymentDraft {
  const r = record(input);
  exact(r, [
    'mode',
    'port',
    'serverOrigin',
    'rpId',
    'certificatePem',
    'certificateFile',
    'privateKeyFile',
    'tlsMode',
    'spkiSha256',
    'allowedSources',
    'registrationEnabled',
    'windowHours',
  ]);
  if (
    !['local', 'lan'].includes(r.mode as string) ||
    !Number.isSafeInteger(r.port) ||
    (r.port as number) < 1 ||
    (r.port as number) > 65535
  ) {
    fail();
  }
  if (r.mode === 'local') {
    exact(r, ['mode', 'port']);
    return { mode: 'local', port: r.port as number };
  }
  const serverOrigin = text(r.serverOrigin),
    rpId = text(r.rpId, 253);
  let url: URL;
  try {
    url = new URL(serverOrigin);
  } catch {
    return fail();
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== serverOrigin ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.hostname !== rpId ||
    isIP(rpId) ||
    rpId === 'localhost' ||
    rpId.endsWith('.localhost') ||
    !/[a-z]/.test(rpId) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      rpId,
    ) ||
    Number(url.port || 443) !== r.port
  ) {
    fail();
  }
  if (
    typeof r.certificatePem !== 'string' ||
    r.certificatePem.length > 16384 ||
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\s*$/.test(
      r.certificatePem,
    )
  ) {
    fail();
  }
  if (
    !['public-ca', 'owner-pinned'].includes(r.tlsMode as string) ||
    typeof r.registrationEnabled !== 'boolean' ||
    !Number.isSafeInteger(r.windowHours) ||
    (r.windowHours as number) < 1 ||
    (r.windowHours as number) > 168
  ) {
    fail();
  }
  if (r.tlsMode === 'owner-pinned') {
    if (
      typeof r.spkiSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(r.spkiSha256) ||
      r.spkiSha256.length !== 64
    ) {
      fail();
    }
  } else if (r.spkiSha256 !== undefined) {
    fail();
  }
  if (
    !Array.isArray(r.allowedSources) ||
    !r.allowedSources.length ||
    r.allowedSources.length > 32 ||
    new Set(r.allowedSources).size !== r.allowedSources.length
  ) {
    fail();
  }
  const allowedSources = (r.allowedSources as unknown[]).map((source) => {
    const v = text(source, 128);
    const [ip, prefix, extra] = v.split('/');
    if (
      extra !== undefined ||
      !isIP(ip) ||
      prefix === undefined ||
      !/^\d+$/.test(prefix) ||
      Number(prefix) < 1 ||
      Number(prefix) > (isIP(ip) === 4 ? 32 : 128) ||
      Number(prefix).toString() !== prefix
    ) {
      fail();
    }
    return v;
  });
  validateSourcePolicy({
    allowListEnabled: true,
    allow: allowedSources.map((source, i) => ({ id: 'lan-' + i, source })),
  });
  const certificateFile = file(r.certificateFile),
    privateKeyFile = file(r.privateKeyFile);
  if (certificateFile.toLowerCase() === privateKeyFile.toLowerCase()) {
    fail();
  }
  return {
    mode: 'lan',
    port: r.port as number,
    serverOrigin,
    rpId,
    certificatePem: r.certificatePem as string,
    certificateFile,
    privateKeyFile,
    tlsMode: r.tlsMode as 'public-ca' | 'owner-pinned',
    ...(r.spkiSha256 ? { spkiSha256: r.spkiSha256 as string } : {}),
    allowedSources,
    registrationEnabled: r.registrationEnabled as boolean,
    windowHours: r.windowHours as number,
  };
}
export function previewDeployment(
  input: unknown,
  context: { instanceId: string; bootstrapSha256: string; designerDirectory: string },
  now = Date.now(),
): DeploymentPreview {
  const r = record(input);
  exact(r, ['format', 'instanceId', 'bootstrapSha256', 'preparedAtUtc', 'draft']);
  if (
    r.format !== 'modeldb.deployment-plan.v1' ||
    r.instanceId !== context.instanceId ||
    r.bootstrapSha256 !== context.bootstrapSha256
  ) {
    throw new SecurityError('SECURITY_FORBIDDEN');
  }
  if (
    typeof r.preparedAtUtc !== 'string' ||
    !Number.isFinite(Date.parse(r.preparedAtUtc)) ||
    new Date(Date.parse(r.preparedAtUtc)).toISOString() !== r.preparedAtUtc ||
    Date.parse(r.preparedAtUtc) > now ||
    now - Date.parse(r.preparedAtUtc) > 600000
  ) {
    throw new SecurityError('SECURITY_POLICY_CONFLICT');
  }
  const draft = parseDeploymentDraft(r.draft),
    plan: DeploymentPlan = {
      format: 'modeldb.deployment-plan.v1',
      instanceId: context.instanceId,
      bootstrapSha256: context.bootstrapSha256,
      preparedAtUtc: r.preparedAtUtc,
      draft,
    };
  const config: DeploymentCandidateConfig = {
    host: draft.mode === 'local' ? '127.0.0.1' : '0.0.0.0',
    port: draft.port,
    workspace: 'vault',
    logDir: 'logs',
    designerWorkspace: 'model_designer_workspace',
    security: {
      version: 1,
      hosting: { enabled: true, designerDirectory: context.designerDirectory, managementPort: 0 },
      network: { transport: { mode: 'loopback' }, data: loopback(), management: loopback() },
    },
  };
  let descriptor: DeviceRegistrationConnectionDescriptorV1 | undefined,
    certificate: DeploymentPreview['certificate'];
  if (draft.mode === 'lan') {
    try {
      const cert = new X509Certificate(draft.certificatePem!),
        spkiSha256 = deploymentHash(cert.publicKey.export({ type: 'spki', format: 'der' }));
      if (
        cert.ca ||
        cert.checkHost(draft.rpId!, { subject: 'never', wildcards: false }) !== draft.rpId ||
        Date.parse(cert.validFrom) > now ||
        Date.parse(cert.validTo) <= Date.parse(plan.preparedAtUtc) + draft.windowHours! * 3600000 ||
        (draft.tlsMode === 'owner-pinned' && draft.spkiSha256 !== spkiSha256)
      ) {
        return fail();
      }
      certificate = {
        spkiSha256,
        validFromUtc: new Date(cert.validFrom).toISOString(),
        validToUtc: new Date(cert.validTo).toISOString(),
        hostnameMatches: true,
      };
    } catch {
      return fail();
    }
    descriptor = {
      format: 'modeldb.device-registration-connection.v1',
      version: 1,
      instanceId: context.instanceId,
      serverOrigin: draft.serverOrigin!,
      rpId: draft.rpId!,
      registrationMode: draft.registrationEnabled ? 'enabled' : 'disabled',
      issuedAtUtc: plan.preparedAtUtc,
      expiresAtUtc: new Date(
        Date.parse(plan.preparedAtUtc) + draft.windowHours! * 3600000,
      ).toISOString(),
      deploymentDescriptorSha256: deploymentHash(
        JSON.stringify({
          instanceId: context.instanceId,
          serverOrigin: draft.serverOrigin,
          rpId: draft.rpId,
          tlsMode: draft.tlsMode,
          spkiSha256: draft.spkiSha256 ?? null,
        }),
      ),
      tls: {
        mode: draft.tlsMode!,
        minVersion: 'TLS1.2',
        ...(draft.spkiSha256 ? { spkiSha256: draft.spkiSha256 } : {}),
      },
    };
    assertDeviceRegistrationConnectionDescriptor(descriptor);
    config.publicBaseUrl = draft.serverOrigin;
    config.security.network = {
      transport: {
        mode: 'tls',
        certificateFile: draft.certificateFile!,
        privateKeyFile: draft.privateKeyFile!,
      },
      allowedOrigins: [draft.serverOrigin!],
      data: {
        allowListEnabled: true,
        allow: [
          ...loopback().allow!,
          ...draft.allowedSources!.map((source, i) => ({ id: 'lan-' + i, source })),
        ],
      },
      management: loopback(),
    };
    config.security.authentication = { enabled: true, allowStorageMigration: true };
    config.security.registration = { descriptor, allowStorageMigration: true };
  }
  return {
    plan,
    digest: deploymentHash(JSON.stringify(plan)),
    expiresAtUtc: new Date(Date.parse(plan.preparedAtUtc) + 600000).toISOString(),
    config,
    ...(descriptor ? { descriptor, certificate } : {}),
    trustVerified: false,
    dnsVerified: false,
    keyMatchVerified: false,
  };
}
