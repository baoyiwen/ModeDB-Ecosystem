import {
  constants,
  createHash,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import {
  recipientChallengeLabel,
  type RecipientChallenge,
  type RecipientKeyCommand,
  type RecipientKeyInfo,
  type RecipientProof,
} from '@mode-db/shared';
import type { RegistrationLedger } from './registration-ledger.js';
import { sameRegistrationPublicKey } from './registration-maintenance.js';
import { SecurityError } from './security-errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/;
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
const ID = /^[A-Za-z0-9_-]{1,96}(?![\s\S])/;
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
function requireValue(value: unknown): asserts value {
  if (!value) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
}
function exact(value: unknown, fields: string[]): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  requireValue(Object.keys(value).every((k) => fields.includes(k)));
  return value as Record<string, unknown>;
}
function canonicalBinary(value: unknown, min: number, max = min): Buffer {
  requireValue(
    typeof value === 'string' &&
      value.length <= Math.ceil((max * 4) / 3) &&
      /^[A-Za-z0-9_-]+$/.test(value),
  );
  const bytes = Buffer.from(value, 'base64url');
  requireValue(bytes.toString('base64url') === value && bytes.length >= min && bytes.length <= max);
  return bytes;
}
export function recipientPublicKey(pem: unknown): {
  publicKey: string;
  fingerprint: string;
  key: KeyObject;
} {
  requireValue(
    typeof pem === 'string' &&
      pem.length <= 2048 &&
      /^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----\s*$/.test(pem),
  );
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  requireValue(
    key.asymmetricKeyType === 'rsa' &&
      [3072, 4096].includes(key.asymmetricKeyDetails?.modulusLength ?? 0) &&
      key.asymmetricKeyDetails?.publicExponent === 65537n,
  );
  return {
    key,
    publicKey: key.export({ type: 'spki', format: 'pem' }).toString(),
    fingerprint: sha(key.export({ type: 'spki', format: 'der' })),
  };
}
export function parseRecipientCommand(value: unknown): RecipientKeyCommand {
  const r = exact(value, [
    'action',
    'instanceId',
    'revision',
    'confirm',
    'offset',
    'limit',
    'userId',
    'publicKey',
    'response',
    'id',
  ]);
  requireValue(typeof r.instanceId === 'string' && ID.test(r.instanceId));
  const extra: Record<string, string[]> = {
    'registration.recipient.list': ['offset', 'limit'],
    'registration.recipient.initialize': ['revision', 'confirm'],
    'registration.recipient.begin': ['revision', 'confirm', 'userId', 'publicKey'],
    'registration.recipient.complete': ['revision', 'confirm', 'response'],
    'registration.recipient.retire': ['revision', 'confirm', 'id'],
  };
  requireValue(typeof r.action === 'string' && Object.hasOwn(extra, r.action));
  exact(r, ['action', 'instanceId', ...extra[r.action]!]);
  if (r.action.endsWith('.list')) {
    requireValue(
      r.offset === undefined ||
        (typeof r.offset === 'number' &&
          Number.isSafeInteger(r.offset) &&
          r.offset >= 0 &&
          r.offset <= 10000),
    );
    requireValue(
      r.limit === undefined ||
        (typeof r.limit === 'number' &&
          Number.isSafeInteger(r.limit) &&
          r.limit >= 1 &&
          r.limit <= 100),
    );
  } else {
    requireValue(
      typeof r.revision === 'number' && Number.isSafeInteger(r.revision) && r.revision > 0,
    );
    if (r.confirm !== true) {
      throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
    }
  }
  if (r.action.endsWith('.begin')) {
    requireValue(typeof r.userId === 'string' && UUID.test(r.userId));
    recipientPublicKey(r.publicKey);
  }
  if (r.action.endsWith('.retire')) {
    requireValue(typeof r.id === 'string' && UUID.test(r.id));
  }
  if (r.action.endsWith('.complete')) {
    assertRecipientProof(r.response);
  }
  return r as unknown as RecipientKeyCommand;
}
export function assertRecipientProof(value: unknown): asserts value is RecipientProof {
  const r = exact(value, ['format', 'instanceId', 'challengeId', 'proof']);
  requireValue(
    Object.keys(r).length === 4 &&
      r.format === 'modeldb.recipient-proof.v1' &&
      typeof r.instanceId === 'string' &&
      ID.test(r.instanceId) &&
      typeof r.challengeId === 'string' &&
      UUID.test(r.challengeId) &&
      typeof r.proof === 'string' &&
      HASH.test(r.proof),
  );
}
type StoredChallenge = Omit<RecipientChallenge, 'ciphertext'> & {
  publicKey: string;
  proofHash: string;
  state: 'issued' | 'approved' | 'rejected';
};
export interface RecipientLedger {
  version: 1;
  keys: (RecipientKeyInfo & { publicKey: string })[];
  challenges: StoredChallenge[];
}
export const emptyRecipientLedger = (): RecipientLedger => ({
  version: 1,
  keys: [],
  challenges: [],
});
/** An approved authentication key cannot reuse an active, historical or pending recipient key. */
export function assertRecipientLoginKey(
  store: RecipientLedger | undefined,
  publicKeyCose: string,
  now: number,
): void {
  for (const entry of [
    ...(store?.keys ?? []),
    ...(store?.challenges.filter((c) => c.state === 'issued' && Date.parse(c.expiresAtUtc) > now) ??
      []),
  ]) {
    if (
      sameRegistrationPublicKey(
        publicKeyCose,
        rsaCoseForComparison(recipientPublicKey(entry.publicKey).key),
      )
    ) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
  }
}
function proofFor(label: string, secret: Buffer): string {
  return createHash('sha256')
    .update('modeldb.recipient-proof.v1\0')
    .update(label)
    .update('\0')
    .update(secret)
    .digest('hex');
}
/** Strict offline decryptor: accepts only a bounded, domain-specific challenge. */
export function answerRecipientChallenge(
  value: unknown,
  privateKey: KeyObject,
  now = Date.now(),
): RecipientProof {
  const b = exact(value, [
    'format',
    'instanceId',
    'userId',
    'challengeId',
    'keyVersion',
    'previousKeyId',
    'fingerprint',
    'createdAtUtc',
    'expiresAtUtc',
    'ciphertext',
  ]) as unknown as RecipientChallenge;
  assertBinding(b);
  requireValue(
    Object.keys(b).length === 10 &&
      Date.parse(b.createdAtUtc) <= now &&
      now < Date.parse(b.expiresAtUtc),
  );
  requireValue(
    privateKey.type === 'private' &&
      recipientPublicKey(
        createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(),
      ).fingerprint === b.fingerprint,
  );
  const ciphertext = canonicalBinary(b.ciphertext, 384, 512);
  let secret: Buffer | undefined;
  try {
    secret = privateDecrypt(
      {
        key: privateKey,
        oaepHash: 'sha256',
        oaepLabel: Buffer.from(recipientChallengeLabel(b)),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      ciphertext,
    );
    requireValue(secret.length === 32);
    return {
      format: 'modeldb.recipient-proof.v1',
      instanceId: b.instanceId,
      challengeId: b.challengeId,
      proof: proofFor(recipientChallengeLabel(b), secret),
    };
  } catch {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  } finally {
    secret?.fill(0);
  }
}
function assertBinding(b: Omit<RecipientChallenge, 'ciphertext'>): void {
  requireValue(
    b.format === 'modeldb.recipient-challenge.v1' &&
      typeof b.instanceId === 'string' &&
      ID.test(b.instanceId) &&
      UUID.test(b.userId) &&
      UUID.test(b.challengeId) &&
      Number.isSafeInteger(b.keyVersion) &&
      b.keyVersion >= 1 &&
      b.keyVersion <= 20 &&
      (b.previousKeyId === null || UUID.test(b.previousKeyId)) &&
      HASH.test(b.fingerprint),
  );
  for (const date of [b.createdAtUtc, b.expiresAtUtc]) {
    requireValue(
      typeof date === 'string' &&
        Number.isFinite(Date.parse(date)) &&
        new Date(date).toISOString() === date,
    );
  }
  requireValue(Date.parse(b.expiresAtUtc) - Date.parse(b.createdAtUtc) === 300000);
}
export function assertRecipientLedger(
  value: unknown,
  instanceId: string,
  registration: RegistrationLedger,
): asserts value is RecipientLedger {
  const s = exact(value, ['version', 'keys', 'challenges']) as unknown as RecipientLedger;
  requireValue(
    s.version === 1 &&
      Array.isArray(s.keys) &&
      s.keys.length <= 10000 &&
      Array.isArray(s.challenges) &&
      s.challenges.length <= 128,
  );
  const ids = new Set<string>(),
    fingerprints = new Set<string>(),
    versions = new Set<string>();
  for (const k of s.keys) {
    exact(k, [
      'id',
      'userId',
      'keyVersion',
      'fingerprint',
      'algorithm',
      'state',
      'createdAtUtc',
      'retiredAtUtc',
      'publicKey',
    ]);
    requireValue(UUID.test(k.id) && !ids.has(k.id) && !fingerprints.has(k.fingerprint));
    ids.add(k.id);
    fingerprints.add(k.fingerprint);
    requireValue(!versions.has(k.userId + ':' + k.keyVersion));
    versions.add(k.userId + ':' + k.keyVersion);
    const previous = s.keys.filter((v) => v.userId === k.userId && v.keyVersion < k.keyVersion);
    requireValue(
      registration.users.some((u) => u.id === k.userId) &&
        Number.isSafeInteger(k.keyVersion) &&
        k.keyVersion === previous.length + 1 &&
        k.keyVersion <= 20 &&
        s.keys.filter((v) => v.userId === k.userId && v.state === 'active').length <= 1,
    );
    requireValue(
      k.algorithm === 'RSA-OAEP-256' &&
        ['active', 'retired'].includes(k.state) &&
        recipientPublicKey(k.publicKey).fingerprint === k.fingerprint &&
        new Date(k.createdAtUtc).toISOString() === k.createdAtUtc,
    );
    requireValue(
      k.state === 'retired'
        ? typeof k.retiredAtUtc === 'string' &&
            new Date(k.retiredAtUtc).toISOString() === k.retiredAtUtc &&
            k.retiredAtUtc >= k.createdAtUtc
        : k.retiredAtUtc === undefined,
    );
  }
  const challenges = new Set<string>();
  for (const c of s.challenges) {
    exact(c, [
      'format',
      'instanceId',
      'userId',
      'challengeId',
      'keyVersion',
      'previousKeyId',
      'fingerprint',
      'createdAtUtc',
      'expiresAtUtc',
      'publicKey',
      'proofHash',
      'state',
    ]);
    assertBinding(c);
    requireValue(
      c.instanceId === instanceId &&
        !challenges.has(c.challengeId) &&
        registration.users.some((u) => u.id === c.userId) &&
        HASH.test(c.proofHash) &&
        ['issued', 'approved', 'rejected'].includes(c.state) &&
        recipientPublicKey(c.publicKey).fingerprint === c.fingerprint,
    );
    requireValue(
      c.previousKeyId === null ||
        s.keys.some(
          (k) =>
            k.id === c.previousKeyId && k.userId === c.userId && k.keyVersion === c.keyVersion - 1,
        ),
    );
    challenges.add(c.challengeId);
  }
}
export function recipientKeyPage(
  s: RecipientLedger | undefined,
  instanceId: string,
  revision: number,
  offset = 0,
  limit = 25,
) {
  const keys = s?.keys ?? [];
  return {
    instanceId,
    revision,
    initialized: !!s,
    total: keys.length,
    nextOffset: offset + limit < keys.length ? offset + limit : null,
    keys: keys
      .slice(offset, offset + limit)
      .map(({ publicKey: _, ...info }) => structuredClone(info)),
  };
}
export function beginRecipientChallenge(
  s: RecipientLedger,
  instanceId: string,
  userId: string,
  pem: string,
  now: number,
  registration: RegistrationLedger,
): RecipientChallenge {
  const { key, publicKey, fingerprint } = recipientPublicKey(pem);
  requireValue(!s.keys.some((k) => k.fingerprint === fingerprint));
  // Authentication and encryption domains cannot share the same public key.
  requireValue(
    !registration.credentials.some((k) =>
      sameRegistrationPublicKey(k.publicKeyCose, rsaCoseForComparison(key)),
    ),
  );
  s.challenges = s.challenges.filter((c) => Date.parse(c.expiresAtUtc) > now);
  const versions = s.keys.filter((k) => k.userId === userId);
  if (s.keys.length >= 10000 || versions.length >= 20 || s.challenges.length >= 128) {
    throw new SecurityError('SECURITY_RESPONSE_LIMIT');
  }
  const binding: Omit<RecipientChallenge, 'ciphertext'> = {
    format: 'modeldb.recipient-challenge.v1',
    instanceId,
    userId,
    challengeId: randomUUID(),
    keyVersion: versions.length + 1,
    previousKeyId: versions.find((k) => k.state === 'active')?.id ?? null,
    fingerprint,
    createdAtUtc: new Date(now).toISOString(),
    expiresAtUtc: new Date(now + 300000).toISOString(),
  };
  const label = recipientChallengeLabel(binding),
    secret = randomBytes(32);
  try {
    const ciphertext = publicEncrypt(
      {
        key,
        oaepHash: 'sha256',
        oaepLabel: Buffer.from(label),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      secret,
    ).toString('base64url');
    s.challenges.push({
      ...binding,
      publicKey,
      proofHash: sha(proofFor(label, secret)),
      state: 'issued',
    });
    return { ...binding, ciphertext };
  } finally {
    secret.fill(0);
  }
}
// Minimal canonical RSA COSE map, with definite byte strings; no WebAuthn private material.
function rsaCoseForComparison(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }),
    n = Buffer.from(jwk.n!, 'base64url'),
    e = Buffer.from(jwk.e!, 'base64url');
  const bytes = (b: Buffer) => {
    if (b.length < 24) {
      return Buffer.concat([Buffer.from([0x40 + b.length]), b]);
    }
    const size = Buffer.alloc(3);
    size[0] = 0x59;
    size.writeUInt16BE(b.length, 1);
    return Buffer.concat([size, b]);
  };
  return Buffer.concat([
    Buffer.from([0xa4, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00, 0x20]),
    bytes(n),
    Buffer.from([0x21]),
    bytes(e),
  ]).toString('base64url');
}
export function completeRecipientChallenge(
  s: RecipientLedger,
  response: RecipientProof,
  now: number,
  userUsable: (id: string) => boolean,
): boolean {
  const c = s.challenges.find((c) => c.challengeId === response.challengeId);
  if (!c || c.state !== 'issued') {
    throw new SecurityError('SECURITY_POLICY_CONFLICT');
  }
  const versions = s.keys.filter((k) => k.userId === c.userId);
  const ok =
    response.instanceId === c.instanceId &&
    Date.parse(c.expiresAtUtc) > now &&
    Date.parse(c.createdAtUtc) <= now &&
    userUsable(c.userId) &&
    c.keyVersion === versions.length + 1 &&
    c.previousKeyId === (versions.find((k) => k.state === 'active')?.id ?? null) &&
    !s.keys.some((k) => k.fingerprint === c.fingerprint) &&
    timingSafeEqual(Buffer.from(sha(response.proof), 'hex'), Buffer.from(c.proofHash, 'hex'));
  c.state = ok ? 'approved' : 'rejected';
  if (ok) {
    requireValue(s.keys.length < 10000 && versions.length < 20);
    const at = new Date(now).toISOString(),
      previous = versions.find((k) => k.state === 'active');
    if (previous) {
      previous.state = 'retired';
      previous.retiredAtUtc = at;
    }
    s.keys.push({
      id: randomUUID(),
      userId: c.userId,
      keyVersion: c.keyVersion,
      fingerprint: c.fingerprint,
      publicKey: c.publicKey,
      algorithm: 'RSA-OAEP-256',
      state: 'active',
      createdAtUtc: at,
    });
  }
  return ok;
}
