/** Public, browser-safe contracts for the future device-registration runtime. */

export const DEVICE_REGISTRATION_FORMAT = 'modeldb.device-registration.v1' as const;
export const DEVICE_REGISTRATION_DESCRIPTOR_FORMAT =
  'modeldb.device-registration-connection.v1' as const;
export const DEVICE_REGISTRATION_SCHEMA_VERSION = 1 as const;
export const DEVICE_REGISTRATION_PROTOCOL_VERSION = 1 as const;
export const DEVICE_REGISTRATION_CHALLENGE_BYTES = 32 as const;
export const DEVICE_REGISTRATION_API_V1 = Object.freeze({
  capabilities: '/security/registration/v1/capabilities',
  descriptor: '/security/registration/v1/connection',
  begin: '/security/registration/v1/begin',
  complete: '/security/registration/v1/complete',
  status: '/security/registration/v1/status',
});

export type DeviceRegistrationErrorCode =
  | 'SECURITY_REGISTRATION_DISABLED'
  | 'SECURITY_REGISTRATION_UNSUPPORTED'
  | 'SECURITY_REGISTRATION_SCHEMA_INVALID'
  | 'SECURITY_REGISTRATION_INSTANCE_MISMATCH'
  | 'SECURITY_REGISTRATION_ORIGIN_MISMATCH'
  | 'SECURITY_REGISTRATION_RP_ID_MISMATCH'
  | 'SECURITY_REGISTRATION_CHALLENGE_INVALID'
  | 'SECURITY_REGISTRATION_CHALLENGE_EXPIRED'
  | 'SECURITY_REGISTRATION_CHALLENGE_REPLAYED'
  | 'SECURITY_REGISTRATION_PROOF_INVALID'
  | 'SECURITY_REGISTRATION_APPROVAL_REQUIRED'
  | 'SECURITY_REGISTRATION_PENDING'
  | 'SECURITY_REGISTRATION_REJECTED'
  | 'SECURITY_REGISTRATION_EXPIRED'
  | 'SECURITY_REGISTRATION_CREDENTIAL_DISABLED'
  | 'SECURITY_REGISTRATION_CREDENTIAL_REVOKED'
  | 'SECURITY_REGISTRATION_CAPACITY'
  | 'SECURITY_REGISTRATION_RATE_LIMITED'
  | 'SECURITY_REGISTRATION_CONFLICT'
  | 'SECURITY_REGISTRATION_NOT_FOUND';

export class DeviceRegistrationContractError extends Error {
  constructor(
    readonly code: DeviceRegistrationErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'DeviceRegistrationContractError';
  }
}

export type DeviceRegistrationMode = 'planned' | 'enabled' | 'disabled';
export type DeviceRegistrationApplicationState = 'pending' | 'approved' | 'rejected' | 'expired';
export type DeviceRegistrationCredentialState = 'active' | 'disabled' | 'revoked';
export type DeviceRegistrationChallengeState = 'issued' | 'consumed' | 'expired' | 'rejected';
export type DeviceRegistrationOutcome = 'succeeded' | 'denied' | 'failed';

export interface DeviceRegistrationErrorResponseV1 {
  readonly format: typeof DEVICE_REGISTRATION_FORMAT;
  readonly version: 1;
  readonly requestId: string;
  readonly code: DeviceRegistrationErrorCode;
  readonly retryAfterSeconds?: number;
}

export interface DeviceRegistrationCapabilitiesV1 {
  readonly format: typeof DEVICE_REGISTRATION_FORMAT;
  readonly version: 1;
  readonly instanceId: string;
  readonly mode: DeviceRegistrationMode;
  readonly protocolVersions: readonly [1];
  readonly proof: 'webauthn';
  readonly userVerification: 'required';
  readonly approval: 'local-operator';
  readonly capacity: DeviceRegistrationCapacityContractV1;
}

export interface DeviceRegistrationConnectionDescriptorV1 {
  readonly format: typeof DEVICE_REGISTRATION_DESCRIPTOR_FORMAT;
  readonly version: typeof DEVICE_REGISTRATION_SCHEMA_VERSION;
  readonly instanceId: string;
  readonly serverOrigin: string;
  readonly rpId: string;
  readonly registrationMode: DeviceRegistrationMode;
  readonly issuedAtUtc: string;
  readonly expiresAtUtc: string;
  /** SHA-256 of the canonical deployment descriptor, never a secret. */
  readonly deploymentDescriptorSha256: string;
  readonly tls: {
    readonly mode: 'public-ca' | 'owner-pinned';
    readonly minVersion: 'TLS1.2';
    readonly spkiSha256?: string;
  };
}

