import { queryInterfaceAccessKeyDigest } from '@mode-db/shared';

export interface PublishedInterfacePolicyRelease {
  readonly version: string;
  readonly callableName: string;
  readonly interfaceContract: {
    readonly permissions?: {
      readonly mode?: string;
      readonly accessKeyDigest?: string;
      readonly rateLimit?: {
        readonly maxRequests?: number;
        readonly windowSeconds?: number;
      };
    };
  };
}

const interfaceRateWindows = new Map<string, { startedAt: number; count: number }>();

export function enforcePublishedInterfaceAccess(
  release: PublishedInterfacePolicyRelease,
  suppliedAccessKey: string | undefined,
): void {
  const policy = release.interfaceContract.permissions;
  if (!policy || policy.mode === 'none') {
    return;
  }
  if (policy.mode === 'disabled') {
    throw new Error('INTERFACE_ACCESS_DISABLED');
  }
  if (policy.mode !== 'key') {
    throw new Error('INTERFACE_ACCESS_DENIED');
  }
  if (!suppliedAccessKey) {
    throw new Error('INTERFACE_ACCESS_KEY_REQUIRED');
  }
  if (
    !policy.accessKeyDigest ||
    queryInterfaceAccessKeyDigest(suppliedAccessKey) !== policy.accessKeyDigest
  ) {
    throw new Error('INTERFACE_ACCESS_DENIED');
  }
}

export function enforcePublishedInterfaceRateLimit(
  atlas: string,
  interfaceKind: 'query' | 'operation' | 'bindingSurface',
  release: PublishedInterfacePolicyRelease,
): void {
  const policy = release.interfaceContract.permissions?.rateLimit;
  if (
    !policy ||
    !Number.isInteger(policy.maxRequests) ||
    !Number.isInteger(policy.windowSeconds) ||
    (policy.maxRequests ?? 0) < 1 ||
    (policy.windowSeconds ?? 0) < 1
  ) {
    return;
  }
  const now = Date.now();
  const windowMs = policy.windowSeconds! * 1_000;
  const key = `${interfaceKind}\u0000${atlas}\u0000${release.callableName}\u0000${release.version}`;
  const current = interfaceRateWindows.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    interfaceRateWindows.set(key, { startedAt: now, count: 1 });
    pruneExpiredRateWindows(now);
    return;
  }
  if (current.count >= policy.maxRequests!) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowMs - (now - current.startedAt)) / 1_000),
    );
    throw new Error(`INTERFACE_RATE_LIMITED:${retryAfterSeconds}`);
  }
  current.count += 1;
}

function pruneExpiredRateWindows(now: number): void {
  if (interfaceRateWindows.size <= 1_000) {
    return;
  }
  for (const [key, window] of interfaceRateWindows) {
    if (now - window.startedAt > 86_400_000) {
      interfaceRateWindows.delete(key);
    }
  }
}
