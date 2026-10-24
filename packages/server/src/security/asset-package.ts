import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { fileDigest, stableStringify } from '@mode-db/common';
import {
  assetGraphStatistics,
  validateAssetGraph,
  validateDesignerAsset,
  type AssetGraph,
  type DesignerAssetGraph,
} from '@mode-db/core';
import { backupRecipientId } from './backup-package.js';
import { SecurityError } from './security-errors.js';

export const MAX_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_ASSET_CONTENT_BYTES = 48 * 1024 * 1024;
const FORMAT = 'modeldb.asset.v1';
const DESIGNER_FORMAT = 'modeldb.asset.v2';
export interface AssetContent {
  readonly version: 1;
  readonly packageId: string;
  readonly assetId: string;
  readonly assetVersion: string;
  readonly sourceInstanceId: string;
  readonly publisherId: string;
  readonly createdAt: string;
  readonly contentDigest: string;
  readonly statistics: ReturnType<typeof assetGraphStatistics>;
  readonly graph: AssetGraph;
}
export interface DesignerAssetContent extends Omit<AssetContent, 'version'> {
  readonly version: 2;
  readonly designer: DesignerAssetGraph;
}
export type AnyAssetContent = AssetContent | DesignerAssetContent;
const fail = (): never => {
  throw new SecurityError('SECURITY_INVALID_REQUEST');
};
const check = (value: unknown): void => {
  if (!value) {
    fail();
  }
};
function exact(value: unknown, fields: string[]): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value));
  const obj = value as Record<string, unknown>;
  check(
    Object.keys(obj).length === fields.length && fields.every((key) => Object.hasOwn(obj, key)),
  );
  return obj;
}
const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
function decode(value: unknown, max: number, length?: number): Buffer {
  check(
    typeof value === 'string' && value.length <= Math.ceil((max * 4) / 3) && /^[\w-]+$/.test(value),
  );
  const bytes = Buffer.from(value as string, 'base64url');
  check(
    bytes.length > 0 &&
      bytes.length <= max &&
      b64(bytes) === value &&
      (length === undefined || bytes.length === length),
  );
  return bytes;
}
/** Bounded object depth/count; dangerous extension/prototype keys never reach the engine. */
function parse(bytes: Buffer): unknown {
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    check(depth <= 32 && ++nodes <= 1000000);
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        check(!['__proto__', 'prototype', 'constructor'].includes(key));
        visit(child, depth + 1);
      }
    }
  };
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  visit(value, 0);
  return value;
}
function validateContent(
  value: unknown,
  publisherId: string,
  version: 1 | 2,
): asserts value is AnyAssetContent {
  exact(value, [
    'version',
    'packageId',
    'assetId',
    'assetVersion',
    'sourceInstanceId',
    'publisherId',
    'createdAt',
    'contentDigest',
    'statistics',
    'graph',
    ...(version === 2 ? ['designer'] : []),
  ]);
  const content = value as AnyAssetContent;
  check(content.version === version && content.publisherId === publisherId);
  for (const id of [content.packageId, content.assetId, content.sourceInstanceId]) {
    check(typeof id === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(id));
  }
  check(
    typeof content.assetVersion === 'string' &&
      /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(content.assetVersion),
  );
  check(
    typeof content.createdAt === 'string' &&
      new Date(content.createdAt).toISOString() === content.createdAt,
  );
  validateAssetGraph(content.graph);
  if (content.version === 2) {
    validateDesignerAsset(content.designer, content.graph);
  }
  check(
    content.contentDigest ===
      fileDigest(
        Buffer.from(
          stableStringify(
            content.version === 2
              ? { graph: content.graph, designer: content.designer }
              : content.graph,
          ),
        ),
      ),
  );
  check(
    stableStringify(content.statistics) === stableStringify(assetGraphStatistics(content.graph)),
  );
}