export interface DeviceRegistrationBeginRequestV1 {
  readonly format: typeof DEVICE_REGISTRATION_FORMAT;
  readonly version: typeof DEVICE_REGISTRATION_PROTOCOL_VERSION;
  readonly instanceId: string;
  readonly deploymentDescriptorSha256: string;
  readonly displayName: string;
  readonly userVerification: 'required';
}

export interface DeviceRegistrationBeginResponseV1 {
  readonly format: typeof DEVICE_REGISTRATION_FORMAT;
  readonly version: typeof DEVICE_REGISTRATION_PROTOCOL_VERSION;
  readonly registrationId: string;
  readonly challengeId: string;
  /** Ephemeral 32-byte bearer for complete/status only; persist only its digest. */
  readonly continuationSecret: string;
  readonly challengeExpiresAtUtc: string;
  readonly instanceId: string;
  readonly deploymentDescriptorSha256: string;
  readonly publicKey: {
    readonly rp: { readonly id: string; readonly name: string };
    readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
    readonly challenge: string;
    readonly pubKeyCredParams: readonly [
      { readonly type: 'public-key'; readonly alg: -7 },
      { readonly type: 'public-key'; readonly alg: -257 },
    ];
    readonly timeout: 60000;
    readonly attestation: 'none';
    readonly authenticatorSelection: {
      readonly residentKey: 'preferred';
      readonly userVerification: 'required';
    };
  };
}

/** Browser-safe subset of RegistrationResponseJSON; no server-library dependency. */
export interface DeviceRegistrationProofV1 {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly authenticatorAttachment?: 'platform' | 'cross-platform';
  readonly clientExtensionResults: { readonly credProps?: { readonly rk?: boolean } };
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports?: readonly (
      | 'usb'
      | 'nfc'
      | 'ble'
      | 'internal'
      | 'hybrid'
      | 'cable'
      | 'smart-card'
    )[];
  };
}

export interface DeviceRegistrationCompleteRequestV1 {
  readonly format: typeof DEVICE_REGISTRATION_FORMAT;
  readonly version: typeof DEVICE_REGISTRATION_PROTOCOL_VERSION;
  readonly registrationId: string;
  readonly challengeId: string;
  readonly instanceId: string;
  readonly deploymentDescriptorSha256: string;
  readonly continuationSecret: string;
  readonly credential: DeviceRegistrationProofV1;
}

export interface DeviceRegistrationStatusRequestV1 {
  readonly format: typeof DEVICE_REGISTRATION_FORMAT;
  readonly version: 1;
  readonly instanceId: string;
  readonly registrationId: string;
  readonly continuationSecret: string;
}

export interface DeviceRegistrationStatusResponseV1 {
  readonly format: typeof DEVICE_REGISTRATION_FORMAT;
  readonly version: typeof DEVICE_REGISTRATION_PROTOCOL_VERSION;
  readonly registrationId: string;
  readonly instanceId: string;
  readonly state: DeviceRegistrationApplicationState;
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
  readonly approvedAtUtc?: string;
  readonly rejectedAtUtc?: string;
  readonly reasonCode?: DeviceRegistrationErrorCode;
}

export interface DeviceRegistrationCredentialRecordV1 {
  readonly format: typeof DEVICE_REGISTRATION_FORMAT;
  readonly version: typeof DEVICE_REGISTRATION_SCHEMA_VERSION;
  readonly credentialId: string;
  readonly registrationId: string;
  readonly instanceId: string;
  readonly principalId: string;
  readonly state: DeviceRegistrationCredentialState;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
  readonly disabledAtUtc?: string;
  readonly revokedAtUtc?: string;
}

