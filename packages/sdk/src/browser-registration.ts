import {
  DEVICE_AUTHENTICATION_API_V1 as AUTH,
  DEVICE_AUTHENTICATION_FORMAT,
  DEVICE_REGISTRATION_API_V1 as API,
  DEVICE_REGISTRATION_FORMAT as FORMAT,
  assertDeviceRegistrationCapabilities,
  assertDeviceRegistrationConnectionDescriptor,
  assertDeviceRegistrationDescriptorBinding,
  assertDeviceRegistrationBeginRequest,
  assertDeviceRegistrationBeginResponse,
  assertDeviceRegistrationCompleteRequest,
  assertDeviceRegistrationStatusResponse,
  isDeviceRegistrationInstanceId,
  type DeviceAuthenticationCapabilitiesV1,
  type DeviceAuthenticationBindingV1,
  type DeviceRegistrationConnectionDescriptorV1,
  type DeviceRegistrationBeginResponseV1,
  type DeviceRegistrationStatusResponseV1,
} from '@mode-db/shared';
import { connectionOrigin } from './connection-endpoint.js';
import { ConnectionSecurityError } from './connection-security.js';
import type { BrowserSessionConfig } from './browser-session.js';

export interface BrowserPublicKeyContext {
  readonly binding: DeviceAuthenticationBindingV1;
  readonly serverOrigin: string;
  readonly rpId: string;
  readonly loginEnabled: boolean;
  readonly registrationEnabled: boolean;
}
export interface BrowserRegistrationConfig extends BrowserSessionConfig {
  readonly createCredential?: (options: CredentialCreationOptions) => Promise<Credential | null>;
}
export interface BrowserRegistration {
  readonly initialStatus: DeviceRegistrationStatusResponseV1;
  /** The continuation bearer stays inside this closure. Poll no faster than five seconds. */
  status(): Promise<DeviceRegistrationStatusResponseV1>;
}
function fail(code = 'SECURITY_REGISTRATION_SCHEMA_INVALID'): never {
  throw new ConnectionSecurityError(code, 400);
}
function originFor(config: BrowserSessionConfig): string {
  const origin = connectionOrigin(config);
  if (
    typeof location === 'undefined' ||
    location.origin !== origin ||
    new URL(origin).protocol !== 'https:'
  ) {
    fail('SECURITY_REGISTRATION_ORIGIN_MISMATCH');
  }
  return origin;
}
async function request(
  config: BrowserSessionConfig,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await (config.fetchImpl ?? fetch)(originFor(config) + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: config.signal,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  // These endpoints never return business data. Bound both decoding and error diagnostics.
  const reader = response.body?.getReader();
  if (!reader) {
    fail();
  }
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        fail();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail();
  }
  if (!response.ok) {
    const raw = value as { code?: unknown; error?: unknown };
    const code = raw?.code ?? raw?.error;
    throw new ConnectionSecurityError(
      typeof code === 'string' && /^SECURITY_[A-Z0-9_]{1,100}$/.test(code)
        ? code
        : 'SECURITY_REGISTRATION_UNSUPPORTED',
      response.status,
    );
  }
  return value;
}

/** Discover only the current HTTPS origin. Descriptors never determine a fetch destination. */
export async function getBrowserPublicKeyContext(
  config: BrowserSessionConfig,
): Promise<BrowserPublicKeyContext> {
  const origin = originFor(config);
  const auth = (await request(config, AUTH.capabilities)) as DeviceAuthenticationCapabilitiesV1;
  const d = auth?.deployment;
  if (
    auth?.format !== DEVICE_AUTHENTICATION_FORMAT ||
    auth.version !== 1 ||
    !isDeviceRegistrationInstanceId(auth.instanceId) ||
    !['enabled', 'disabled'].includes(auth.mode) ||
    auth.userVerification !== 'required' ||
    !d ||
    d.serverOrigin !== origin ||
    d.rpId !== new URL(origin).hostname ||
    !/^[a-f0-9]{64}$/.test(d.deploymentDescriptorSha256)
  ) {
    fail('SECURITY_AUTHENTICATION_DEPLOYMENT_MISMATCH');
  }
  const registration = await request(config, API.capabilities);
  assertDeviceRegistrationCapabilities(registration);
  if (registration.instanceId !== auth.instanceId) {
    fail('SECURITY_REGISTRATION_INSTANCE_MISMATCH');
  }
  return Object.freeze({
    binding: Object.freeze({
      format: DEVICE_AUTHENTICATION_FORMAT,
      version: 1,
      instanceId: auth.instanceId,
      deploymentDescriptorSha256: d.deploymentDescriptorSha256,
    }),
    serverOrigin: origin,
    rpId: d.rpId,
    loginEnabled: auth.mode === 'enabled',
    registrationEnabled: registration.mode === 'enabled',
  });
}

