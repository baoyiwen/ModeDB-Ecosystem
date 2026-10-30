/** Strict OS-local registered identity maintenance. These requests are never HTTP credentials. */
import type { SecurityGrant } from '@mode-db/shared';
import { createPublicKey } from 'node:crypto';
import { decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import { normalizeRegistrationGrants } from './registration-ledger.js';
import { SecurityError } from './security-errors.js';

type Mutation = { instanceId: string; id: string; revision: number; confirm: true };
export type RegistrationMaintenanceRequest =
  | {
      action: 'registration.credentials.list';
      instanceId: string;
      offset: number;
      limit: number;
      userId?: string;
    }
  | { action: 'registration.users.list'; instanceId: string; offset: number; limit: number }
  | (Mutation & {
      action:
        | 'registration.credential.disable'
        | 'registration.credential.enable'
        | 'registration.credential.revoke'
        | 'registration.user.disable'
        | 'registration.user.enable';
    })
  | (Mutation & { action: 'registration.credential.restrict'; grants: SecurityGrant[] })
  | (Mutation & {
      action: 'registration.credential.replace';
      applicationId: string;
      grants: SecurityGrant[];
    });

const fields: Record<string, readonly string[]> = {
  'registration.credentials.list': ['offset', 'limit', 'userId'],
  'registration.users.list': ['offset', 'limit'],
  'registration.credential.disable': ['id', 'revision', 'confirm'],
  'registration.credential.enable': ['id', 'revision', 'confirm'],
  'registration.credential.revoke': ['id', 'revision', 'confirm'],
  'registration.user.disable': ['id', 'revision', 'confirm'],
  'registration.user.enable': ['id', 'revision', 'confirm'],
  'registration.credential.restrict': ['id', 'revision', 'confirm', 'grants'],
  'registration.credential.replace': ['id', 'revision', 'confirm', 'applicationId', 'grants'],
};
/** Compare key material, so alternate CBOR map ordering cannot disguise the same public key. */
export function sameRegistrationPublicKey(first: string, second: string): boolean {
  const canonical = (encoded: string): Buffer => {
    const key = decodeCredentialPublicKey(Buffer.from(encoded, 'base64url')) as unknown as Map<
      number,
      unknown
    >;
    const component = (field: number, integer = false): string => {
      const value = key.get(field);
      requireValue(value instanceof Uint8Array && value.length > 0);
      let bytes = Buffer.from(value);
      if (integer) {
        while (bytes.length > 1 && bytes[0] === 0) {
          bytes = bytes.subarray(1);
        }
      }
      return bytes.toString('base64url');
    };
    const type = key.get(1);
    requireValue(type === 2 || type === 3);
    if (type === 2) {
      requireValue(key.get(-1) === 1);
    }
    return createPublicKey({
      key:
        type === 2
          ? { kty: 'EC', crv: 'P-256', x: component(-2), y: component(-3) }
          : { kty: 'RSA', n: component(-1, true), e: component(-2, true) },
      format: 'jwk',
    }).export({ type: 'spki', format: 'der' });
  };
  try {
    return canonical(first).equals(canonical(second));
  } catch {
    throw new SecurityError('SECURITY_FORBIDDEN');
  }
}

function requireValue(value: unknown): asserts value {
  if (!value) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
}
function uuid(value: unknown): string {
  requireValue(
    typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(value)?.[0] ===
        value,
  );
  return value;
}
export function isRegistrationMaintenance(input: unknown): boolean {
  const action =
    input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  return (
    typeof action === 'string' &&
    (action.startsWith('registration.credential') || action.startsWith('registration.user'))
  );
}
export function parseRegistrationMaintenance(input: unknown): RegistrationMaintenanceRequest {
  requireValue(input && typeof input === 'object' && !Array.isArray(input));
  const r = input as Record<string, unknown>;
  requireValue(typeof r.action === 'string' && Object.hasOwn(fields, r.action));
  requireValue(
    Object.keys(r).every((k) =>
      ['action', 'instanceId', ...fields[r.action as string]!].includes(k),
    ),
  );
  const action = r.action as RegistrationMaintenanceRequest['action'],
    instanceId = uuid(r.instanceId);
  if (action === 'registration.credentials.list' || action === 'registration.users.list') {
    const offset = r.offset ?? 0,
      limit = r.limit ?? 25;
    requireValue(
      Number.isSafeInteger(offset) && (offset as number) >= 0 && (offset as number) <= 10000,
    );
    requireValue(Number.isSafeInteger(limit) && (limit as number) >= 1 && (limit as number) <= 100);
    return {
      action,
      instanceId,
      offset: offset as number,
      limit: limit as number,
      ...(action === 'registration.credentials.list' && r.userId !== undefined
        ? { userId: uuid(r.userId) }
        : {}),
    };
  }
  const id = uuid(r.id);
  requireValue(Number.isSafeInteger(r.revision) && (r.revision as number) >= 0);
  if (r.confirm !== true) {
    throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
  }
  const base = { instanceId, id, revision: r.revision as number, confirm: true as const };
  if (
    action === 'registration.credential.restrict' ||
    action === 'registration.credential.replace'
  ) {
    let grants: SecurityGrant[];
    try {
      grants = normalizeRegistrationGrants(r.grants);
    } catch {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    return action === 'registration.credential.replace'
      ? { ...base, action, grants, applicationId: uuid(r.applicationId) }
      : { ...base, action, grants };
  }
  return { ...base, action };
}