export interface DeviceRegistrationAuditEventV1 {
  readonly format: typeof DEVICE_REGISTRATION_FORMAT;
  readonly version: typeof DEVICE_REGISTRATION_SCHEMA_VERSION;
  readonly eventId: string;
  readonly requestId: string;
  readonly timestampUtc: string;
  readonly action:
    | 'descriptor.downloaded'
    | 'registration.begin'
    | 'registration.complete'
    | 'registration.status'
    | 'registration.approved'
    | 'registration.rejected'
    | 'registration.expired'
    | 'credential.login'
    | 'credential.enabled'
    | 'credential.disabled'
    | 'credential.revoked';
  readonly result: DeviceRegistrationOutcome;
  readonly reasonCode?: DeviceRegistrationErrorCode;
  readonly instanceId: string;
  readonly registrationId?: string;
  readonly credentialId?: string;
  readonly actor: {
    readonly kind: 'anonymous' | 'device' | 'operator';
    readonly identityTrust: 'unverified' | 'verified';
    readonly principalId?: string;
  };
  readonly source: {
    readonly transport: 'http' | 'websocket' | 'local-ipc';
    readonly clientIp?: string;
    readonly clientIpBasis?: 'socket' | 'trusted-proxy';
  };
  readonly origin?: string;
  readonly rpId?: string;
  readonly durationMs?: number;
  readonly observedCount?: number;
}

export interface DeviceRegistrationCapacityContractV1 {
  readonly version: typeof DEVICE_REGISTRATION_SCHEMA_VERSION;
  readonly challengeBytes: typeof DEVICE_REGISTRATION_CHALLENGE_BYTES;
  readonly challengeTtlSeconds: 60;
  readonly registrationStartPerSourcePerMinute: 5;
  readonly registrationStartPerInstancePerMinute: 60;
  readonly maxPendingApplications: 1000;
  readonly applicationTtlSeconds: 86400;
  readonly minStatusPollIntervalSeconds: 5;
  readonly maxPublicDescriptorBytes: 16384;
  readonly maxDisplayNameChars: 80;
  readonly maxCredentialIdBytes: 1024;
  readonly maxClientDataJsonBytes: 16384;
  readonly maxAuthenticatorDataBytes: 16384;
  readonly maxAttestationObjectBytes: 65536;
  readonly maxAuditReasonChars: 128;
  readonly maxStatusPageSize: 100;
  readonly maxDescriptorTtlSeconds: 86400;
  readonly maxOutstandingChallenges: 1000;
  readonly maxCredentialsPerPrincipal: 20;
  readonly maxCredentialsPerInstance: 10000;
  readonly maxConcurrentProofVerifications: 4;
  readonly maxQueuedProofVerifications: 32;
  readonly maxRegistrationBodyBytes: 131072;
  readonly statusPollPerInstancePerMinute: 12000;
  readonly descriptorPerSourcePerMinute: 30;
  readonly descriptorPerInstancePerMinute: 300;
  readonly reservedLocalOperatorConcurrency: 1;
}

