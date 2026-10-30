import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEVICE_AUTHENTICATION_API_V1 as API,
  DeviceAuthenticationContractError,
  type DeviceAuthenticationErrorCode,
} from '@mode-db/shared';
import { checkNetworkRequest } from './network-boundary.js';
import type { SecurityNetworkPolicy } from './network-policy.js';
import { networkAddress } from './network-policy.js';
import type { SecurityProtection } from './security-protection.js';
import type { AuthenticationService } from './authentication-service.js';
import type { RegistrationRequestContext as AuthenticationRequestContext } from './registration-service.js';
import type { SecurityRegistry } from './security-registry.js';
import { cookieHeader, cookies, sessionCookieName } from './browser-session-http.js';

export function authenticationPath(url: string): boolean {
  return Object.values(API).includes(url.split('?')[0] as typeof API.capabilities);
}
function failure(error: unknown): { code: DeviceAuthenticationErrorCode; status: number } {
  if (!(error instanceof DeviceAuthenticationContractError)) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (/STORE|AUDIT|CLOSED/.test(code)) {
      return { code: 'SECURITY_AUTHENTICATION_CAPACITY', status: 503 };
    }
    if (/RATE_LIMITED|TEMPORARILY_BANNED/.test(code)) {
      return { code: 'SECURITY_AUTHENTICATION_RATE_LIMITED', status: 429 };
    }
    if (/SOURCE|ORIGIN|TRANSPORT|PROXY|TLS/.test(code)) {
      return { code: 'SECURITY_AUTHENTICATION_ORIGIN_DENIED', status: 403 };
    }
    return { code: 'SECURITY_AUTHENTICATION_SCHEMA_INVALID', status: 400 };
  }
  const code = error.code;
  const status = code.endsWith('NOT_FOUND')
    ? 404
    : code.endsWith('RATE_LIMITED')
      ? 429
      : code.endsWith('CAPACITY')
        ? 503
        : code.endsWith('SCHEMA_INVALID')
          ? 400
          : /CHALLENGE_REPLAYED|CONFLICT/.test(code)
            ? 409
            : /EXPIRED/.test(code)
              ? 410
              : /CHALLENGE_INVALID|PROOF_INVALID/.test(code)
                ? 401
                : code.endsWith('UNSUPPORTED')
                  ? 501
                  : 403;
  return { code, status };
}

