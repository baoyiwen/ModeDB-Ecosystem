/** Synthetic listener fixture; only generated files, random loopback ports and software protection. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from '../../packages/server/node_modules/fastify/fastify.js';
import type { FastifyPluginCallback } from '../../packages/server/node_modules/fastify/fastify.js';
const {default:websocket}=await import(new URL('../../packages/server/node_modules/@fastify/websocket/index.js',import.meta.url).href) as {default:FastifyPluginCallback};
import { integrationFixture, SID } from './security-registration-integration.js';
import { SecurityNetworkPolicy } from '../../packages/server/src/security/network-policy.js';
import { SecurityProtection } from '../../packages/server/src/security/security-protection.js';
import { installSecurityNetworkBoundary } from '../../packages/server/src/security/network-boundary.js';
import { installRegistryEntrypoints } from '../../packages/server/src/security/registry-entrypoints.js';
import { dispatchLocalSecurity } from '../../packages/server/src/security/local-management-channel.js';
import { installHostedBoundary, installHostedAssets, hostedAssetPaths, loadHostedAssets } from '../../packages/server/src/security/browser-hosting.js';
import { startHostedManagement } from '../../packages/server/src/security/management-listener.js';
import { WriteSerializationGate } from '../../packages/server/src/write-serialization-gate.js';

export async function hostingFixture() {
  const f = await integrationFixture(), build = join(f.root,'public-build');
  mkdirSync(join(build,'assets'),{recursive:true});
  writeFileSync(join(build,'index.html'),'<!doctype html><html><head><script type="module" src="/assets/test.js"></script></head><body><main>synthetic public app</main></body></html>');
  writeFileSync(join(build,'assets','test.js'),'document.documentElement.dataset.loaded="true";');
  const assets=loadHostedAssets(build,[f.dir,join(f.root,'business')]);
  let data:ReturnType<typeof Fastify>, management:Awaited<ReturnType<typeof startHostedManagement>>, protection:SecurityProtection;
  let origin='', managementPort=0, dataPort=0, started=false;
  const start=async()=>{
    const network=new SecurityNetworkPolicy({}, {host:'127.0.0.1',port:dataPort,directory:f.root});
    network.setPairedOriginVerifier(value=>value===origin);
    protection=new SecurityProtection(f.registry,network,()=>f.now);
    const entrypoints:Omit<Parameters<typeof installRegistryEntrypoints>[0],'app'>={registry:f.registry,securityControl:{protection},dispatcher:{} as never,designerWorkspace:'synthetic_designer',workspace:join(f.root,'business'),writeGate:new WriteSerializationGate(),getEngine:async()=>{throw Error('DATA_HANDLER_UNREACHABLE');},listDatabases:()=>[],catalog:async()=>{throw Error('DATA_HANDLER_UNREACHABLE');}};
    data=Fastify({logger:false});
    installHostedBoundary(data,{role:'data',origin:()=>origin,assets:hostedAssetPaths(assets,'/designer/'),protection});
    installSecurityNetworkBoundary(data,network,protection);
    const paths=installHostedAssets(data,assets,'/designer/');await data.register(websocket);
    installRegistryEntrypoints({...entrypoints,app:data,network,listenerRole:'data',publicAssetPaths:paths});
    management=await startHostedManagement({port:managementPort,assets,entrypoints});
    managementPort=Number(new URL(management.origin).port);
    await data.listen({host:'127.0.0.1',port:dataPort});const address=data.server.address();if(!address||typeof address!=='object')throw Error();dataPort=address.port;origin='http://127.0.0.1:'+dataPort;started=true;
  };
  const closeListeners=async()=>{if(started){started=false;await management.app.close();await data.close();protection.close();}};
  await start();
  return {f,build,assets,get origin(){return origin;},get managementOrigin(){return management.origin;},
    launch:()=>f.registry.withLocalActor(SID,()=>dispatchLocalSecurity(f.registry,{action:'browser.hosted.security.launch'},[],undefined,()=>management.origin)) as {code:string;origin:string;url:string;expiresAt:string},
    async restart(){await closeListeners();await f.reopen();await start();},
    async close(){await closeListeners();await f.stop();},
  };
}