export const DEVICE_REGISTRATION_CAPACITY_V1: DeviceRegistrationCapacityContractV1 = Object.freeze({
  version: DEVICE_REGISTRATION_SCHEMA_VERSION,
  challengeBytes: DEVICE_REGISTRATION_CHALLENGE_BYTES,
  challengeTtlSeconds: 60,
  registrationStartPerSourcePerMinute: 5,
  registrationStartPerInstancePerMinute: 60,
  maxPendingApplications: 1000,
  applicationTtlSeconds: 86400,
  minStatusPollIntervalSeconds: 5,
  maxPublicDescriptorBytes: 16384,
  maxDisplayNameChars: 80,
  maxCredentialIdBytes: 1024,
  maxClientDataJsonBytes: 16384,
  maxAuthenticatorDataBytes: 16384,
  maxAttestationObjectBytes: 65536,
  maxAuditReasonChars: 128,
  maxStatusPageSize: 100,
  maxDescriptorTtlSeconds: 86400,
  maxOutstandingChallenges: 1000,
  maxCredentialsPerPrincipal: 20,
  maxCredentialsPerInstance: 10000,
  maxConcurrentProofVerifications: 4,
  maxQueuedProofVerifications: 32,
  maxRegistrationBodyBytes: 131072,
  statusPollPerInstancePerMinute: 12000,
  descriptorPerSourcePerMinute: 30,
  descriptorPerInstancePerMinute: 300,
  reservedLocalOperatorConcurrency: 1,
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DNS_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ERROR_CODES = new Set<DeviceRegistrationErrorCode>([
  'SECURITY_REGISTRATION_DISABLED',
  'SECURITY_REGISTRATION_UNSUPPORTED',
  'SECURITY_REGISTRATION_SCHEMA_INVALID',
  'SECURITY_REGISTRATION_INSTANCE_MISMATCH',
  'SECURITY_REGISTRATION_ORIGIN_MISMATCH',
  'SECURITY_REGISTRATION_RP_ID_MISMATCH',
  'SECURITY_REGISTRATION_CHALLENGE_INVALID',
  'SECURITY_REGISTRATION_CHALLENGE_EXPIRED',
  'SECURITY_REGISTRATION_CHALLENGE_REPLAYED',
  'SECURITY_REGISTRATION_PROOF_INVALID',
  'SECURITY_REGISTRATION_APPROVAL_REQUIRED',
  'SECURITY_REGISTRATION_PENDING',
  'SECURITY_REGISTRATION_REJECTED',
  'SECURITY_REGISTRATION_EXPIRED',
  'SECURITY_REGISTRATION_CREDENTIAL_DISABLED',
  'SECURITY_REGISTRATION_CREDENTIAL_REVOKED',
  'SECURITY_REGISTRATION_CAPACITY',
  'SECURITY_REGISTRATION_RATE_LIMITED',
  'SECURITY_REGISTRATION_CONFLICT',
  'SECURITY_REGISTRATION_NOT_FOUND',
]);

function fail(code: DeviceRegistrationErrorCode, message = code): never {
  throw new DeviceRegistrationContractError(code, message);
}

function object(value: unknown, code: DeviceRegistrationErrorCode): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
}

function stringField(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  return value;
}

function timestamp(value: unknown): string {
  const parsed = stringField(value, ISO_UTC);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  return parsed;
}

function byteLimit(value: unknown, max: number, exact?: number): string {
  const encoded = stringField(value, BASE64URL);
  const size = Math.floor((encoded.length * 6) / 8);
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(
    encoded.at(-1)!,
  );
  if (
    encoded.length % 4 === 1 ||
    (encoded.length % 4 === 2 && (last & 15) !== 0) ||
    (encoded.length % 4 === 3 && (last & 3) !== 0) ||
    size > max ||
    (exact !== undefined && size !== exact)
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  return encoded;
}

function jsonLimit(value: unknown, max: number): void {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length <= max) {
      return;
    }
  } catch {
    /* Non-JSON inputs are invalid contracts. */
  }
  fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
}

function httpsOrigin(value: unknown): URL {
  const origin = stringField(value, /^https:\/\/[^/?#]+$/);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return fail('SECURITY_REGISTRATION_ORIGIN_MISMATCH');
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    !DNS_NAME.test(url.hostname) ||
    url.hostname.endsWith('.localhost') ||
    !url.hostname.split('.').some((label) => /[a-z]/.test(label))
  ) {
    fail('SECURITY_REGISTRATION_ORIGIN_MISMATCH');
  }
  return url;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail('SECURITY_REGISTRATION_CAPACITY');
  }
  return value as number;
}

function protocolHeader(value: Record<string, unknown>): void {
  if (value.format !== DEVICE_REGISTRATION_FORMAT || value.version !== 1) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
}

export function isDeviceRegistrationInstanceId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID_V4.test(value);
}

