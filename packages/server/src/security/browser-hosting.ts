import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SecurityError } from './security-errors.js';
import { isLoopbackAddress, securityOrigin, networkAddress } from './network-policy.js';
import type { SecurityProtection } from './security-protection.js';

/** Explicit trusted build output. No directory, address or certificate discovery. */
export interface BrowserHostingConfig {
  readonly enabled: boolean;
  readonly designerDirectory?: string;
  /** Always binds 127.0.0.1; zero selects a free port, discoverable only through the OS pipe. */
  readonly managementPort?: number;
}
export function validateBrowserHostingConfig(
  raw: unknown,
): asserts raw is BrowserHostingConfig | undefined {
  if (raw === undefined) {
    return;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SecurityError('SECURITY_INVALID_CONFIG');
  }
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (k) => !['enabled', 'designerDirectory', 'managementPort'].includes(k),
    ) ||
    typeof value.enabled !== 'boolean' ||
    (value.designerDirectory !== undefined &&
      (typeof value.designerDirectory !== 'string' || !value.designerDirectory.trim())) ||
    (value.enabled && value.designerDirectory === undefined) ||
    (value.managementPort !== undefined &&
      (!Number.isSafeInteger(value.managementPort) ||
        (value.managementPort as number) < 0 ||
        (value.managementPort as number) > 65535))
  ) {
    throw new SecurityError('SECURITY_INVALID_CONFIG');
  }
}
const mime: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};
export interface HostedAsset {
  readonly bytes: Buffer;
  readonly contentType: string;
}
export type HostedAssets = ReadonlyMap<string, HostedAsset>;
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
};

/** Snapshot a small, immutable public build. Never reads unknown files or request-derived paths. */
export function loadHostedAssets(
  directory: string,
  protectedDirectories: readonly string[],
): HostedAssets {
  try {
    const root = resolve(directory);
    if (protectedDirectories.some((p) => inside(resolve(p), root) || inside(root, resolve(p)))) {
      throw Error();
    }
    let current = parse(root).root;
    for (const segment of root.slice(current.length).split(sep)) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) {
        throw Error();
      }
    }
    const assets = new Map<string, HostedAsset>();
    let total = 0;
    const walk = (dir: string, prefix: string) => {
      for (const name of readdirSync(dir).sort()) {
        if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name)) {
          throw Error();
        }
        const path = join(dir, name),
          key = prefix + '/' + name,
          stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
          throw Error();
        }
        if (stat.isDirectory()) {
          if (key !== '/assets') {
            throw Error();
          }
          walk(path, key);
          continue;
        }
        const type = key === '/index.html' ? 'text/html; charset=utf-8' : mime[extname(name)];
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          !type ||
          stat.size > 16 * 1024 * 1024 ||
          assets.size >= 1024
        ) {
          throw Error();
        }
        total += stat.size;
        if (total > 64 * 1024 * 1024) {
          throw Error();
        }
        assets.set(key, { bytes: readFileSync(path), contentType: type });
      }
    };
    walk(root, '');
    if (!assets.has('/index.html')) {
      throw Error();
    }
    return assets;
  } catch {
    throw new SecurityError('SECURITY_INVALID_CONFIG');
  }
}

export function hostedAssetPaths(
  assets: HostedAssets,
  entry: '/designer/' | '/security/',
): ReadonlySet<string> {
  return new Set([entry, ...[...assets.keys()].filter((p) => p !== '/index.html')]);
}
export function installHostedAssets(
  app: FastifyInstance,
  assets: HostedAssets,
  entry: '/designer/' | '/security/',
): ReadonlySet<string> {
  const paths = hostedAssetPaths(assets, entry);
  for (const path of paths) {
    const asset = assets.get(path === entry ? '/index.html' : path)!;
    const bytes =
      path === entry
        ? Buffer.from(
            asset.bytes
              .toString('utf8')
              .replace(
                '</head>',
                `<meta name="modeldb-hosting-role" content="${entry === '/designer/' ? 'data' : 'management'}"></head>`,
              ),
          )
        : asset.bytes;
    app.get(path, async (request, reply) => {
      reply.header('cache-control', 'no-store').header('content-type', asset.contentType);
      if (request.url.includes('?')) {
        return reply.code(400).send();
      }
      return reply.send(bytes);
    });
  }
  return paths;
}