export async function getBrowserRegistrationDescriptor(
  config: BrowserSessionConfig,
  context: BrowserPublicKeyContext,
): Promise<DeviceRegistrationConnectionDescriptorV1> {
  const value = await request(config, API.descriptor);
  assertDeviceRegistrationConnectionDescriptor(value);
  if (
    value.serverOrigin !== originFor(config) ||
    value.instanceId !== context.binding.instanceId ||
    value.rpId !== context.rpId ||
    value.deploymentDescriptorSha256 !== context.binding.deploymentDescriptorSha256
  ) {
    fail('SECURITY_REGISTRATION_INSTANCE_MISMATCH');
  }
  assertDeviceRegistrationDescriptorBinding(value, value, Date.now());
  return value;
}

/** Strict JSON only, bounded to 16 KiB and compared with a live same-origin descriptor. */
export function parseBrowserRegistrationDescriptor(
  text: string,
  trusted: DeviceRegistrationConnectionDescriptorV1,
): DeviceRegistrationConnectionDescriptorV1 {
  if (new TextEncoder().encode(text).length > 16384) {
    fail();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail();
  }
  assertDeviceRegistrationDescriptorBinding(value, trusted, Date.now());
  return value;
}

export async function registerBrowserCredential(
  config: BrowserRegistrationConfig,
  context: BrowserPublicKeyContext,
  descriptor: DeviceRegistrationConnectionDescriptorV1,
  displayName: string,
): Promise<BrowserRegistration> {
  const trusted = await getBrowserRegistrationDescriptor(config, context);
  assertDeviceRegistrationDescriptorBinding(descriptor, trusted, Date.now());
  const base = {
    format: FORMAT,
    version: 1 as const,
    instanceId: context.binding.instanceId,
    deploymentDescriptorSha256: context.binding.deploymentDescriptorSha256,
  };
  const input = { ...base, displayName, userVerification: 'required' as const };
  assertDeviceRegistrationBeginRequest(input);
  const begin = (await request(config, API.begin, input)) as DeviceRegistrationBeginResponseV1;
  assertDeviceRegistrationBeginResponse(begin);
  if (
    begin.instanceId !== base.instanceId ||
    begin.deploymentDescriptorSha256 !== base.deploymentDescriptorSha256 ||
    begin.publicKey.rp.id !== context.rpId ||
    Date.parse(begin.challengeExpiresAtUtc) <= Date.now()
  ) {
    fail('SECURITY_REGISTRATION_INSTANCE_MISMATCH');
  }
  const decode = (s: string): ArrayBuffer =>
    Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
  const encode = (b: ArrayBuffer): string =>
    btoa(String.fromCharCode(...new Uint8Array(b)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const create = config.createCredential ?? ((options) => navigator.credentials.create(options));
  const credential = (await create({
    signal: config.signal,
    publicKey: {
      ...begin.publicKey,
      pubKeyCredParams: [...begin.publicKey.pubKeyCredParams],
      challenge: decode(begin.publicKey.challenge),
      user: { ...begin.publicKey.user, id: decode(begin.publicKey.user.id) },
    },
  })) as PublicKeyCredential | null;
  if (!credential || credential.type !== 'public-key') {
    fail('SECURITY_REGISTRATION_PROOF_INVALID');
  }
  config.signal?.throwIfAborted();
  const response = credential.response as AuthenticatorAttestationResponse;
  const complete = {
    ...base,
    registrationId: begin.registrationId,
    challengeId: begin.challengeId,
    continuationSecret: begin.continuationSecret,
    credential: {
      id: credential.id,
      rawId: encode(credential.rawId),
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: encode(response.clientDataJSON),
        attestationObject: encode(response.attestationObject),
      },
    },
  };
  assertDeviceRegistrationCompleteRequest(complete);
  const check = (value: unknown) => {
    assertDeviceRegistrationStatusResponse(value);
    if (value.instanceId !== base.instanceId || value.registrationId !== begin.registrationId) {
      fail('SECURITY_REGISTRATION_INSTANCE_MISMATCH');
    }
    return value;
  };
  const initialStatus = check(await request(config, API.complete, complete));
  let nextPoll = Date.now() + 5000;
  return Object.freeze({
    initialStatus,
    async status() {
      if (Date.now() < nextPoll) {
        fail('SECURITY_REGISTRATION_RATE_LIMITED');
      }
      nextPoll = Date.now() + 5000;
      const result = check(
        await request(config, API.status, {
          format: FORMAT,
          version: 1,
          instanceId: base.instanceId,
          registrationId: begin.registrationId,
          continuationSecret: begin.continuationSecret,
        }),
      );
      nextPoll = Date.now() + 5000;
      return result;
    },
  });
}
