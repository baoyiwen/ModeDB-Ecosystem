import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SecurityNetworkPolicy, NetworkSource } from './network-policy.js';
import { SecurityError } from './security-errors.js';
import { networkAddress } from './network-policy.js';
import type { SecurityProtection } from './security-protection.js';
import { DEVICE_REGISTRATION_API_V1, DEVICE_AUTHENTICATION_API_V1 } from '@mode-db/shared';

const registrationPath = (url: string) =>
  [
    ...Object.values(DEVICE_REGISTRATION_API_V1),
    ...Object.values(DEVICE_AUTHENTICATION_API_V1),
  ].some((path) => path === url.split('?')[0]);

export function requestPlane(request: Pick<FastifyRequest, 'url'>): 'data' | 'management' {
  const path = request.url.split('?')[0] ?? '';
  // Session lifecycle is authentication for data clients; admin routes retain the management policy.
  if (
    [
      '/api/v1/security/session',
      '/api/v1/security/session/refresh',
      '/api/v1/security/session/logout',
    ].includes(path)
  ) {
    return 'data';
  }
  return path.startsWith('/api/v1/management/') ||
    (path.startsWith('/api/v1/security/') && path !== '/api/v1/security/context')
    ? 'management'
    : 'data';
}

/** Re-evaluate the original socket/proxy evidence without Fastify's untrusted proxy shortcuts. */
export function checkNetworkRequest(
  request: FastifyRequest,
  policy: SecurityNetworkPolicy,
): NetworkSource {
  const socket = request.raw.socket;
  const source = policy.source(
    socket.remoteAddress ?? '',
    request.headers,
    'encrypted' in socket && socket.encrypted === true,
  );
  const query = new URL(request.url, 'http://local.invalid').searchParams;
  if (['token', 'connectToken', 'access_token', 'session'].some((key) => query.has(key))) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  policy.check(source, requestPlane(request), request.headers.origin);
  return source;
}

/** Run before CORS and body parsing so a rejected Origin cannot still perform a write. */
export function installSecurityNetworkBoundary(
  app: FastifyInstance,
  policy: SecurityNetworkPolicy,
  protection?: SecurityProtection,
): void {
  const sources = new WeakMap<FastifyRequest, NetworkSource>();
  app.addHook('onRequest', async (request, reply) => {
    // These exact routes install their own network gate before parsing, with protocol error bodies.
    if (registrationPath(request.url)) {
      return;
    }
    try {
      const socket = request.raw.socket;
      const source = policy.source(
        socket.remoteAddress ?? '',
        request.headers,
        'encrypted' in socket && socket.encrypted === true,
      );
      sources.set(request, source);
      checkNetworkRequest(request, policy);
      protection?.consume(source, requestPlane(request));
    } catch (error) {
      const requestId = randomUUID();
      let source = sources.get(request);
      // A rejected proxy chain is attributed only to the normalized socket peer.
      try {
        if (!source) {
          const peerIp = networkAddress(request.raw.socket.remoteAddress ?? '');
          source = { peerIp, clientIp: peerIp, clientIpBasis: 'socket', secure: false };
        }
        if (source) {
          protection?.event(
            'network.reject',
            'denied',
            source,
            error instanceof SecurityError ? error.code : 'SECURITY_SOURCE_DENIED',
            undefined,
            undefined,
            requestPlane(request),
            'http',
            requestId,
          );
        }
      } catch (auditError) {
        error = auditError;
      }
      const code = error instanceof SecurityError ? error.code : 'SECURITY_SOURCE_DENIED';
      const limited = code === 'SECURITY_RATE_LIMITED' || code === 'SECURITY_TEMPORARILY_BANNED';
      if (limited) {
        reply.header('retry-after', protection?.retryAfter(source, requestPlane(request)) ?? 60);
      }
      return reply
        .code(
          limited
            ? 429
            : code === 'SECURITY_INVALID_REQUEST'
              ? 400
              : /STORE|AUDIT|CLOSED/.test(code)
                ? 503
                : 403,
        )
        .send({
          error: code,
          requestId,
        });
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (registrationPath(request.url)) {
      return payload;
    }
    const source = sources.get(request);
    if (source && reply.statusCode === 401 && protection) {
      try {
        protection.event(
          'authentication.reject',
          'denied',
          source,
          'SECURITY_CREDENTIAL_INVALID',
          undefined,
          undefined,
          requestPlane(request),
        );
        protection.authenticationFailed(source, requestPlane(request));
      } catch (error) {
        reply.code(503).header('content-type', 'application/json');
        return JSON.stringify({
          error: error instanceof SecurityError ? error.code : 'SECURITY_STORE_WRITE_FAILED',
        });
      }
    }
    return payload;
  });
}