/** Anonymous same-origin login admission. Only a verified durable commit issues a session. */
export async function installAuthenticationRoutes(
  app: FastifyInstance,
  service: AuthenticationService,
  network: SecurityNetworkPolicy,
  registry: SecurityRegistry,
  protection?: SecurityProtection,
): Promise<void> {
  await app.register(async (scope) => {
    const contexts = new WeakMap<FastifyRequest, AuthenticationRequestContext>();
    const respond = async (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
      let result = failure(error);
      const context = contexts.get(request);
      if (context) {
        try {
          await service.deny(context, result.code);
        } catch {
          result = { code: 'SECURITY_AUTHENTICATION_CAPACITY', status: 503 };
        }
      }
      if (result.status === 429 || result.status === 503) {
        reply.header('retry-after', 60);
      }
      return reply.code(result.status).send({
        requestId: context?.requestId ?? randomUUID(),
        error: result.code,
        ...([429, 503].includes(result.status) ? { retryAfterSeconds: 60 } : {}),
      });
    };
    scope.addHook('onRequest', async (request, reply) => {
      try {
        const recheck = () => {
          const source = checkNetworkRequest(request, network);
          const d = service.descriptor;
          if (request.url.includes('?')) {
            throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_SCHEMA_INVALID');
          }
          if (d) {
            const origin = request.headers.origin,
              site = request.headers['sec-fetch-site'];
            if (
              !source.secure ||
              request.headers.host !== new URL(d.serverOrigin).host ||
              (origin !== undefined && origin !== d.serverOrigin) ||
              (request.method === 'POST' &&
                (origin !== d.serverOrigin || site !== 'same-origin')) ||
              (request.method !== 'POST' &&
                site !== undefined &&
                !['same-origin', 'none'].includes(String(site)))
            ) {
              throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_ORIGIN_DENIED');
            }
          }
          if (
            request.method === 'POST' &&
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
              request.headers['content-type'] ?? '',
            )
          ) {
            throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_SCHEMA_INVALID');
          }
          return source;
        };
        const socket = request.raw.socket;
        let source;
        try {
          source = network.source(
            socket.remoteAddress ?? '',
            request.headers,
            'encrypted' in socket && socket.encrypted === true,
          );
        } catch {
          const peerIp = networkAddress(socket.remoteAddress ?? '');
          source = { peerIp, clientIp: peerIp, clientIpBasis: 'socket' as const, secure: false };
        }
        const context = {
          source,
          requestId: randomUUID(),
          recheck: () => {
            recheck();
          },
        };
        contexts.set(request, context);
        protection?.consume(source, 'data');
        const action = (Object.keys(API) as Array<keyof typeof API>).find(
          (key) => API[key] === request.url.split('?')[0],
        );
        if (!action) {
          throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_UNSUPPORTED');
        }
        service.admit(action, source);
        recheck();
        if (request.method === 'OPTIONS') {
          throw new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_UNSUPPORTED');
        }
      } catch (error) {
        return respond(request, reply, error);
      }
    });
    scope.addHook('onSend', async (_request, reply, payload) => {
      for (const key of [
        'access-control-allow-origin',
        'access-control-allow-credentials',
        'access-control-allow-headers',
        'access-control-allow-methods',
      ]) {
        reply.removeHeader(key);
      }
      reply
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer');
      return payload;
    });
    scope.setErrorHandler((error, request, reply) => respond(request, reply, error));
    for (const [action, url] of Object.entries(API) as Array<[keyof typeof API, string]>) {
      scope.route({
        method: action === 'capabilities' ? 'GET' : 'POST',
        url,
        config: { cors: false },
        bodyLimit: 65536,
        exposeHeadRoute: false,
        handler: async (request, reply) => {
          try {
            const context = contexts.get(request)!;
            if (action === 'capabilities') {
              return service.capabilities();
            }
            const nonceName = (id: string) =>
              sessionCookieName(request, true).replace('mdbs_session_', 'mdbs_login_') +
              '_' +
              createHash('sha256').update(id).digest('hex').slice(0, 16);
            if (action === 'begin') {
              const result = await service.begin(request.body, context);
              return reply
                .code(201)
                .header(
                  'set-cookie',
                  cookieHeader(
                    nonceName(result.response.challengeId),
                    result.ceremonySecret,
                    60,
                    true,
                  ),
                )
                .send(result.response);
            }
            const result = await service.complete(
              request.body,
              cookies(request)[
                nonceName(String((request.body as { challengeId?: unknown })?.challengeId ?? ''))
              ],
              context,
            );
            const verified = registry.verifyBrowserSession(
              result.session,
              service.descriptor!.serverOrigin,
            );
            return reply
              .header('set-cookie', [
                cookieHeader(sessionCookieName(request, true), result.session, 1800, true),
                cookieHeader(
                  nonceName(String((request.body as { challengeId: string }).challengeId)),
                  '',
                  0,
                  true,
                ),
              ])
              .send({
                version: 1,
                expiresAt: verified.sessionExpiresAt,
                absoluteExpiresAt: verified.absoluteExpiresAt,
                csrf: verified.csrf,
                actor: verified.actor,
                policyVersion: verified.policyVersion,
                securityAdmin: false,
                requestId: context.requestId,
              });
          } catch (error) {
            return respond(request, reply, error);
          }
        },
      });
      scope.route({
        method: 'OPTIONS',
        url,
        config: { cors: false },
        handler: async (request, reply) =>
          respond(
            request,
            reply,
            new DeviceAuthenticationContractError('SECURITY_AUTHENTICATION_UNSUPPORTED'),
          ),
      });
    }
    scope.addHook('onClose', async () => {
      service.close();
    });
  });
}
