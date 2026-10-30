import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEVICE_REGISTRATION_API_V1 as API,
  DEVICE_REGISTRATION_FORMAT,
  DeviceRegistrationContractError,
  type DeviceRegistrationErrorCode,
} from '@mode-db/shared';
import { checkNetworkRequest } from './network-boundary.js';
import type { SecurityNetworkPolicy } from './network-policy.js';
import { networkAddress } from './network-policy.js';
import type { SecurityProtection } from './security-protection.js';
import type { RegistrationService } from './registration-service.js';
import { type RegistrationRequestContext } from './registration-service.js';

export function registrationPath(url: string): boolean {
  return Object.values(API).includes(url.split('?')[0] as typeof API.capabilities);
}
function failure(error: unknown): { code: DeviceRegistrationErrorCode; status: number } {
  if (!(error instanceof DeviceRegistrationContractError)) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (/STORE|AUDIT|CLOSED/.test(code)) {
      return { code: 'SECURITY_REGISTRATION_CAPACITY', status: 503 };
    }
    if (/RATE_LIMITED|TEMPORARILY_BANNED/.test(code)) {
      return { code: 'SECURITY_REGISTRATION_RATE_LIMITED', status: 429 };
    }
    if (/SOURCE|ORIGIN|TRANSPORT|PROXY|TLS/.test(code)) {
      return { code: 'SECURITY_REGISTRATION_ORIGIN_MISMATCH', status: 403 };
    }
    return { code: 'SECURITY_REGISTRATION_SCHEMA_INVALID', status: 400 };
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

/** Separate same-origin admission boundary. All methods stay anonymous and grant no session. */
export async function installRegistrationRoutes(
  app: FastifyInstance,
  service: RegistrationService,
  network: SecurityNetworkPolicy,
  protection?: SecurityProtection,
): Promise<void> {
  await app.register(async (scope) => {
    const contexts = new WeakMap<FastifyRequest, RegistrationRequestContext>();
    const respond = async (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
      let result = failure(error);
      const context = contexts.get(request);
      if (context) {
        try {
          await service.deny(context, result.code);
        } catch {
          result = { code: 'SECURITY_REGISTRATION_CAPACITY', status: 503 };
        }
      }
      if (result.status === 429 || result.status === 503) {
        reply.header('retry-after', 60);
      }
      return reply.code(result.status).send({
        format: DEVICE_REGISTRATION_FORMAT,
        version: 1,
        requestId: context?.requestId ?? randomUUID(),
        code: result.code,
        ...([429, 503].includes(result.status) ? { retryAfterSeconds: 60 } : {}),
      });
    };
    scope.addHook('onRequest', async (request, reply) => {
      try {
        const recheck = () => {
          const source = checkNetworkRequest(request, network);
          const d = service.descriptor;
          if (request.url.includes('?')) {
            throw new DeviceRegistrationContractError('SECURITY_REGISTRATION_SCHEMA_INVALID');
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
              throw new DeviceRegistrationContractError('SECURITY_REGISTRATION_ORIGIN_MISMATCH');
            }
          }
          if (
            request.method === 'POST' &&
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
              request.headers['content-type'] ?? '',
            )
          ) {
            throw new DeviceRegistrationContractError('SECURITY_REGISTRATION_SCHEMA_INVALID');
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
          throw new DeviceRegistrationContractError('SECURITY_REGISTRATION_UNSUPPORTED');
        }
        service.admit(action, source);
        recheck();
        if (request.method === 'OPTIONS') {
          throw new DeviceRegistrationContractError('SECURITY_REGISTRATION_UNSUPPORTED');
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
        'set-cookie',
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
        method: action === 'capabilities' || action === 'descriptor' ? 'GET' : 'POST',
        url,
        config: { cors: false },
        bodyLimit: 131072,
        exposeHeadRoute: false,
        handler: async (request, reply) => {
          try {
            const context = contexts.get(request)!;
            if (action === 'capabilities') {
              const result = service.capabilities();
              service.observe(action, context);
              return result;
            }
            if (action === 'descriptor') {
              const result = service.connection();
              service.observe(action, context);
              return reply
                .header('content-disposition', 'attachment; filename="modeldb-connection.json"')
                .send(result);
            }
            if (action === 'begin') {
              return reply.code(201).send(await service.begin(request.body, context));
            }
            if (action === 'complete') {
              return reply.code(202).send(await service.complete(request.body, context));
            }
            return service.status(request.body, context);
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
            new DeviceRegistrationContractError('SECURITY_REGISTRATION_UNSUPPORTED'),
          ),
      });
    }
    scope.addHook('onClose', async () => {
      service.close();
    });
  });
}
