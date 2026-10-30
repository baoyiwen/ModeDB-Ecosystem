/** OS-local maintenance schema. No HTTP route or client-asserted operator identity. */
import type { SecurityGrant } from '@mode-db/shared';
import { normalizeRegistrationGrants } from './registration-ledger.js';
import { SecurityError } from './security-errors.js';

export type RegistrationApprovalRequest =
  | { action: 'registration.list'; instanceId: string; offset: number; limit: number }
  | {
      action: 'registration.approve';
      instanceId: string;
      id: string;
      revision: number;
      confirm: true;
      principalId?: string;
      name?: string;
      grants: SecurityGrant[];
    }
  | {
      action: 'registration.reject';
      instanceId: string;
      id: string;
      revision: number;
      confirm: true;
    };

function requireValue(value: unknown): asserts value {
  if (!value) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
}
function text(value: unknown, pattern: RegExp): string {
  requireValue(typeof value === 'string' && pattern.exec(value)?.[0] === value);
  return value;
}
export function parseRegistrationApprovalRequest(input: unknown): RegistrationApprovalRequest {
  requireValue(input && typeof input === 'object' && !Array.isArray(input));
  const r = input as Record<string, unknown>;
  const fields: Record<string, readonly string[]> = {
    'registration.list': ['instanceId', 'offset', 'limit'],
    'registration.approve': [
      'instanceId',
      'id',
      'revision',
      'confirm',
      'principalId',
      'name',
      'grants',
    ],
    'registration.reject': ['instanceId', 'id', 'revision', 'confirm'],
  };
  requireValue(typeof r.action === 'string' && Object.hasOwn(fields, r.action));
  requireValue(
    Object.keys(r).every((k) => k === 'action' || fields[r.action as string]!.includes(k)),
  );
  const instanceId = text(
    r.instanceId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  if (r.action === 'registration.list') {
    const offset = r.offset ?? 0,
      limit = r.limit ?? 25;
    requireValue(
      Number.isSafeInteger(offset) && (offset as number) >= 0 && (offset as number) <= 11000,
    );
    requireValue(Number.isSafeInteger(limit) && (limit as number) >= 1 && (limit as number) <= 100);
    return { action: r.action, instanceId, offset: offset as number, limit: limit as number };
  }
  const id = text(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  requireValue(Number.isSafeInteger(r.revision) && (r.revision as number) >= 0);
  if (r.confirm !== true) {
    throw new SecurityError('SECURITY_CONFIRMATION_REQUIRED');
  }
  const base = { instanceId, id, revision: r.revision as number, confirm: true as const };
  if (r.action === 'registration.reject') {
    return { action: r.action, ...base };
  }
  requireValue((r.principalId === undefined) !== (r.name === undefined));
  const principalId =
    r.principalId === undefined ? undefined : text(r.principalId, /^[A-Za-z0-9_-]{1,96}$/);
  const name = r.name === undefined ? undefined : text(r.name, /^[^\u0000-\u001f\u007f]{1,80}$/);
  requireValue(name === undefined || name === name.trim());
  let grants: SecurityGrant[];
  try {
    grants = normalizeRegistrationGrants(r.grants);
  } catch {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  return { action: 'registration.approve', ...base, principalId, name, grants };
}
