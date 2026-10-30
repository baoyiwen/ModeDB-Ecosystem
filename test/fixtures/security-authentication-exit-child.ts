/** Test-only hard-exit worker. All inputs are synthetic, private IPC/stdin, never CLI/logs. */
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyAuthenticationResponse } from '../../packages/server/node_modules/@simplewebauthn/server/esm/index.js';
import { AuthenticationService } from '../../packages/server/src/security/authentication-service.js';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { dispatchLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { SID, syntheticProtector } from './security-registration-integration.js';
import type { DeviceRegistrationConnectionDescriptorV1 } from '../../packages/shared/src/device-registration-contracts.js';

export interface ExitInput {
  directory: string;
  key: string;
  now: number;
  point: string;
  operation: string;
  descriptor: DeviceRegistrationConnectionDescriptorV1;
  binding?: unknown;
  session?: string;
  request?: unknown;
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8')) as ExitInput;
  const directory = realpathSync(input.directory), parent = dirname(directory);
  const rel = relative(realpathSync(tmpdir()), parent);
  if (isAbsolute(rel) || rel.startsWith('..') || !basename(parent).startsWith('ModeDB-Registration-Integration-') || basename(directory) !== 'security' || !['staged', 'journaled', 'replaced'].includes(input.point)) throw Error();
  const key = Buffer.from(input.key, 'base64');
  if (key.length !== 32 || !Number.isFinite(input.now)) throw Error();
  let armed = false;
  const registry = SecurityRegistry.open(directory, { protector: syntheticProtector(key), now: () => input.now, onCommitPoint(point) { if (armed && point === input.point) process.exit(86); } });
  if (input.operation === 'login' || input.operation === 'claim') {
    const service = new AuthenticationService(registry, {enabled: true}, input.descriptor, () => input.now, async options => {
      const proof = await verifyAuthenticationResponse(options);
      armed = true;
      return proof;
    });
    const context = {source: {peerIp: '127.0.0.1', clientIp: '192.0.2.10', clientIpBasis: 'trusted-proxy' as const, secure: true}, requestId: 'synthetic-hard-exit', recheck() {}};
    const challenge = await service.begin(input.binding, context);
    const assertion = new Promise<unknown>(resolve => process.once('message', resolve));
    process.send?.({response: challenge.response, ceremonySecret: challenge.ceremonySecret});
    const proof = await assertion;
    if (input.operation === 'claim') armed = true;
    await service.complete(proof, challenge.ceremonySecret, context);
  } else {
    armed = true;
    if (input.operation === 'refresh') registry.rotateSession(input.session!);
    else if (input.operation === 'logout') registry.revokeSession(input.session!);
    else if (input.operation === 'migrate') registry.migrateAuthenticationStorage(registry.status().revision);
    else if (input.operation.startsWith('registration.')) registry.withLocalActor(SID, () => dispatchLocalSecurity(registry, input.request));
    else throw Error();
  }
  registry.close();
  process.exitCode = 1;
} catch {
  process.stderr.write('SYNTHETIC_EXIT_CHILD_FAILED\n');
  process.exitCode = 1;
}
