import type { VaultKeyProvider } from '@mode-db/common';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import {
  isDatabaseOperation,
  isEngineOperation,
  queryInterfaceErrorDetailFromMessage,
  type ManagementCatalogResponse,
  type ManagementDatabaseInfo,
  type SecurityActor,
  type SecurityAuditQuery,
  type WireExecuteBody,
  type WireExecuteResultJson,
} from '@mode-db/shared';
import type { AuthoringEngine } from '@mode-db/core';
import type { WireRequestDispatcher } from '../request-dispatcher.js';
import type { WriteSerializationGate } from '../write-serialization-gate.js';
import {
  createDatabaseBackup,
  listDatabaseBackups,
  normalizeBackupName,
  readDatabaseBackupFile,
  importDatabaseBackup,
} from '../backup-manager.js';
import { AuthorizationService } from './authorization-service.js';
import { SecurityError } from './security-errors.js';
import type { SecurityRegistry } from './security-registry.js';
import type { NetworkSource, SecurityNetworkPolicy } from './network-policy.js';
import { checkNetworkRequest, requestPlane } from './network-boundary.js';
import {
  dispatchSecurityControl,
  requireRecentSecurityPairing,
  type SecurityControl,
} from './security-control.js';
import {
  browserOrigin,
  cookieHeader,
  sessionCookie,
  sessionCookieName,
  csrfHeader,
  unsafeMethod,
} from './browser-session-http.js';
import { authenticationPath } from './authentication-routes.js';
import { registrationPath } from './registration-routes.js';