export function assertDeviceRegistrationConnectionDescriptor(
  input: unknown,
): asserts input is DeviceRegistrationConnectionDescriptorV1 {
  const value = object(input, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  jsonLimit(value, DEVICE_REGISTRATION_CAPACITY_V1.maxPublicDescriptorBytes);
  exactKeys(value, [
    'format',
    'version',
    'instanceId',
    'serverOrigin',
    'rpId',
    'registrationMode',
    'issuedAtUtc',
    'expiresAtUtc',
    'deploymentDescriptorSha256',
    'tls',
  ]);
  if (value.format !== DEVICE_REGISTRATION_DESCRIPTOR_FORMAT || value.version !== 1) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  stringField(value.instanceId, UUID_V4);
  const originUrl = httpsOrigin(value.serverOrigin);
  const rpId = stringField(value.rpId, DNS_NAME);
  if (value.rpId !== originUrl.hostname || rpId.includes('..')) {
    fail('SECURITY_REGISTRATION_RP_ID_MISMATCH');
  }
  if (!['planned', 'enabled', 'disabled'].includes(value.registrationMode as string)) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  timestamp(value.issuedAtUtc);
  timestamp(value.expiresAtUtc);
  const lifetime =
    Date.parse(value.expiresAtUtc as string) - Date.parse(value.issuedAtUtc as string);
  if (lifetime <= 0 || lifetime > DEVICE_REGISTRATION_CAPACITY_V1.maxDescriptorTtlSeconds * 1000) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  stringField(value.deploymentDescriptorSha256, HEX_64);
  const tls = object(value.tls, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  exactKeys(tls, ['mode', 'minVersion', 'spkiSha256']);
  if (!['public-ca', 'owner-pinned'].includes(tls.mode as string) || tls.minVersion !== 'TLS1.2') {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  if (tls.mode === 'owner-pinned') {
    stringField(tls.spkiSha256, HEX_64);
  } else if (tls.spkiSha256 !== undefined) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
}

/** Compare with independently trusted deployment data; the downloaded file is not a trust root. */
export function assertDeviceRegistrationDescriptorBinding(
  input: unknown,
  trusted: Pick<
    DeviceRegistrationConnectionDescriptorV1,
    'instanceId' | 'serverOrigin' | 'rpId' | 'deploymentDescriptorSha256' | 'tls'
  >,
  nowMs: number,
): asserts input is DeviceRegistrationConnectionDescriptorV1 {
  assertDeviceRegistrationConnectionDescriptor(input);
  assertDeviceRegistrationInstanceBinding(trusted.instanceId, input.instanceId);
  if (input.serverOrigin !== trusted.serverOrigin) {
    fail('SECURITY_REGISTRATION_ORIGIN_MISMATCH');
  }
  if (input.rpId !== trusted.rpId) {
    fail('SECURITY_REGISTRATION_RP_ID_MISMATCH');
  }
  if (
    input.deploymentDescriptorSha256 !== trusted.deploymentDescriptorSha256 ||
    input.tls.mode !== trusted.tls.mode ||
    input.tls.spkiSha256 !== trusted.tls.spkiSha256 ||
    input.tls.minVersion !== trusted.tls.minVersion
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  if (
    !Number.isFinite(nowMs) ||
    nowMs < Date.parse(input.issuedAtUtc) ||
    nowMs >= Date.parse(input.expiresAtUtc)
  ) {
    fail('SECURITY_REGISTRATION_EXPIRED');
  }
}

export function assertDeviceRegistrationCapabilities(
  input: unknown,
): asserts input is DeviceRegistrationCapabilitiesV1 {
  const value = object(input, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  protocolHeader(value);
  exactKeys(value, [
    'format',
    'version',
    'instanceId',
    'mode',
    'protocolVersions',
    'proof',
    'userVerification',
    'approval',
    'capacity',
  ]);
  stringField(value.instanceId, UUID_V4);
  if (
    !['planned', 'enabled', 'disabled'].includes(value.mode as string) ||
    !Array.isArray(value.protocolVersions) ||
    value.protocolVersions.length !== 1 ||
    value.protocolVersions[0] !== 1 ||
    value.proof !== 'webauthn' ||
    value.userVerification !== 'required' ||
    value.approval !== 'local-operator'
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  assertDeviceRegistrationCapacity(value.capacity);
}

export function assertDeviceRegistrationCapacity(
  input: unknown,
): asserts input is DeviceRegistrationCapacityContractV1 {
  const value = object(input, 'SECURITY_REGISTRATION_CAPACITY');
  const keys = Object.keys(DEVICE_REGISTRATION_CAPACITY_V1);
  exactKeys(value, keys);
  for (const key of keys) {
    if (
      value[key] !==
      DEVICE_REGISTRATION_CAPACITY_V1[key as keyof DeviceRegistrationCapacityContractV1]
    ) {
      fail('SECURITY_REGISTRATION_CAPACITY');
    }
  }
  for (const key of keys) {
    positiveInteger(value[key]);
  }
}

export function assertDeviceRegistrationInstanceBinding(
  expectedInstanceId: string,
  presentedInstanceId: string,
): true {
  if (!isDeviceRegistrationInstanceId(expectedInstanceId)) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  if (presentedInstanceId !== expectedInstanceId) {
    fail('SECURITY_REGISTRATION_INSTANCE_MISMATCH');
  }
  return true;
}

export function assertDeviceRegistrationBeginRequest(
  input: unknown,
): asserts input is DeviceRegistrationBeginRequestV1 {
  const value = object(input, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  protocolHeader(value);
  exactKeys(value, [
    'format',
    'version',
    'instanceId',
    'deploymentDescriptorSha256',
    'displayName',
    'userVerification',
  ]);
  stringField(value.instanceId, UUID_V4);
  stringField(value.deploymentDescriptorSha256, HEX_64);
  if (
    typeof value.displayName !== 'string' ||
    value.displayName.length < 1 ||
    value.displayName.length > 80 ||
    value.displayName.trim() !== value.displayName ||
    /[\u0000-\u001f\u007f]/.test(value.displayName)
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  if (value.userVerification !== 'required') {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
}

export function assertDeviceRegistrationCompleteRequest(
  input: unknown,
): asserts input is DeviceRegistrationCompleteRequestV1 {
  const value = object(input, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  protocolHeader(value);
  exactKeys(value, [
    'format',
    'version',
    'registrationId',
    'challengeId',
    'instanceId',
    'deploymentDescriptorSha256',
    'continuationSecret',
    'credential',
  ]);
  stringField(value.registrationId, SAFE_ID);
  stringField(value.challengeId, SAFE_ID);
  stringField(value.instanceId, UUID_V4);
  stringField(value.deploymentDescriptorSha256, HEX_64);
  byteLimit(value.continuationSecret, 32, 32);
  jsonLimit(value, DEVICE_REGISTRATION_CAPACITY_V1.maxRegistrationBodyBytes);
  const credential = object(value.credential, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  exactKeys(credential, [
    'id',
    'rawId',
    'type',
    'authenticatorAttachment',
    'clientExtensionResults',
    'response',
  ]);
  byteLimit(credential.id, 1024);
  if (
    credential.id !== credential.rawId ||
    credential.type !== 'public-key' ||
    (credential.authenticatorAttachment !== undefined &&
      !['platform', 'cross-platform'].includes(credential.authenticatorAttachment as string))
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  const extensions = object(
    credential.clientExtensionResults,
    'SECURITY_REGISTRATION_SCHEMA_INVALID',
  );
  exactKeys(extensions, ['credProps']);
  if (extensions.credProps !== undefined) {
    const props = object(extensions.credProps, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
    exactKeys(props, ['rk']);
    if (props.rk !== undefined && typeof props.rk !== 'boolean') {
      fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
    }
  }
  const response = object(credential.response, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  exactKeys(response, ['clientDataJSON', 'attestationObject', 'transports']);
  byteLimit(response.clientDataJSON, 16384);
  byteLimit(response.attestationObject, 65536);
  if (response.transports !== undefined) {
    if (
      !Array.isArray(response.transports) ||
      response.transports.length > 7 ||
      new Set(response.transports).size !== response.transports.length ||
      response.transports.some(
        (item) =>
          !['usb', 'nfc', 'ble', 'internal', 'hybrid', 'cable', 'smart-card'].includes(
            item as string,
          ),
      )
    ) {
      fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
    }
  }
}

export function assertDeviceRegistrationStatusRequest(
  input: unknown,
): asserts input is DeviceRegistrationStatusRequestV1 {
  const value = object(input, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  protocolHeader(value);
  exactKeys(value, ['format', 'version', 'instanceId', 'registrationId', 'continuationSecret']);
  stringField(value.instanceId, UUID_V4);
  stringField(value.registrationId, SAFE_ID);
  byteLimit(value.continuationSecret, 32, 32);
}

export function assertDeviceRegistrationBeginResponse(
  input: unknown,
): asserts input is DeviceRegistrationBeginResponseV1 {
  const value = object(input, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  protocolHeader(value);
  exactKeys(value, [
    'format',
    'version',
    'registrationId',
    'challengeId',
    'continuationSecret',
    'challengeExpiresAtUtc',
    'instanceId',
    'deploymentDescriptorSha256',
    'publicKey',
  ]);
  stringField(value.registrationId, SAFE_ID);
  stringField(value.challengeId, SAFE_ID);
  stringField(value.instanceId, UUID_V4);
  stringField(value.deploymentDescriptorSha256, HEX_64);
  byteLimit(value.continuationSecret, 32, 32);
  timestamp(value.challengeExpiresAtUtc);
  const options = object(value.publicKey, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  exactKeys(options, [
    'rp',
    'user',
    'challenge',
    'pubKeyCredParams',
    'timeout',
    'attestation',
    'authenticatorSelection',
  ]);
  byteLimit(options.challenge, 32, 32);
  const rp = object(options.rp, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  exactKeys(rp, ['id', 'name']);
  stringField(rp.id, DNS_NAME);
  stringField(rp.name, /^[^\u0000-\u001f\u007f]{1,80}$/);
  const user = object(options.user, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  exactKeys(user, ['id', 'name', 'displayName']);
  byteLimit(user.id, 32, 32);
  stringField(user.name, SAFE_ID);
  stringField(user.displayName, /^[^\u0000-\u001f\u007f]{1,80}$/);
  if (!Array.isArray(options.pubKeyCredParams) || options.pubKeyCredParams.length !== 2) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  for (const [index, alg] of [-7, -257].entries()) {
    const item = object(options.pubKeyCredParams[index], 'SECURITY_REGISTRATION_SCHEMA_INVALID');
    exactKeys(item, ['type', 'alg']);
    if (item.type !== 'public-key' || item.alg !== alg) {
      fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
    }
  }
  const selection = object(options.authenticatorSelection, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  exactKeys(selection, ['residentKey', 'userVerification']);
  if (
    options.timeout !== 60000 ||
    options.attestation !== 'none' ||
    selection.residentKey !== 'preferred' ||
    selection.userVerification !== 'required'
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
}

export function assertDeviceRegistrationStatusResponse(
  input: unknown,
): asserts input is DeviceRegistrationStatusResponseV1 {
  const value = object(input, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  protocolHeader(value);
  exactKeys(value, [
    'format',
    'version',
    'registrationId',
    'instanceId',
    'state',
    'createdAtUtc',
    'expiresAtUtc',
    'approvedAtUtc',
    'rejectedAtUtc',
    'reasonCode',
  ]);
  stringField(value.registrationId, SAFE_ID);
  stringField(value.instanceId, UUID_V4);
  const created = Date.parse(timestamp(value.createdAtUtc));
  const expires = Date.parse(timestamp(value.expiresAtUtc));
  if (
    expires <= created ||
    expires - created > 86400000 ||
    !['pending', 'approved', 'rejected', 'expired'].includes(value.state as string)
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  if (
    (value.state === 'approved') !== (value.approvedAtUtc !== undefined) ||
    (value.state === 'rejected') !== (value.rejectedAtUtc !== undefined)
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  for (const field of ['approvedAtUtc', 'rejectedAtUtc']) {
    if (value[field] !== undefined) {
      const time = Date.parse(timestamp(value[field]));
      if (time < created || time >= expires) {
        fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
      }
    }
  }
  if (
    value.reasonCode !== undefined &&
    !ERROR_CODES.has(value.reasonCode as DeviceRegistrationErrorCode)
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
}

const APPLICATION_TRANSITIONS: Readonly<
  Record<DeviceRegistrationApplicationState, readonly DeviceRegistrationApplicationState[]>
> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: [],
  rejected: [],
  expired: [],
};

const CREDENTIAL_TRANSITIONS: Readonly<
  Record<DeviceRegistrationCredentialState, readonly DeviceRegistrationCredentialState[]>
> = {
  active: ['disabled', 'revoked'],
  disabled: ['active', 'revoked'],
  revoked: [],
};

const CHALLENGE_TRANSITIONS: Readonly<
  Record<DeviceRegistrationChallengeState, readonly DeviceRegistrationChallengeState[]>
> = {
  issued: ['consumed', 'expired', 'rejected'],
  consumed: [],
  expired: [],
  rejected: [],
};

export function canTransitionDeviceRegistrationApplication(
  from: DeviceRegistrationApplicationState,
  to: DeviceRegistrationApplicationState,
): boolean {
  return Object.hasOwn(APPLICATION_TRANSITIONS, from) && APPLICATION_TRANSITIONS[from].includes(to);
}

export function canTransitionDeviceRegistrationCredential(
  from: DeviceRegistrationCredentialState,
  to: DeviceRegistrationCredentialState,
): boolean {
  return Object.hasOwn(CREDENTIAL_TRANSITIONS, from) && CREDENTIAL_TRANSITIONS[from].includes(to);
}

export function canTransitionDeviceRegistrationChallenge(
  from: DeviceRegistrationChallengeState,
  to: DeviceRegistrationChallengeState,
): boolean {
  return Object.hasOwn(CHALLENGE_TRANSITIONS, from) && CHALLENGE_TRANSITIONS[from].includes(to);
}

export function assertDeviceRegistrationTransition(
  kind: 'application' | 'credential' | 'challenge',
  from: string,
  to: string,
): true {
  const allowed =
    kind === 'application'
      ? canTransitionDeviceRegistrationApplication(
          from as DeviceRegistrationApplicationState,
          to as DeviceRegistrationApplicationState,
        )
      : kind === 'credential'
        ? canTransitionDeviceRegistrationCredential(
            from as DeviceRegistrationCredentialState,
            to as DeviceRegistrationCredentialState,
          )
        : kind === 'challenge' &&
          canTransitionDeviceRegistrationChallenge(
            from as DeviceRegistrationChallengeState,
            to as DeviceRegistrationChallengeState,
          );
  if (!allowed) {
    fail('SECURITY_REGISTRATION_CONFLICT');
  }
  return true;
}

export function assertDeviceRegistrationAuditEvent(
  input: unknown,
): asserts input is DeviceRegistrationAuditEventV1 {
  const value = object(input, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  exactKeys(value, [
    'format',
    'version',
    'eventId',
    'requestId',
    'timestampUtc',
    'action',
    'result',
    'reasonCode',
    'instanceId',
    'registrationId',
    'credentialId',
    'actor',
    'source',
    'origin',
    'rpId',
    'durationMs',
    'observedCount',
  ]);
  if (value.format !== DEVICE_REGISTRATION_FORMAT || value.version !== 1) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  stringField(value.eventId, SAFE_ID);
  stringField(value.requestId, SAFE_ID);
  timestamp(value.timestampUtc);
  stringField(value.instanceId, UUID_V4);
  if (value.registrationId !== undefined) {
    stringField(value.registrationId, SAFE_ID);
  }
  if (value.credentialId !== undefined) {
    stringField(value.credentialId, SAFE_ID);
  }
  if (!['succeeded', 'denied', 'failed'].includes(value.result as string)) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  if (
    ![
      'descriptor.downloaded',
      'registration.begin',
      'registration.complete',
      'registration.status',
      'registration.approved',
      'registration.rejected',
      'registration.expired',
      'credential.login',
      'credential.enabled',
      'credential.disabled',
      'credential.revoked',
    ].includes(value.action as string)
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  if (
    value.reasonCode !== undefined &&
    (typeof value.reasonCode !== 'string' ||
      !ERROR_CODES.has(value.reasonCode as DeviceRegistrationErrorCode))
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  const actor = object(value.actor, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  exactKeys(actor, ['kind', 'identityTrust', 'principalId']);
  if (
    !['anonymous', 'device', 'operator'].includes(actor.kind as string) ||
    !['unverified', 'verified'].includes(actor.identityTrust as string)
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  if (actor.principalId !== undefined) {
    stringField(actor.principalId, SAFE_ID);
  }
  if (
    (actor.kind === 'anonymous' &&
      (actor.identityTrust !== 'unverified' || actor.principalId !== undefined)) ||
    (actor.identityTrust === 'verified' && actor.principalId === undefined) ||
    (actor.identityTrust === 'unverified' && actor.principalId !== undefined)
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  const source = object(value.source, 'SECURITY_REGISTRATION_SCHEMA_INVALID');
  exactKeys(source, ['transport', 'clientIp', 'clientIpBasis']);
  if (!['http', 'websocket', 'local-ipc'].includes(source.transport as string)) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  if (
    source.clientIpBasis !== undefined &&
    !['socket', 'trusted-proxy'].includes(source.clientIpBasis as string)
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  if (source.clientIp !== undefined) {
    const ip = stringField(source.clientIp, /^[0-9a-fA-F:.]{2,45}$/);
    try {
      const url = new URL(ip.includes(':') ? `http://[${ip}]` : `http://${ip}`);
      if (!ip.includes(':') && url.hostname !== ip) {
        fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
      }
    } catch {
      fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
    }
  }
  if (
    (source.clientIp === undefined) !== (source.clientIpBasis === undefined) ||
    (source.transport === 'local-ipc' && source.clientIp !== undefined)
  ) {
    fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
  }
  if (value.origin !== undefined) {
    httpsOrigin(value.origin);
  }
  if (value.rpId !== undefined) {
    stringField(value.rpId, DNS_NAME);
    if (value.origin !== undefined && new URL(value.origin as string).hostname !== value.rpId) {
      fail('SECURITY_REGISTRATION_RP_ID_MISMATCH');
    }
  }
  if (value.durationMs !== undefined) {
    if (
      typeof value.durationMs !== 'number' ||
      !Number.isFinite(value.durationMs) ||
      value.durationMs < 0
    ) {
      fail('SECURITY_REGISTRATION_SCHEMA_INVALID');
    }
  }
  if (value.observedCount !== undefined) {
    positiveInteger(value.observedCount);
  }
}