const managementApis = new Set([
  '/api/v1/security/pair',
  '/api/v1/security/session',
  '/api/v1/security/session/refresh',
  '/api/v1/security/session/logout',
  '/api/v1/security/admin/overview',
  '/api/v1/security/admin/control',
  '/api/v1/security/admin/audit',
  '/api/v1/security/admin/audit/export',
]);
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

/** Listener identity and exact origin are checked before CORS, body parsing and authentication. */
export function installHostedBoundary(
  app: FastifyInstance,
  input: {
    role: 'data' | 'management';
    origin: () => string;
    assets: ReadonlySet<string>;
    protection?: SecurityProtection;
  },
): void {
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', csp)
      .header('cross-origin-resource-policy', 'same-origin');
    try {
      const path = request.url.split('?')[0] ?? '';
      // Never normalize an attacker path into an allowed route.
      if (
        /[\\\u0000-\u0020]/.test(path) ||
        /%2e|%2f|%5c|%25/i.test(path) ||
        /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) ||
        path.includes('//')
      ) {
        throw new SecurityError('SECURITY_INVALID_REQUEST');
      }
      const origin = securityOrigin(input.origin());
      if (
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin !== undefined && request.headers.origin !== origin) ||
        (request.headers['sec-fetch-site'] !== undefined &&
          request.headers['sec-fetch-site'] !== 'same-origin' &&
          !(
            request.headers['sec-fetch-site'] === 'none' &&
            ['GET', 'HEAD'].includes(request.method) &&
            input.assets.has(path)
          ))
      ) {
        throw new SecurityError('SECURITY_ORIGIN_DENIED');
      }
      if (input.role === 'management') {
        assertManagementSocket(request);
        if (
          !managementApis.has(path) &&
          !(input.assets.has(path) && ['GET', 'HEAD'].includes(request.method))
        ) {
          return reply.code(404).send({ error: 'SECURITY_NOT_FOUND' });
        }
      } else if (
        path === '/security' ||
        (path.startsWith('/security/') &&
          !path.startsWith('/security/registration/') &&
          !path.startsWith('/security/authentication/')) ||
        path.startsWith('/api/v1/security/admin')
      ) {
        return reply.code(404).send({ error: 'SECURITY_NOT_FOUND' });
      }
    } catch (error) {
      try {
        const peerIp = networkAddress(request.raw.socket.remoteAddress ?? '');
        input.protection?.event(
          'hosting.reject',
          'denied',
          {
            peerIp,
            clientIp: peerIp,
            clientIpBasis: 'socket',
            secure: 'encrypted' in request.raw.socket && request.raw.socket.encrypted === true,
          },
          error instanceof SecurityError ? error.code : 'SECURITY_ORIGIN_DENIED',
          undefined,
          undefined,
          input.role === 'management' ? 'management' : 'data',
        );
      } catch (auditError) {
        return reply.code(503).send({
          error:
            auditError instanceof SecurityError ? auditError.code : 'SECURITY_STORE_WRITE_FAILED',
        });
      }
      return reply
        .code(403)
        .send({ error: error instanceof SecurityError ? error.code : 'SECURITY_ORIGIN_DENIED' });
    }
  });
}
function assertManagementSocket(request: FastifyRequest): void {
  const socket = request.raw.socket;
  if (
    !isLoopbackAddress(socket.remoteAddress ?? '') ||
    socket.localAddress !== '127.0.0.1' ||
    Object.keys(request.headers).some(
      (k) => k === 'forwarded' || k.startsWith('x-forwarded-') || k === 'x-real-ip' || k === 'via',
    )
  ) {
    throw new SecurityError('SECURITY_SOURCE_DENIED');
  }
}

/** Only used with explicit hosting. A broad bind requires an explicit canonical public origin. */
export function hostedDataOrigin(
  endpoint: { publicBaseUrl?: string; host: string },
  port: number,
): string {
  if (endpoint.publicBaseUrl) {
    return securityOrigin(endpoint.publicBaseUrl);
  }
  if (!isLoopbackAddress(endpoint.host)) {
    throw new SecurityError('SECURITY_INVALID_CONFIG');
  }
  const host = endpoint.host.includes(':')
    ? `[${endpoint.host.replace(/^\[|\]$/g, '')}]`
    : endpoint.host;
  return securityOrigin(`http://${host}:${port}`);
}