const NAME = /^[a-zA-Z0-9_-]{1,96}$/;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  return value;
}
function auditQuery(raw: Record<string, unknown>): SecurityAuditQuery {
  const allowed = new Set([
    'fromUtc',
    'toUtc',
    'category',
    'action',
    'result',
    'principalId',
    'credentialId',
    'database',
    'requestId',
    'clientIp',
    'offset',
    'limit',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  const text = (key: string): string | undefined => {
    if (!(key in raw)) {
      return undefined;
    }
    const value = raw[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    return value;
  };
  const integer = (key: string): number | undefined => {
    const value = text(key);
    if (value === undefined) {
      return undefined;
    }
    if (!/^-?(?:0|[1-9]\d*)$/.test(value)) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new SecurityError('SECURITY_INVALID_REQUEST');
    }
    return parsed;
  };
  return {
    fromUtc: text('fromUtc'),
    toUtc: text('toUtc'),
    category: text('category') as SecurityAuditQuery['category'],
    action: text('action'),
    result: text('result') as SecurityAuditQuery['result'],
    principalId: text('principalId'),
    credentialId: text('credentialId'),
    database: text('database'),
    requestId: text('requestId'),
    clientIp: text('clientIp'),
    offset: integer('offset'),
    limit: integer('limit'),
  };
}
function operation(value: unknown): WireExecuteBody {
  if (!isEngineOperation(value) || !isDatabaseOperation(value)) {
    throw new SecurityError('SECURITY_INVALID_REQUEST');
  }
  return value;
}
function bearer(request: FastifyRequest, registry: SecurityRegistry, secure: boolean): string {
  if (request.headers['x-modeldb-connect-token'] !== undefined) {
    throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
  }
  const value = request.headers.authorization;
  if (value !== undefined) {
    if (typeof value !== 'string' || !/^Bearer mdbt_v1_\S+$/.test(value)) {
      throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
    }
    return value.slice(7);
  }
  const session = sessionCookie(request, secure);
  if (session) {
    registry.verifyBrowserSession(
      session,
      browserOrigin(request, secure),
      unsafeMethod(request.method) ? csrfHeader(request) : undefined,
    );
    return session;
  }
  throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
}
function isSession(value: string): boolean {
  return value.startsWith('mdbs_v1_');
}
function failure(error: unknown, requestId: string): { status: number; body: unknown } {
  if (error instanceof SecurityError) {
    const status =
      error.code === 'SECURITY_NOT_FOUND'
        ? 404
        : /RATE_LIMITED|TEMPORARILY_BANNED/.test(error.code)
          ? 429
          : /POLICY_CONFLICT/.test(error.code)
            ? 409
            : /CREDENTIAL/.test(error.code)
              ? 401
              : error.code === 'SECURITY_PROTOCOL_UNSUPPORTED'
                ? 426
                : /FORBIDDEN|LOCAL_IDENTITY_DENIED|REAUTH_REQUIRED|RELEASE_SCOPE_CHANGED|SOURCE_DENIED|ORIGIN_DENIED|TLS_REQUIRED|PROXY_UNTRUSTED|CSRF_REQUIRED/.test(
                      error.code,
                    )
                  ? 403
                  : error.code === 'SECURITY_INVALID_REQUEST' ||
                      error.code === 'SECURITY_CONFIRMATION_REQUIRED'
                    ? 400
                    : 503;
    return { status, body: { error: error.code, requestId } };
  }
  const detail = queryInterfaceErrorDetailFromMessage(error instanceof Error ? error.message : '');
  if (error instanceof Error && error.message.includes('VAULT_LEGACY_FORMAT')) {
    return { status: 409, body: { error: 'VAULT_LEGACY_FORMAT', requestId } };
  }
  return {
    status: detail ? 400 : 500,
    body: {
      error: detail?.code ?? 'SECURITY_OPERATION_FAILED',
      requestId,
      ...(detail
        ? {
            errorDetail: {
              code: detail.code,
              message: detail.code,
              category: detail.category,
              retryable: detail.retryable,
            },
          }
        : {}),
    },
  };
}
function sendFailure(
  reply: FastifyReply,
  error: unknown,
  requestId: string,
  retryAfter = 60,
): unknown {
  const failed = failure(error, requestId);
  if (failed.status === 429) {
    reply.header('retry-after', retryAfter);
  }
  return reply.code(failed.status).send(failed.body);
}

/** Registry-only network boundary. Legacy handlers are never entered in this mode. */
export function installRegistryEntrypoints(input: {
  app: FastifyInstance;
  registry: SecurityRegistry;
  network?: SecurityNetworkPolicy;
  securityControl?: SecurityControl;
  /** Omitted preserves the existing standalone frontend deployment. */
  listenerRole?: 'data' | 'management';
  publicAssetPaths?: ReadonlySet<string>;
  dispatcher: WireRequestDispatcher;
  designerWorkspace: string;
  workspace: string;
  backupKeys?: VaultKeyProvider;
  writeGate: WriteSerializationGate;
  getEngine: (database: string) => Promise<AuthoringEngine>;
  listDatabases: () => readonly ManagementDatabaseInfo[];
  catalog: (database: string) => Promise<ManagementCatalogResponse>;
  manage?: {
    create: (database: string) => Promise<unknown>;
    drop: (database: string) => Promise<unknown>;
    clear: (database: string) => Promise<unknown>;
    restore: (database: string, fileName: string) => Promise<unknown>;
  };
}): void {
  const { app, registry } = input;
  const databaseSockets = new Map<WebSocket, string>();
  const secureCookies = input.network?.mode === 'tls' || input.network?.mode === 'proxy';
  const checkBrowserRole = (verified: ReturnType<SecurityRegistry['verifyBrowserSession']>) => {
    if (
      (input.listenerRole === 'management' && !verified.securityAdmin) ||
      (input.listenerRole === 'data' && verified.securityAdmin)
    ) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
    if (
      input.listenerRole === 'management' &&
      Date.parse(verified.absoluteExpiresAt) >
        Date.parse(verified.credential.createdAt) + 60 * 60000
    ) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
  };
  const access = (request: FastifyRequest): string => {
    const token = bearer(request, registry, secureCookies);
    const source = guard(request);
    if (source) {
      input.securityControl?.protection.consume(
        source,
        requestPlane(request),
        verify(token).actor.principalId,
      );
    }
    return token;
  };
  const guard = (request: FastifyRequest): NetworkSource | undefined => {
    return input.network ? checkNetworkRequest(request, input.network) : undefined;
  };
  const verify = (access: string) =>
    isSession(access) ? registry.verifySession(access) : registry.authenticate(access);
  const authorize = (token: string, recheck?: () => void): AuthorizationService =>
    new AuthorizationService(() => {
      recheck?.();
      return verify(token);
    }, input.designerWorkspace);
  const context = (token: string, database: string): void => {
    if (!verify(token).credential.grants.some((grant) => grant.database === database)) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
  };
  const actor = (token: string, userSubject?: string): SecurityActor => {
    const verified = verify(token).actor;
    return {
      ...verified,
      ...(userSubject &&
      verified.applicationId &&
      /^[\p{L}\p{N}_.:@/-]{1,160}$/u.test(userSubject) &&
      !/^mdb[ts]_v\d+_/.test(userSubject)
        ? {
            userSubject: userSubject.slice(0, 160),
            userSubjectTrust: 'application-asserted' as const,
          }
        : {}),
    };
  };
  const audited = async <T>(
    token: string,
    database: string,
    requestId: string,
    transport: 'http' | 'websocket',
    work: () => Promise<T>,
    userSubject?: string,
    action = 'data.execute',
    networkSource?: NetworkSource,
  ): Promise<T> => {
    const identity = actor(token, userSubject);
    registry.recordAccess(
      identity,
      database,
      'started',
      transport,
      requestId,
      action,
      networkSource,
    );
    let result: T;
    try {
      result = await work();
    } catch (error) {
      registry.recordAccess(
        identity,
        database,
        error instanceof SecurityError ? 'denied' : 'failed',
        transport,
        requestId,
        action,
        networkSource,
      );
      throw error;
    }
    // If this commit fails the durable intent remains unresolved; never report success.
    try {
      registry.recordAccess(
        identity,
        database,
        'succeeded',
        transport,
        requestId,
        action,
        networkSource,
      );
    } catch {
      throw new SecurityError('SECURITY_OUTCOME_UNCONFIRMED');
    }
    return result;
  };
  const execute = (
    token: string,
    database: string,
    body: WireExecuteBody,
    requestId: string,
    transport: 'http' | 'websocket',
    userSubject?: string,
    recheck?: () => void,
    networkSource?: NetworkSource,
  ): Promise<WireExecuteResultJson> =>
    audited(
      token,
      database,
      requestId,
      transport,
      () => input.dispatcher.executeAuthorized(database, body, authorize(token, recheck)),
      userSubject,
      'data.execute',
      networkSource,
    );

  // Discovery belongs to the data plane. Keep the old management URLs as
  // compatibility aliases subject to their original management source policy.
  const discovery = async (request: FastifyRequest, reply: FastifyReply, database?: string) => {
    reply.header('cache-control', 'no-store');
    const requestId = randomUUID();
    try {
      const token = access(request);
      const auth = authorize(token, () => guard(request));
      if (database === undefined) {
        const allowed = new Set(
          verify(token)
            .credential.grants.filter((g) => g.resource === '*' && g.actions.includes('model.read'))
            .map((g) => g.database),
        );
        return reply.send({
          databases: input.listDatabases().filter((db) => allowed.has(db.name)),
        });
      }
      database = name(database);
      auth.require(database, 'model.read');
      const engine = await input.getEngine(database);
      const recheck = await auth.operation(database, { op: 'executeQuery', snapshot: {} }, engine);
      recheck();
      const result = await input.catalog(database);
      recheck();
      return reply.send(result);
    } catch (error) {
      return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
    }
  };

  if (input.listenerRole !== 'management') {
    app.get('/api/v1/databases', { exposeHeadRoute: false }, (request, reply) =>
      discovery(request, reply),
    );
    app.get('/api/v1/databases/:dbName/catalog', { exposeHeadRoute: false }, (request, reply) =>
      discovery(request, reply, (request.params as { dbName: string }).dbName),
    );
    app.get('/api/v1/security/context', async (request, reply) => {
      const requestId = randomUUID();
      try {
        const token = access(request);
        const query = request.query as { database?: unknown };
        const database = name(query.database);
        context(token, database);
        const verified = verify(token);
        return {
          version: 1,
          database,
          actor: verified.actor,
          policyVersion: verified.policyVersion,
        };
      } catch (error) {
        return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
      }
    });
    app.post('/api/v1/rpc', async (request, reply) => {
      const requestId = randomUUID();
      try {
        const token = access(request);
        const raw = request.body;
        if (!record(raw) || raw.version !== 1) {
          throw new SecurityError('SECURITY_PROTOCOL_UNSUPPORTED');
        }
        const user = request.headers['x-modeldb-user-subject'];
        const result = await execute(
          token,
          name(raw.database),
          operation(raw.operation),
          requestId,
          'http',
          typeof user === 'string' ? user : undefined,
          () => guard(request),
          guard(request),
        );
        return { version: 1, result, requestId };
      } catch (error) {
        return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
      }
    });

    app.get('/api/v1/stream', { websocket: true }, (socket: WebSocket, request) => {
      let session: { token: string; database: string; grants: string } | undefined;
      let busy = false;
      let initialSource: NetworkSource | undefined;
      let untrack: (() => void) | undefined;
      const recheck = (): void => {
        try {
          guard(request);
        } catch (error) {
          try {
            if (initialSource) {
              input.securityControl?.protection.event(
                'network.reject',
                'denied',
                initialSource,
                error instanceof SecurityError ? error.code : 'SECURITY_SOURCE_DENIED',
                undefined,
                undefined,
                'data',
                'websocket',
              );
            }
            socket.close(
              1008,
              error instanceof SecurityError ? error.code : 'SECURITY_SOURCE_DENIED',
            );
          } catch {
            socket.close(1011, 'SECURITY_STORE_WRITE_FAILED');
          }
        }
      };
      try {
        initialSource = guard(request);
        untrack = initialSource
          ? input.network?.trackConnection(socket, initialSource.clientIp, 'data', recheck)
          : undefined;
      } catch {
        socket.close(1008, 'SECURITY_SOURCE_DENIED');
        return;
      }
      let timer = setTimeout(() => socket.close(1008, 'SECURITY_CREDENTIAL_INVALID'), 5000);
      const checkAccess = (): void => {
        if (!session) {
          return;
        }
        try {
          context(session.token, session.database);
          const remaining = registry.accessRemainingMs(session.token);
          clearTimeout(timer);
          timer = setTimeout(checkAccess, Math.min(remaining, 2147483647));
        } catch {
          socket.close(1008, 'SECURITY_CREDENTIAL_REVOKED');
        }
      };
      let unsubscribe = registry.onInvalidation(checkAccess);
      socket.on('close', () => {
        databaseSockets.delete(socket);
        clearTimeout(timer);
        unsubscribe();
        untrack?.();
      });
      socket.on('error', () => socket.close());
      socket.on('message', (data) => {
        if (socket.readyState !== 1) {
          return;
        }
        // Bound the handshake/message queue; clients can open independent sessions for concurrency.
        const bytes = Array.isArray(data)
          ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
          : data.byteLength;
        if (busy || bytes > 8 * 1024 * 1024) {
          socket.close(1008, 'SECURITY_INVALID_REQUEST');
          return;
        }
        busy = true;
        void (async () => {
          const requestId = randomUUID();
          let id: string | undefined;
          try {
            const source = guard(request);
            if (source) {
              input.securityControl?.protection.consume(source, 'data');
            }
            const raw: unknown = JSON.parse(data.toString());
            if (!record(raw) || raw.version !== 1) {
              throw new SecurityError('SECURITY_PROTOCOL_UNSUPPORTED');
            }
            if (!session) {
              if (raw.type !== 'security.hello') {
                throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
              }
              const initialAccess =
                typeof raw.token === 'string' ? raw.token : sessionCookie(request, secureCookies);
              if (!initialAccess) {
                throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
              }
              if (raw.token !== undefined) {
                if (!initialAccess.startsWith('mdbt_v1_')) {
                  throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
                }
              } else {
                if (typeof raw.csrf !== 'string') {
                  throw new SecurityError('SECURITY_CSRF_REQUIRED');
                }
                registry.verifyBrowserSession(
                  initialAccess,
                  browserOrigin(request, secureCookies),
                  raw.csrf,
                );
              }
              const database = name(raw.database);
              context(initialAccess, database);
              if (source) {
                input.securityControl?.protection.consume(
                  source,
                  'data',
                  verify(initialAccess).actor.principalId,
                );
              }
              session = {
                token: initialAccess,
                database,
                grants: JSON.stringify(verify(initialAccess).credential.grants),
              };
              databaseSockets.set(socket, database);
              clearTimeout(timer);
              unsubscribe();
              const credentialId = verify(initialAccess).credential.id;
              unsubscribe = registry.onInvalidation((event) => {
                if (!event.credentialIds.includes(credentialId)) {
                  checkAccess();
                  return;
                }
                try {
                  context(initialAccess, database);
                  // Only a changed scope or this session's invalidation requires rehandshake.
                  if (JSON.stringify(verify(initialAccess).credential.grants) !== session?.grants) {
                    socket.close(1008, 'SECURITY_REAUTH_REQUIRED');
                  }
                } catch {
                  socket.close(1008, 'SECURITY_CREDENTIAL_REVOKED');
                }
              }, credentialId);
              checkAccess();
              socket.send(JSON.stringify({ type: 'security.ready', version: 1, database }));
            } else {
              if (source) {
                input.securityControl?.protection.consume(
                  source,
                  'data',
                  verify(session.token).actor.principalId,
                );
              }
              id = name(raw.id);
              if (raw.type !== 'security.rpc') {
                throw new SecurityError('SECURITY_INVALID_REQUEST');
              }
              const result = await execute(
                session.token,
                session.database,
                operation(raw.operation),
                requestId,
                'websocket',
                undefined,
                () => {
                  if (socket.readyState !== 1) {
                    throw new SecurityError('SECURITY_CLOSED');
                  }
                  guard(request);
                },
                guard(request),
              );
              socket.send(
                JSON.stringify({ type: 'security.result', version: 1, id, result, requestId }),
              );
            }
          } catch (error) {
            const failed = failure(error, requestId);
            if (initialSource && failed.status === 401) {
              try {
                input.securityControl?.protection.event(
                  'authentication.reject',
                  'denied',
                  initialSource,
                  'SECURITY_CREDENTIAL_INVALID',
                  undefined,
                  undefined,
                  'data',
                  'websocket',
                );
                input.securityControl?.protection.authenticationFailed(initialSource, 'data');
              } catch {
                socket.close(1011, 'SECURITY_STORE_WRITE_FAILED');
                return;
              }
            }
            if (initialSource && (failed.status === 403 || failed.status === 429)) {
              try {
                input.securityControl?.protection.event(
                  'network.reject',
                  'denied',
                  initialSource,
                  (failed.body as { error: string }).error,
                  undefined,
                  undefined,
                  'data',
                  'websocket',
                );
              } catch {
                socket.close(1011, 'SECURITY_STORE_WRITE_FAILED');
                return;
              }
            }
            socket.send(
              JSON.stringify({
                type: 'security.error',
                version: 1,
                id,
                status: failed.status,
                ...(failed.body as object),
              }),
            );
            if (!session || failed.status === 401) {
              socket.close(1008, 'SECURITY_CREDENTIAL_INVALID');
            }
          } finally {
            busy = false;
          }
        })();
      });
    });
  }
  const setBrowserSession = (
    reply: FastifyReply,
    session: { session: string; expiresAt: string },
    request: FastifyRequest,
  ): void => {
    const maxAge = Math.max(1, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
    reply
      .header('cache-control', 'no-store')
      .header('set-cookie', [
        cookieHeader(
          sessionCookieName(request, secureCookies),
          session.session,
          maxAge,
          secureCookies,
        ),
      ]);
  };
  const clearBrowserSession = (reply: FastifyReply, request: FastifyRequest): void => {
    reply
      .header('cache-control', 'no-store')
      .header('set-cookie', [
        cookieHeader(sessionCookieName(request, secureCookies), '', 0, secureCookies),
      ]);
  };

  /** Exchange a one-time code issued by the OS-authenticated security CLI for browser cookies. */
  app.post('/api/v1/security/pair', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const requestId = randomUUID();
    try {
      guard(request);
      const raw = request.body;
      if (!record(raw) || typeof raw.code !== 'string') {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      const origin = browserOrigin(request, secureCookies);
      const session = registry.consumePairing(
        raw.code,
        origin,
        input.listenerRole === 'management' ? 15 : 30,
        input.listenerRole,
      );
      const verified = registry.verifyBrowserSession(session.session, origin);
      checkBrowserRole(verified);
      setBrowserSession(reply, session, request);
      return {
        version: 1,
        expiresAt: session.expiresAt,
        absoluteExpiresAt: verified.absoluteExpiresAt,
        csrf: verified.csrf,
        securityAdmin: verified.securityAdmin === true,
        requestId,
      };
    } catch (error) {
      return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
    }
  });
  app.get('/api/v1/security/session', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const requestId = randomUUID();
    try {
      guard(request);
      const session = sessionCookie(request, secureCookies);
      if (!session) {
        throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
      }
      const verified = registry.verifyBrowserSession(
        session,
        browserOrigin(request, secureCookies),
      );
      checkBrowserRole(verified);
      return {
        version: 1,
        expiresAt: verified.sessionExpiresAt,
        absoluteExpiresAt: verified.absoluteExpiresAt,
        csrf: verified.csrf,
        actor: verified.actor,
        policyVersion: verified.policyVersion,
        securityAdmin: verified.securityAdmin === true,
        requestId,
      };
    } catch (error) {
      return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
    }
  });
  app.post('/api/v1/security/session/refresh', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const requestId = randomUUID();
    try {
      guard(request);
      const current = sessionCookie(request, secureCookies);
      if (!current) {
        throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
      }
      const origin = browserOrigin(request, secureCookies);
      checkBrowserRole(registry.verifyBrowserSession(current, origin, csrfHeader(request)));
      const session = registry.rotateSession(
        current,
        input.listenerRole === 'management' ? 15 : 30,
      );
      const verified = registry.verifyBrowserSession(session.session, origin);
      setBrowserSession(reply, session, request);
      return {
        version: 1,
        expiresAt: session.expiresAt,
        absoluteExpiresAt: verified.absoluteExpiresAt,
        csrf: verified.csrf,
        requestId,
      };
    } catch (error) {
      return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
    }
  });
  app.post('/api/v1/security/session/logout', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const requestId = randomUUID();
    try {
      guard(request);
      const current = sessionCookie(request, secureCookies);
      if (!current) {
        throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
      }
      checkBrowserRole(
        registry.verifyBrowserSession(
          current,
          browserOrigin(request, secureCookies),
          csrfHeader(request),
        ),
      );
      registry.revokeSession(current);
      clearBrowserSession(reply, request);
      return { version: 1, loggedOut: true, requestId };
    } catch (error) {
      return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
    }
  });

  app.get('/api/v1/security/admin/overview', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const requestId = randomUUID();
    try {
      guard(request);
      const session = sessionCookie(request, secureCookies);
      if (!session) {
        throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
      }
      const verified = registry.verifyBrowserSession(
        session,
        browserOrigin(request, secureCookies),
      );
      checkBrowserRole(verified);
      if (!verified.securityAdmin) {
        throw new SecurityError('SECURITY_FORBIDDEN');
      }
      return {
        version: 1,
        registry: registry.securityCenterSnapshot(),
        network: input.network?.status() ?? null,
        requestId,
      };
    } catch (error) {
      return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
    }
  });

  app.post('/api/v1/security/admin/control', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const requestId = randomUUID();
    try {
      const source = guard(request);
      const session = sessionCookie(request, secureCookies);
      if (!session) {
        throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
      }
      const verified = registry.verifyBrowserSession(
        session,
        browserOrigin(request, secureCookies),
        csrfHeader(request),
      );
      checkBrowserRole(verified);
      if (!verified.securityAdmin) {
        throw new SecurityError('SECURITY_FORBIDDEN');
      }
      if (!input.securityControl) {
        throw new SecurityError('SECURITY_LOCAL_CHANNEL_UNAVAILABLE');
      }
      if (record(request.body) && request.body.action === 'master.rotate') {
        requireRecentSecurityPairing(verified.credential.createdAt);
      }
      if (source) {
        input.securityControl.protection.consume(source, 'management', verified.actor.principalId);
      }
      return registry.withManagementActor(
        {
          actor: verified.actor,
          requestId,
          source: {
            transport: 'http',
            ...(source
              ? {
                  peerIp: source.peerIp,
                  clientIp: source.clientIp,
                  clientIpBasis: source.clientIpBasis,
                }
              : {}),
          },
        },
        () => {
          if (
            record(request.body) &&
            typeof request.body.action === 'string' &&
            request.body.action.startsWith('deployment.') &&
            input.listenerRole !== 'management'
          ) {
            throw new SecurityError('SECURITY_FORBIDDEN');
          }
          if (
            record(request.body) &&
            typeof request.body.action === 'string' &&
            request.body.action.startsWith('registration.')
          ) {
            if (input.listenerRole !== 'management') {
              throw new SecurityError('SECURITY_FORBIDDEN');
            }
            return registry.manageHostedIdentity(
              session,
              browserOrigin(request, secureCookies),
              csrfHeader(request)!,
              request.body,
            );
          }
          return dispatchSecurityControl(input.securityControl!, request.body, source);
        },
      );
    } catch (error) {
      return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
    }
  });

  app.get('/api/v1/security/admin/audit', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const requestId = randomUUID();
    try {
      guard(request);
      const session = sessionCookie(request, secureCookies);
      if (!session) {
        throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
      }
      const verified = registry.verifyBrowserSession(
        session,
        browserOrigin(request, secureCookies),
      );
      checkBrowserRole(verified);
      if (!verified.securityAdmin) {
        throw new SecurityError('SECURITY_FORBIDDEN');
      }
      const raw = record(request.query) ? request.query : {};
      return { ...registry.auditPage(auditQuery(raw)), requestId };
    } catch (error) {
      return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
    }
  });

  app.get('/api/v1/security/admin/audit/export', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const requestId = randomUUID();
    try {
      const networkSource = guard(request);
      const session = sessionCookie(request, secureCookies);
      if (!session) {
        throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
      }
      const verified = registry.verifyBrowserSession(
        session,
        browserOrigin(request, secureCookies),
      );
      checkBrowserRole(verified);
      if (!verified.securityAdmin) {
        throw new SecurityError('SECURITY_FORBIDDEN');
      }
      const raw = record(request.query) ? request.query : {};
      const query = auditQuery(raw);
      const exported = registry.auditNdjson(query);
      registry.recordAuditExport({
        actor: verified.actor,
        transport: 'http',
        requestId,
        query,
        networkSource,
      });
      reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('content-disposition', 'attachment; filename="modeldb-security-audit.jsonl"');
      return reply.send(exported);
    } catch (error) {
      return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (
      (['GET', 'HEAD'].includes(request.method) && input.publicAssetPaths?.has(path ?? '')) ||
      request.method === 'OPTIONS' ||
      registrationPath(request.url) ||
      authenticationPath(request.url) ||
      path === '/health' ||
      path === '/api/v1/rpc' ||
      path === '/api/v1/security/context' ||
      path === '/api/v1/security/pair' ||
      path === '/api/v1/security/session' ||
      path === '/api/v1/security/session/refresh' ||
      path === '/api/v1/security/session/logout' ||
      path === '/api/v1/security/admin/overview' ||
      path === '/api/v1/security/admin/control' ||
      path === '/api/v1/security/admin/audit' ||
      path === '/api/v1/security/admin/audit/export' ||
      path === '/api/v1/stream' ||
      (input.listenerRole !== 'management' &&
        request.method === 'GET' &&
        (path === '/api/v1/databases' || /^\/api\/v1\/databases\/[^/]+\/catalog$/.test(path ?? '')))
    ) {
      return;
    }
    const requestId = randomUUID();
    try {
      if (path === '/' || path?.startsWith('/v2/')) {
        throw new SecurityError('SECURITY_PROTOCOL_UNSUPPORTED');
      }
      if (request.method === 'GET' && path === '/api/v1/management/databases') {
        // Preserve the legacy management listing of explicitly granted databases,
        // including callable-only scopes. The new data route requires raw read scope.
        const allowed = new Set(verify(access(request)).credential.grants.map((g) => g.database));
        return reply.send({
          databases: input.listDatabases().filter((db) => allowed.has(db.name)),
        });
      }
      const catalog = /^\/api\/v1\/management\/databases\/([^/]+)\/catalog$/.exec(path ?? '');
      if (request.method === 'GET' && catalog) {
        return discovery(request, reply, name(decodeURIComponent(catalog[1]!)));
      }
      const token = access(request);
      const auth = authorize(token, () => guard(request));
      const callable = /^\/api\/v1\/databases\/([^/]+)\/query-interfaces\/([^/]+)$/.exec(
        path ?? '',
      );
      if (request.method === 'POST' && callable) {
        const raw = request.body;
        if (!record(raw)) {
          throw new SecurityError('SECURITY_INVALID_REQUEST');
        }
        const user = request.headers['x-modeldb-user-subject'];
        const result = await execute(
          token,
          name(decodeURIComponent(callable[1]!)),
          {
            ...raw,
            op: 'executeInterface',
            callableName: name(decodeURIComponent(callable[2]!)),
          } as Extract<WireExecuteBody, { op: 'executeInterface' }>,
          requestId,
          'http',
          typeof user === 'string' ? user : undefined,
          () => guard(request),
          guard(request),
        );
        return reply.send(result);
      }
      if (request.method === 'GET' && path === '/api/v1/management/backups') {
        const database = name((request.query as { database?: unknown }).database);
        auth.require(database, 'backup.manage');
        return reply.send({
          backups: listDatabaseBackups(input.workspace, database, input.backupKeys).map(
            ({ path: _path, ...info }) => info,
          ),
        });
      }
      const download = /^\/api\/v1\/management\/backups\/([^/]+)\/download$/.exec(path ?? '');
      if (request.method === 'GET' && download) {
        const fileName = decodeURIComponent(download[1]!);
        const info = listDatabaseBackups(input.workspace, undefined, input.backupKeys).find(
          (b) => b.fileName === fileName,
        );
        if (!info) {
          throw new SecurityError('SECURITY_FORBIDDEN');
        }
        auth.require(info.database, 'backup.manage');
        auth.require(info.database, 'transfer.export');
        const result = await audited(
          token,
          info.database,
          requestId,
          'http',
          async () => {
            const file = readDatabaseBackupFile(input.workspace, fileName, input.backupKeys);
            auth.require(file.info.database, 'backup.manage');
            auth.require(file.info.database, 'transfer.export');
            return file;
          },
          undefined,
          'backup.download',
          guard(request),
        );
        return reply.type('application/vnd.modeldb.backup+json').send(result.content);
      }
      if (request.method === 'POST' && path === '/api/v1/management/backups/import') {
        if (!Buffer.isBuffer(request.body) || !input.backupKeys) {
          throw new SecurityError('SECURITY_INVALID_REQUEST');
        }
        const { openBackupPackage } = await import('./backup-package.js');
        const checked = openBackupPackage(request.body, { provider: input.backupKeys });
        const database = checked.manifest.database;
        checked.material.key.fill(0);
        const checkImport = (): void => {
          auth.require(database, 'backup.manage');
          auth.require(database, 'transfer.import');
        };
        checkImport();
        const result = await audited(
          token,
          database,
          requestId,
          'http',
          () =>
            input.writeGate.runExclusive(database, async () => {
              checkImport();
              const { path: _path, ...backup } = importDatabaseBackup(
                input.workspace,
                'imported.modeldb-backup.json',
                request.body as Buffer,
                input.backupKeys,
              );
              return { ok: true, backup };
            }),
          undefined,
          'backup.import',
          guard(request),
        );
        return reply.send(result);
      }
      const backup = /^\/api\/v1\/management\/databases\/([^/]+)\/backup$/.exec(path ?? '');
      if (request.method === 'POST' && backup) {
        const database = name(decodeURIComponent(backup[1]!));
        auth.require(database, 'backup.manage');
        const result = await audited(
          token,
          database,
          requestId,
          'http',
          () =>
            input.writeGate.runExclusive(database, async () => {
              auth.require(database, 'backup.manage');
              const engine = await input.getEngine(database);
              await engine.flushAll();
              auth.require(database, 'backup.manage');
              const raw = record(request.body) ? request.body : {};
              const { path: _path, ...info } = createDatabaseBackup(
                input.workspace,
                database,
                'manual',
                normalizeBackupName(raw.name),
                input.backupKeys,
              );
              return { ok: true, backup: info };
            }),
          undefined,
          'backup.create',
          guard(request),
        );
        return reply.send(result);
      }
      const management = /^\/api\/v1\/management\/databases\/([^/]+)(?:\/(clear|restore))?$/.exec(
        path ?? '',
      );
      const creating = request.method === 'POST' && path === '/api/v1/management/databases';
      if (input.manage && (creating || management)) {
        const raw = record(request.body) ? request.body : {};
        const database = name(creating ? raw.name : decodeURIComponent(management![1]!));
        const checkManagement = (): void => {
          auth.require(database, 'database.manage');
          auth.require(database, 'schema.manage');
          auth.require(database, 'model.read');
          auth.require(database, 'model.write');
          if (!creating) {
            auth.require(database, 'backup.manage');
          }
        };
        checkManagement();
        const result = await audited(
          token,
          database,
          requestId,
          'http',
          () =>
            input.writeGate.runExclusive(database, async () => {
              checkManagement();
              if (creating) {
                return input.manage!.create(database);
              }
              if (request.method === 'DELETE' && !management![2]) {
                return input.manage!.drop(database);
              }
              if (
                request.method === 'POST' &&
                management![2] === 'clear' &&
                raw.forceReset !== true
              ) {
                return input.manage!.clear(database);
              }
              if (
                request.method === 'POST' &&
                management![2] === 'restore' &&
                typeof raw.backupFile === 'string'
              ) {
                const backup = listDatabaseBackups(
                  input.workspace,
                  database,
                  input.backupKeys,
                ).find((item) => item.fileName === raw.backupFile);
                if (!backup || backup.database !== database) {
                  throw new SecurityError('SECURITY_FORBIDDEN');
                }
                for (const [socket, connectedDatabase] of databaseSockets) {
                  if (connectedDatabase === database) {
                    socket.close(1012, 'DATABASE_RESTORED');
                  }
                }
                return input.manage!.restore(database, backup.fileName);
              }
              throw new SecurityError('SECURITY_FORBIDDEN');
            }),
          undefined,
          creating
            ? 'database.create'
            : request.method === 'DELETE'
              ? 'database.drop'
              : management![2] === 'restore'
                ? 'database.restore'
                : 'database.clear',
          guard(request),
        );
        return reply.send(result);
      }
      // Security administration and force-reset remain local-only.
      throw new SecurityError('SECURITY_FORBIDDEN');
    } catch (error) {
      return sendFailure(reply, error, requestId, input.securityControl?.protection.retryAfter());
    }
  });
}
