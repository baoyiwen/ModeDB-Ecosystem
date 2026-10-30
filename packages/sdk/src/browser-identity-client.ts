import type { DeviceRegistrationConnectionDescriptorV1 } from '@mode-db/shared';
import {
  getBrowserPublicKeyContext,
  getBrowserRegistrationDescriptor,
  parseBrowserRegistrationDescriptor,
  registerBrowserCredential,
  type BrowserPublicKeyContext,
  type BrowserRegistration,
  type BrowserRegistrationConfig,
} from './browser-registration.js';
import {
  getBrowserSession,
  loginBrowserSession,
  logoutBrowserSession,
  type BrowserPublicKeyLoginConfig,
} from './browser-session.js';
import { ConnectionSecurityError } from './connection-security.js';

export type BrowserIdentityClientConfig = BrowserRegistrationConfig & BrowserPublicKeyLoginConfig;

/** One view lifecycle, one operation at a time. dispose aborts local work, never logs out. */
export function createBrowserIdentityClient(input: BrowserIdentityClientConfig) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal?.aborted) {
    abort();
  } else {
    input.signal?.addEventListener('abort', abort, { once: true });
  }
  const config = { ...input, signal: controller.signal };
  let busy = false;
  let context: BrowserPublicKeyContext | undefined;
  let imported: DeviceRegistrationConnectionDescriptorV1 | undefined;
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted();
    if (busy) {
      throw new ConnectionSecurityError('SECURITY_IDENTITY_BUSY', 409);
    }
    busy = true;
    try {
      const value = await action();
      controller.signal.throwIfAborted();
      return value;
    } finally {
      busy = false;
    }
  };
  const discover = async () => {
    const value = await getBrowserPublicKeyContext(config);
    controller.signal.throwIfAborted();
    if (
      context &&
      (context.binding.instanceId !== value.binding.instanceId ||
        context.binding.deploymentDescriptorSha256 !== value.binding.deploymentDescriptorSha256)
    ) {
      throw new ConnectionSecurityError('SECURITY_AUTHENTICATION_DEPLOYMENT_MISMATCH', 409);
    }
    context = Object.freeze({ ...value, binding: Object.freeze({ ...value.binding }) });
    return context;
  };
  const current = async () => context ?? discover();
  const liveDescriptor = async () => getBrowserRegistrationDescriptor(config, await current());
  return Object.freeze({
    load: () => run(discover),
    descriptor: () => run(liveDescriptor),
    importDescriptor: (text: string) =>
      run(async () => {
        imported = undefined;
        const value = parseBrowserRegistrationDescriptor(text, await liveDescriptor());
        controller.signal.throwIfAborted();
        // Do not expose a mutable reference to the binding used by future registration.
        imported = structuredClone(value);
        return value;
      }),
    register: (displayName: string): Promise<BrowserRegistration> =>
      run(async () => {
        const ctx = await current();
        const result = await registerBrowserCredential(
          config,
          ctx,
          imported ?? (await liveDescriptor()),
          displayName,
        );
        return Object.freeze({
          initialStatus: result.initialStatus,
          status: () => run(() => result.status()),
        });
      }),
    login: () => run(async () => loginBrowserSession(config, (await discover()).binding)),
    session: () => run(() => getBrowserSession(config)),
    logout: () => run(() => logoutBrowserSession(config)),
    dispose() {
      controller.abort();
      input.signal?.removeEventListener('abort', abort);
      context = undefined;
      imported = undefined;
    },
  });
}
export type BrowserIdentityClient = ReturnType<typeof createBrowserIdentityClient>;

/** Stable UI categories only; never surface response bodies or credential material. */
export function browserIdentityIssue(error: unknown): string {
  const e = error as { name?: string; code?: string };
  if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') {
    return 'cancelled';
  }
  if (e?.name === 'NotSupportedError' || e?.name === 'SecurityError') {
    return 'unsupported';
  }
  const code = e?.code ?? '';
  if (/^SECURITY_CREDENTIAL_(INVALID|EXPIRED)$/.test(code)) {
    return 'sessionExpired';
  }
  if (/RATE_LIMITED|CAPACITY|IDENTITY_BUSY/.test(code)) {
    return 'limited';
  }
  if (/EXPIRED/.test(code)) {
    return 'expired';
  }
  if (/REJECTED/.test(code)) {
    return 'rejected';
  }
  if (/CREDENTIAL_(DISABLED|REVOKED)|AUTHENTICATION_(PROOF_INVALID|USER_DISABLED)/.test(code)) {
    return 'identity';
  }
  if (/MISMATCH|SCHEMA_INVALID/.test(code)) {
    return 'descriptor';
  }
  if (/DISABLED/.test(code)) {
    return 'closed';
  }
  return 'unavailable';
}
