/** Internal, encrypted login challenge journal. Stores digests, never assertions or cookies. */
import { SecurityError } from './security-errors.js';

export interface AuthenticationChallenge {
  id: string;
  instanceId: string;
  serverOrigin: string;
  rpId: string;
  deploymentDescriptorSha256: string;
  accessEpoch: number;
  challengeHash: string;
  browserHash: string;
  rawIdHash?: string;
  createdAtUtc: string;
  expiresAtUtc: string;
  state: 'issued' | 'claimed' | 'succeeded' | 'rejected';
  claimedAtUtc?: string;
  finishedAtUtc?: string;
  sessionId?: string;
}
export interface AuthenticationLedger {
  version: 1;
  challenges: AuthenticationChallenge[];
}
export function emptyAuthenticationLedger(): AuthenticationLedger {
  return { version: 1, challenges: [] };
}
function check(value: unknown): asserts value {
  if (!value) {
    throw new SecurityError('SECURITY_STORE_INVALID');
  }
}
const id = /^[A-Za-z0-9_-]{1,96}$/;
const hash = /^[a-f0-9]{64}$/;
const date = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function assertAuthenticationLedger(
  value: unknown,
  instanceId: string,
): asserts value is AuthenticationLedger {
  check(value && typeof value === 'object');
  const s = value as AuthenticationLedger;
  check(
    Object.keys(s).every((k) => ['version', 'challenges'].includes(k)) &&
      s.version === 1 &&
      Array.isArray(s.challenges) &&
      s.challenges.length <= 1000,
  );
  check(new Set(s.challenges.map((c) => c.id)).size === s.challenges.length);
  for (const c of s.challenges) {
    check(
      c &&
        typeof c === 'object' &&
        Object.keys(c).every((k) =>
          [
            'id',
            'instanceId',
            'serverOrigin',
            'rpId',
            'deploymentDescriptorSha256',
            'accessEpoch',
            'challengeHash',
            'browserHash',
            'rawIdHash',
            'createdAtUtc',
            'expiresAtUtc',
            'state',
            'claimedAtUtc',
            'finishedAtUtc',
            'sessionId',
          ].includes(k),
        ),
    );
    check(
      id.test(c.id) &&
        c.instanceId === instanceId &&
        Number.isSafeInteger(c.accessEpoch) &&
        c.accessEpoch > 0,
    );
    const origin = new URL(c.serverOrigin);
    check(
      origin.protocol === 'https:' &&
        origin.origin === c.serverOrigin &&
        origin.hostname === c.rpId,
    );
    check(
      [c.deploymentDescriptorSha256, c.challengeHash, c.browserHash].every(
        (h) => typeof h === 'string' && hash.test(h),
      ) &&
        (c.rawIdHash === undefined || hash.test(c.rawIdHash)),
    );
    check(
      date(c.createdAtUtc) &&
        date(c.expiresAtUtc) &&
        Date.parse(c.expiresAtUtc) === Date.parse(c.createdAtUtc) + 60000,
    );
    check(['issued', 'claimed', 'succeeded', 'rejected'].includes(c.state));
    check(
      c.claimedAtUtc === undefined ||
        (date(c.claimedAtUtc) && Date.parse(c.claimedAtUtc) >= Date.parse(c.createdAtUtc)),
    );
    check(
      c.finishedAtUtc === undefined ||
        (date(c.finishedAtUtc) && Date.parse(c.finishedAtUtc) >= Date.parse(c.createdAtUtc)),
    );
    check(c.state !== 'issued' || (!c.claimedAtUtc && !c.finishedAtUtc && !c.sessionId));
    check(c.state !== 'claimed' || (c.claimedAtUtc && !c.finishedAtUtc && !c.sessionId));
    check(!['succeeded', 'rejected'].includes(c.state) || c.finishedAtUtc);
    check(
      c.state !== 'succeeded' ||
        (c.claimedAtUtc &&
          c.sessionId &&
          id.test(c.sessionId) &&
          Date.parse(c.finishedAtUtc!) < Date.parse(c.expiresAtUtc)),
    );
    check(c.state === 'succeeded' || c.sessionId === undefined);
  }
}
