import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { SecurityError } from './security-errors.js';
import { securityOrigin } from './network-policy.js';

export function cookies(request: FastifyRequest): Record<string, string> {
  const raw = request.headers.cookie;
  if (typeof raw !== 'string' || raw.length > 8192) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(key) && value.length <= 512) {
      if (Object.hasOwn(result, key)) {
        throw new SecurityError('SECURITY_CREDENTIAL_INVALID');
      }
      result[key] = value;
    }
  }
  return result;
}
export function sessionCookieName(request: FastifyRequest, secure: boolean): string {
  const scope = `${browserOrigin(request, secure)}|${secure ? 'https' : 'http'}://${request.headers.host}`;
  return `mdbs_session_${createHash('sha256').update(scope).digest('hex').slice(0, 24)}`;
}
export function sessionCookie(request: FastifyRequest, secure: boolean): string | undefined {
  const parsed = cookies(request);
  if (!Object.keys(parsed).some((key) => key.startsWith('mdbs_session_'))) {
    return undefined;
  }
  const value = parsed[sessionCookieName(request, secure)];
  return value && /^mdbs_v1_[A-Za-z0-9-]{36}_[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
export function csrfHeader(request: FastifyRequest): string {
  const supplied = request.headers['x-modeldb-csrf'];
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) {
    throw new SecurityError('SECURITY_CSRF_REQUIRED');
  }
  return supplied;
}
export function browserOrigin(request: FastifyRequest, secure: boolean): string {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    return securityOrigin(origin);
  }
  // Same-origin GET fetches may omit Origin. Fetch Metadata is browser-owned.
  if (
    origin === undefined &&
    request.headers['sec-fetch-site'] === 'same-origin' &&
    request.headers.host
  ) {
    return securityOrigin(`${secure ? 'https' : 'http'}://${request.headers.host}`);
  }
  throw new SecurityError('SECURITY_ORIGIN_DENIED');
}
export function unsafeMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}
export function cookieHeader(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}
