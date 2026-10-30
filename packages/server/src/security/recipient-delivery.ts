import type { RecipientKeyInfo } from '@mode-db/shared';
import { SecurityError } from './security-errors.js';

/** Explicit administrator selection; never inferred from a display name or supplied PEM. */
export interface RecipientDeliverySelection {
  instanceId: string;
  revision: number;
  id: string;
  userId: string;
  keyVersion: number;
  fingerprint: string;
  confirm: true;
}
export type RecipientDeliveryInfo = Pick<
  RecipientKeyInfo,
  'id' | 'userId' | 'keyVersion' | 'fingerprint'
>;
export const recipientDeliveryOptions = [
  '--recipient-id',
  '--recipient-user',
  '--recipient-version',
  '--recipient-fingerprint',
  '--revision',
] as const;
export function parseRecipientDelivery(value: unknown): RecipientDeliverySelection {
  const fields = ['instanceId', 'revision', 'id', 'userId', 'keyVersion', 'fingerprint', 'confirm'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const r = value as RecipientDeliverySelection;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (
    Object.keys(r).length !== fields.length ||
    Object.keys(r).some((k) => !fields.includes(k)) ||
    typeof r.instanceId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,96}$/.test(r.instanceId) ||
    typeof r.id !== 'string' ||
    !uuid.test(r.id) ||
    typeof r.userId !== 'string' ||
    !uuid.test(r.userId) ||
    typeof r.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.fingerprint) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    !Number.isSafeInteger(r.keyVersion) ||
    r.keyVersion < 1 ||
    r.keyVersion > 20 ||
    r.id.endsWith('\n') ||
    r.userId.endsWith('\n') ||
    r.fingerprint.endsWith('\n') ||
    r.instanceId.endsWith('\n')
  ) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  if (r.confirm !== true) {
    throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
  }
  return structuredClone(r);
}

/** A raw-key legacy export and an approved-recipient export cannot silently fall back. */
export function recipientDeliverySelection(
  options: ReadonlyMap<string, string>,
  instanceId: string,
  confirm: boolean,
): RecipientDeliverySelection | undefined {
  if (!recipientDeliveryOptions.some((name) => options.has(name))) {
    return undefined;
  }
  if (options.has('--public-key')) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const integer = (name: string) => {
    const text = options.get(name);
    if (!text || !/^[1-9][0-9]{0,15}$/.test(text)) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    return Number(text);
  };
  return parseRecipientDelivery({
    instanceId,
    revision: integer('--revision'),
    id: options.get('--recipient-id'),
    userId: options.get('--recipient-user'),
    keyVersion: integer('--recipient-version'),
    fingerprint: options.get('--recipient-fingerprint'),
    confirm,
  });
}