/** JWS (PS256) over a compact JWE (RSA-OAEP-256 / A256GCM), with a fresh PEK each time. */
export function sealAssetPackage(
  graph: AssetGraph,
  metadata: {
    assetId: string;
    assetVersion: string;
    sourceInstanceId: string;
  },
  recipient: KeyObject,
  signingKey: KeyObject,
): Buffer {
  return seal(graph, metadata, recipient, signingKey);
}
export function sealDesignerAssetPackage(
  graph: AssetGraph,
  designer: DesignerAssetGraph,
  metadata: Parameters<typeof sealAssetPackage>[1],
  recipient: KeyObject,
  signingKey: KeyObject,
): Buffer {
  return seal(graph, metadata, recipient, signingKey, designer);
}
function seal(
  graph: AssetGraph,
  metadata: Parameters<typeof sealAssetPackage>[1],
  recipient: KeyObject,
  signingKey: KeyObject,
  designer?: DesignerAssetGraph,
): Buffer {
  let pek: Buffer | undefined, plain: Buffer | undefined;
  try {
    check(signingKey.type === 'private');
    const recipientId = backupRecipientId(recipient),
      publisherId = backupRecipientId(signingKey);
    check(recipientId !== publisherId);
    const format = designer ? DESIGNER_FORMAT : FORMAT;
    const content: AnyAssetContent = {
      ...(designer ? { version: 2 as const, designer } : { version: 1 as const }),
      packageId: randomUUID(),
      ...metadata,
      publisherId,
      createdAt: new Date().toISOString(),
      contentDigest: fileDigest(
        Buffer.from(stableStringify(designer ? { graph, designer } : graph)),
      ),
      statistics: assetGraphStatistics(graph),
      graph,
    };
    validateContent(content, publisherId, content.version);
    plain = Buffer.from(JSON.stringify(content));
    if (plain.length > MAX_ASSET_CONTENT_BYTES) {
      throw new SecurityError('SECURITY_RESPONSE_LIMIT');
    }
    pek = randomBytes(32);
    const header = b64(
      Buffer.from(
        JSON.stringify({ alg: 'RSA-OAEP-256', enc: 'A256GCM', typ: format, kid: recipientId }),
      ),
    );
    const wrapped = publicEncrypt(
      { key: recipient, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
      pek,
    );
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', pek, iv);
    cipher.setAAD(Buffer.from(header));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const payload = b64(
      Buffer.from(
        [header, b64(wrapped), b64(iv), b64(ciphertext), b64(cipher.getAuthTag())].join('.'),
      ),
    );
    const protectedHeader = b64(
      Buffer.from(JSON.stringify({ alg: 'PS256', typ: format, kid: publisherId })),
    );
    const signature = b64(
      sign('sha256', Buffer.from(protectedHeader + '.' + payload), {
        key: signingKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      }),
    );
    const bytes = Buffer.from(
      JSON.stringify({ format, protected: protectedHeader, payload, signature }),
    );
    check(bytes.length <= MAX_ASSET_BYTES);
    return bytes;
  } catch (error) {
    if (error instanceof SecurityError) {
      throw error;
    }
    return fail();
  } finally {
    pek?.fill(0);
    plain?.fill(0);
  }
}

/** Trust comes from a separately supplied, explicitly verified publisher fingerprint. */
export function openAssetPackage(
  bytes: Buffer,
  recipientKey: KeyObject,
  publisherKey: KeyObject,
  trustedPublisherId: string,
): AssetContent {
  const content = openAnyAssetPackage(bytes, recipientKey, publisherKey, trustedPublisherId);
  check(content.version === 1);
  return content as AssetContent;
}
export function openAnyAssetPackage(
  bytes: Buffer,
  recipientKey: KeyObject,
  publisherKey: KeyObject,
  trustedPublisherId: string,
): AnyAssetContent {
  let pek: Buffer | undefined, plain: Buffer | undefined;
  try {
    check(bytes.length > 0 && bytes.length <= MAX_ASSET_BYTES && recipientKey.type === 'private');
    const publisher = publisherKey.type === 'public' ? publisherKey : createPublicKey(publisherKey);
    const publisherId = backupRecipientId(publisher);
    if (!/^[a-f0-9]{64}$/.test(trustedPublisherId) || publisherId !== trustedPublisherId) {
      throw new SecurityError('SECURITY_FORBIDDEN');
    }
    const outer = exact(parse(bytes), ['format', 'protected', 'payload', 'signature']);
    check(outer.format === FORMAT || outer.format === DESIGNER_FORMAT);
    const signatureHeader = exact(parse(decode(outer.protected, 1024)), ['alg', 'typ', 'kid']);
    check(
      signatureHeader.alg === 'PS256' &&
        signatureHeader.typ === outer.format &&
        signatureHeader.kid === publisherId,
    );
    check(typeof outer.payload === 'string' && outer.payload.length <= MAX_ASSET_BYTES);
    check(
      verify(
        'sha256',
        Buffer.from(outer.protected + '.' + outer.payload),
        {
          key: publisher,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32,
        },
        decode(outer.signature, 512),
      ),
    );
    const parts = decode(outer.payload, 90 * 1024 * 1024)
      .toString('utf8')
      .split('.');
    check(parts.length === 5);
    const header = exact(parse(decode(parts[0], 1024)), ['alg', 'enc', 'typ', 'kid']);
    check(
      header.alg === 'RSA-OAEP-256' &&
        header.enc === 'A256GCM' &&
        header.typ === outer.format &&
        header.kid === backupRecipientId(recipientKey),
    );
    pek = privateDecrypt(
      { key: recipientKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
      decode(parts[1], 512),
    );
    check(pek.length === 32);
    const cipher = createDecipheriv('aes-256-gcm', pek, decode(parts[2], 12, 12));
    cipher.setAAD(Buffer.from(parts[0]!));
    cipher.setAuthTag(decode(parts[4], 16, 16));
    plain = Buffer.concat([
      cipher.update(decode(parts[3], MAX_ASSET_CONTENT_BYTES)),
      cipher.final(),
    ]);
    const content = parse(plain);
    validateContent(content, publisherId, outer.format === FORMAT ? 1 : 2);
    return content;
  } catch (error) {
    if (error instanceof SecurityError) {
      throw error;
    }
    return fail();
  } finally {
    pek?.fill(0);
    plain?.fill(0);
  }
}
