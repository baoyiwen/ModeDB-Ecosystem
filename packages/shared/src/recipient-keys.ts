/** Independent encryption recipients. No authentication keys or private material. */
export interface RecipientKeyInfo {
  id: string;
  userId: string;
  keyVersion: number;
  fingerprint: string;
  algorithm: 'RSA-OAEP-256';
  state: 'active' | 'retired';
  createdAtUtc: string;
  retiredAtUtc?: string;
}
export interface RecipientChallengeBinding {
  format: 'modeldb.recipient-challenge.v1';
  instanceId: string;
  userId: string;
  challengeId: string;
  keyVersion: number;
  previousKeyId: string | null;
  fingerprint: string;
  createdAtUtc: string;
  expiresAtUtc: string;
}
export interface RecipientChallenge extends RecipientChallengeBinding {
  ciphertext: string;
}
export interface RecipientProof {
  format: 'modeldb.recipient-proof.v1';
  instanceId: string;
  challengeId: string;
  proof: string;
}
export interface RecipientKeyPage {
  instanceId: string;
  revision: number;
  initialized: boolean;
  total: number;
  nextOffset: number | null;
  keys: RecipientKeyInfo[];
}
type Mutation = { instanceId: string; revision: number; confirm: true };
export type RecipientKeyCommand =
  | { action: 'registration.recipient.list'; instanceId: string; offset?: number; limit?: number }
  | (Mutation & { action: 'registration.recipient.initialize' })
  | (Mutation & { action: 'registration.recipient.begin'; userId: string; publicKey: string })
  | (Mutation & { action: 'registration.recipient.complete'; response: RecipientProof })
  | (Mutation & { action: 'registration.recipient.retire'; id: string });
export type RecipientKeyResult<T extends RecipientKeyCommand> = T extends {
  action: 'registration.recipient.list';
}
  ? RecipientKeyPage
  : T extends { action: 'registration.recipient.begin' }
    ? { revision: number; challenge: RecipientChallenge }
    : { revision: number };

/** Canonical OAEP label, shared by offline holder and server. Never stringify caller objects. */
export function recipientChallengeLabel(b: RecipientChallengeBinding): string {
  return JSON.stringify({
    format: b.format,
    instanceId: b.instanceId,
    userId: b.userId,
    challengeId: b.challengeId,
    keyVersion: b.keyVersion,
    previousKeyId: b.previousKeyId,
    fingerprint: b.fingerprint,
    createdAtUtc: b.createdAtUtc,
    expiresAtUtc: b.expiresAtUtc,
  });
}
