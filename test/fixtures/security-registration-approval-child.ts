/** Hard-exit fixture: only parent-created synthetic input is accepted through stdin. */
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, relative, isAbsolute } from 'node:path';
import { SecurityRegistry } from '../../packages/server/src/security/security-registry.js';
import { dispatchLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { syntheticProtector, SID } from './security-registration-integration.js';

try {
  const input=JSON.parse(readFileSync(0,'utf8')) as {directory:string;key:string;now:number;point:string;request:unknown};
  const directory=realpathSync(input.directory),parent=dirname(directory),rel=relative(realpathSync(tmpdir()),parent);
  if(isAbsolute(rel)||rel.startsWith('..')||!basename(parent).startsWith('ModeDB-Registration-Integration-')||basename(directory)!=='security'||!['staged','journaled','replaced'].includes(input.point))throw Error();
  const key=Buffer.from(input.key,'base64');if(key.length!==32||!Number.isFinite(input.now))throw Error();
  const registry=SecurityRegistry.open(directory,{protector:syntheticProtector(key),now:()=>input.now,onCommitPoint(point){if(point===input.point)process.exit(86);}});
  registry.withLocalActor(SID,()=>dispatchLocalSecurity(registry,input.request));
  registry.close();process.exitCode=1;
} catch { process.stderr.write('SYNTHETIC_CHILD_FAILED\n');process.exitCode=1; }
