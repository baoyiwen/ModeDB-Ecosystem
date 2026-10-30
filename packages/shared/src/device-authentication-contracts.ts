/** Browser-safe WebAuthn login wire contract; contains no private keys or bearer credentials. */
import { isDeviceRegistrationInstanceId } from './device-registration-contracts.js';

export const DEVICE_AUTHENTICATION_FORMAT = 'modeldb.device-authentication.v1' as const;
export const DEVICE_AUTHENTICATION_API_V1 = Object.freeze({
  capabilities: '/security/authentication/v1/capabilities',
  begin: '/security/authentication/v1/begin',
  complete: '/security/authentication/v1/complete',
});
export const DEVICE_AUTHENTICATION_CAPACITY_V1 = Object.freeze({
  challengeTtlSeconds: 60,
  maxOutstandingChallenges: 1000,
  beginPerSourcePerMinute: 10,
  beginPerInstancePerMinute: 120,
  completePerSourcePerMinute: 20,
  completePerInstancePerMinute: 240,
  maxConcurrentProofs: 4,
  maxQueuedProofs: 32,
  maxBodyBytes: 65536,
  maxCredentialIdBytes: 1024,
  maxClientDataBytes: 16384,
  maxAuthenticatorDataBytes: 16384,
  maxSignatureBytes: 1024,
});
export type DeviceAuthenticationErrorCode =
  | 'SECURITY_AUTHENTICATION_DISABLED'
  | 'SECURITY_AUTHENTICATION_SCHEMA_INVALID'
  | 'SECURITY_AUTHENTICATION_INSTANCE_MISMATCH'
  | 'SECURITY_AUTHENTICATION_DEPLOYMENT_MISMATCH'
  | 'SECURITY_AUTHENTICATION_ORIGIN_DENIED'
  | 'SECURITY_AUTHENTICATION_CHALLENGE_EXPIRED'
  | 'SECURITY_AUTHENTICATION_CHALLENGE_REPLAYED'
  | 'SECURITY_AUTHENTICATION_PROOF_INVALID'
  | 'SECURITY_AUTHENTICATION_CAPACITY'
  | 'SECURITY_AUTHENTICATION_RATE_LIMITED'
  | 'SECURITY_AUTHENTICATION_UNSUPPORTED';
export class DeviceAuthenticationContractError extends Error {
  constructor(readonly code: DeviceAuthenticationErrorCode) {
    super(code);
    this.name = 'DeviceAuthenticationContractError';
  }
}
export interface DeviceAuthenticationBindingV1 {
  readonly format: typeof DEVICE_AUTHENTICATION_FORMAT;
  readonly version: 1;
  readonly instanceId: string;
  readonly deploymentDescriptorSha256: string;
}
export interface DeviceAuthenticationBeginRequestV1 extends DeviceAuthenticationBindingV1 {
  /** Optional non-secret browser credential ID hint; never an authorization claim. */
  readonly rawId?: string;
}
export interface DeviceAuthenticationBeginResponseV1 extends DeviceAuthenticationBindingV1 {
  readonly challengeId: string;
  readonly expiresAtUtc: string;
  readonly publicKey: {
    readonly challenge: string;
    readonly rpId: string;
    readonly timeout: 60000;
    readonly userVerification: 'required';
    readonly allowCredentials: readonly { readonly id: string; readonly type: 'public-key' }[];
  };
}
export interface DeviceAuthenticationProofV1 {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly authenticatorAttachment?: 'platform' | 'cross-platform';
  readonly clientExtensionResults: Readonly<Record<string, never>>;
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string | null;
  };
}
export interface DeviceAuthenticationCompleteRequestV1 extends DeviceAuthenticationBindingV1 {
  readonly challengeId: string;
  readonly credential: DeviceAuthenticationProofV1;
}
export interface DeviceAuthenticationCapabilitiesV1 {
  readonly format: typeof DEVICE_AUTHENTICATION_FORMAT;
  readonly version: 1;
  readonly instanceId: string;
  readonly mode: 'enabled' | 'disabled';
  readonly userVerification: 'required';
  /** Public login binding; independent of the registration download window. */
  readonly deployment?: {
    readonly serverOrigin: string;
    readonly rpId: string;
    readonly deploymentDescriptorSha256: string;
  };
  readonly capacity: typeof DEVICE_AUTHENTICATION_CAPACITY_V1;
}

const ID = /^[A-Za-z0-9_-]{1,96}$/;
const HEX = /^[a-f0-9]{64}$/;
const DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
function check(condition: unknown): asserts condition {
  if (!condition) {
    throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_SCHEMA_INVALID');
  }
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  check(Object.keys(value).every((key) => keys.includes(key)));
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): asserts value is string {
  check(typeof value === 'string' && pattern.exec(value)?.[0] === value);
}
function binary(value: unknown, max: number, exact?: number): void {
  text(value, /^[A-Za-z0-9_-]+$/);
  const size = Math.floor((value.length * 6) / 8);
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(
    value.at(-1)!,
  );
  check(
    value.length % 4 !== 1 &&
      !(value.length % 4 === 2 && last & 15) &&
      !(value.length % 4 === 3 && last & 3) &&
      size <= max &&
      (exact === undefined || size === exact),
  );
}
function binding(value: Record<string, unknown>): void {
  check(value.format === DEVICE_AUTHENTICATION_FORMAT && value.version === 1);
  check(isDeviceRegistrationInstanceId(value.instanceId));
  text(value.deploymentDescriptorSha256, HEX);
}
function limit(value: unknown): void {
  try {
    check(
      new TextEncoder().encode(JSON.stringify(value)).length <=
        DEVICE_AUTHENTICATION_CAPACITY_V1.maxBodyBytes,
    );
  } catch {
    check(false);
  }
}
const fields = ['format', 'version', 'instanceId', 'deploymentDescriptorSha256'];
export function assertDeviceAuthenticationBeginRequest(
  value: unknown,
): asserts value is DeviceAuthenticationBeginRequestV1 {
  const v = object(value, [...fields, 'rawId']);
  binding(v);
  if (v.rawId !== undefined) {
    binary(v.rawId, 1024);
  }
  limit(value);
}
export function assertDeviceAuthenticationCompleteRequest(
  value: unknown,
): asserts value is DeviceAuthenticationCompleteRequestV1 {
  const v = object(value, [...fields, 'challengeId', 'credential']);
  binding(v);
  text(v.challengeId, ID);
  const p = object(v.credential, [
    'id',
    'rawId',
    'type',
    'authenticatorAttachment',
    'clientExtensionResults',
    'response',
  ]);
  check(p.type === 'public-key' && p.id === p.rawId);
  binary(p.rawId, 1024);
  check(
    p.authenticatorAttachment === undefined ||
      ['platform', 'cross-platform'].includes(p.authenticatorAttachment as string),
  );
  object(p.clientExtensionResults, []);
  const r = object(p.response, ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle']);
  binary(r.clientDataJSON, 16384);
  binary(r.authenticatorData, 16384);
  binary(r.signature, 1024);
  if (r.userHandle !== undefined && r.userHandle !== null) {
    binary(r.userHandle, 32, 32);
  }
  limit(value);
}
export function assertDeviceAuthenticationBeginResponse(
  value: unknown,
): asserts value is DeviceAuthenticationBeginResponseV1 {
  const v = object(value, [...fields, 'challengeId', 'expiresAtUtc', 'publicKey']);
  binding(v);
  text(v.challengeId, ID);
  text(v.expiresAtUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  check(
    Number.isFinite(Date.parse(v.expiresAtUtc)) &&
      new Date(v.expiresAtUtc).toISOString() === v.expiresAtUtc,
  );
  const p = object(v.publicKey, [
    'challenge',
    'rpId',
    'timeout',
    'userVerification',
    'allowCredentials',
  ]);
  binary(p.challenge, 32, 32);
  text(p.rpId, DNS);
  check(p.timeout === 60000 && p.userVerification === 'required');
  check(Array.isArray(p.allowCredentials) && p.allowCredentials.length <= 1);
  for (const item of p.allowCredentials) {
    const c = object(item, ['id', 'type']);
    binary(c.id, 1024);
    check(c.type === 'public-key');
  }
  limit(value);
}
