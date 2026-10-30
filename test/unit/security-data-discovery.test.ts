/** Synthetic proxy/socket evidence only; no actual LAN, hardware or live instance. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from '../../packages/server/node_modules/fastify/fastify.js';
import type websocketType from '../../packages/server/node_modules/@fastify/websocket/types/index.js';
import { RemoteModelDBClient } from '../../packages/sdk/src/remote-client.js';
import { installRegistryEntrypoints } from '../../packages/server/src/security/registry-entrypoints.js';
import { installSecurityNetworkBoundary } from '../../packages/server/src/security/network-boundary.js';
import { SecurityNetworkPolicy } from '../../packages/server/src/security/network-policy.js';
import { authenticationFixture } from '../fixtures/security-authentication.js';
import { origin, SID } from '../fixtures/security-registration-integration.js';
import { createHash } from 'node:crypto';
import type { SecurityGrant } from '@mode-db/shared';

const {default:websocket}=await import(new URL('../../packages/server/node_modules/@fastify/websocket/index.js',import.meta.url).href) as {default:typeof websocketType};
const grants: SecurityGrant[] = [
  {database:'synthetic_business',resource:'*',actions:['model.read']},
  {database:'backup_only',resource:'*',actions:['backup.manage']},
  {database:'callable_only',resource:'Published',actions:['callable.query'],releaseDigest:'a'.repeat(64)},
];
async function fixture() {
  const a=await authenticationFixture(-7,false,undefined,grants),f=a.f;
  const app=Fastify({logger:false});await app.register(websocket);
  const network=new SecurityNetworkPolicy({transport:{mode:'proxy',trustedProxies:['127.0.0.1/32']},data:{allowListEnabled:true,allow:[{id:'synthetic-client',source:'192.0.2.10',reason:'Synthetic source'}]}},{host:'127.0.0.1',port:0,publicBaseUrl:origin,directory:f.root});
  installSecurityNetworkBoundary(app,network);
  let opened=0,beforeCatalog:()=>Promise<void>=async()=>{};
  const metadata={database:'synthetic_business',displayName:{zh:'合成库'},models:[{name:'Item',parentId:null,fields:['label'],fieldLabels:{label:{zh:'标签'}},fieldTypes:{label:'String'}}],relations:[{forward:'peer',reverse:'peerOf',source:'Item',target:'Item',selfLoopPolicy:'deny' as const}]};
  installRegistryEntrypoints({app,registry:f.registry,network,listenerRole:'data',dispatcher:{} as never,designerWorkspace:'designer',workspace:f.root,writeGate:{} as never,
    getEngine:async()=>{opened++;return {registry:{getModelDefinitions:()=>[]}} as never;},
    listDatabases:()=>['synthetic_business','hidden','backup_only','callable_only'].map(name=>({name,status:'active' as const})),
    catalog:async()=>{await beforeCatalog();return metadata;},
  });
  const b=await a.begin(),login=await a.service.complete(a.assertion(b.response),b.ceremonySecret,a.context);
  const verified=f.registry.verifyBrowserSession(login.session,origin),id=verified.credential.id;
  const headers={host:'modeldb-a.example.test',origin,'x-forwarded-proto':'https','x-forwarded-for':'192.0.2.10',cookie:`mdbs_session_${createHash('sha256').update(origin+'|https://modeldb-a.example.test').digest('hex').slice(0,24)}=${login.session}`};
  const request=(url:string,method:'GET'|'POST'|'DELETE'='GET',anonymous=false)=>app.inject({url,method,headers:anonymous?{...headers,cookie:''}:headers});
  return {a,f,app,request,metadata,get opened(){return opened;},beforeCatalog(fn:typeof beforeCatalog){beforeCatalog=fn;},
    restrict:()=>f.registry.withLocalActor(SID,()=>f.registry.restrictRegisteredCredential(f.registry.status().revision,id,[])),
    disable:()=>f.local({action:'registration.credential.disable',instanceId:f.instanceId,id,revision:f.registry.status().revision,confirm:true}),
    async close(){await app.close();await a.close();}};
}
test('data discovery admits an authenticated data-only source while all management paths remain denied',async()=>{
  const x=await fixture();try{
    const list=await x.request('/api/v1/databases');assert.equal(list.statusCode,200,list.body);assert.equal(list.headers['cache-control'],'no-store');assert.deepEqual(list.json().databases.map((d:{name:string})=>d.name),['synthetic_business']);
    const catalog=await x.request('/api/v1/databases/synthetic_business/catalog');assert.equal(catalog.statusCode,200,catalog.body);assert.deepEqual(catalog.json(),x.metadata);
    for(const [method,url] of [['GET','/api/v1/management/databases'],['GET','/api/v1/management/databases/synthetic_business/catalog'],['POST','/api/v1/management/databases'],['DELETE','/api/v1/management/databases/synthetic_business'],['POST','/api/v1/management/databases/synthetic_business/clear'],['POST','/api/v1/management/databases/synthetic_business/backup'],['GET','/api/v1/security/admin/overview']] as const){const r=await x.request(url,method);assert.equal(r.statusCode,403);assert.equal(r.json().error,'SECURITY_SOURCE_DENIED');}
  }finally{await x.close();}
});
test('discovery refuses anonymous and ungranted reads before opening a database; data aliases cannot mutate',async()=>{
  const x=await fixture();try{
    assert.equal((await x.request('/api/v1/databases','GET',true)).statusCode,401);
    assert.equal((await x.request('/api/v1/databases/synthetic_business/catalog','GET',true)).statusCode,401);
    for(const db of ['hidden','absent','backup_only','callable_only'])assert.equal((await x.request('/api/v1/databases/'+db+'/catalog')).statusCode,403);
    assert.equal(x.opened,0);
    for(const url of ['/api/v1/databases','/api/v1/databases/synthetic_business/catalog','/api/v1/databases/synthetic_business/clear'])assert.equal((await x.request(url,'POST')).statusCode,403);
    x.disable();assert.equal((await x.request('/api/v1/databases')).statusCode,401);assert.equal((await x.request('/api/v1/databases/synthetic_business/catalog')).statusCode,401);
  }finally{await x.close();}
});
test('catalog rechecks grants and credential state after awaited metadata loading',async()=>{
  for(const mode of ['restrict','disable'] as const){
    const x=await fixture();try{
      x.beforeCatalog(async()=>{x[mode]();});
      const r=await x.request('/api/v1/databases/synthetic_business/catalog');assert.equal(r.statusCode,mode==='restrict'?403:401);assert.equal(r.body.includes('合成库'),false);
      const list=await x.request('/api/v1/databases');assert.equal(list.statusCode,mode==='restrict'?200:401);if(mode==='restrict')assert.deepEqual(list.json().databases,[]);
    }finally{await x.close();}
  }
});
test('SDK selects data discovery for registry credentials and retains legacy paths without denial fallback',async()=>{
  const original=globalThis.fetch,paths:string[]=[];
  try{
    globalThis.fetch=async(input)=>{const url=new URL(String(input));paths.push(url.pathname);return Response.json(url.pathname.endsWith('/catalog')?{database:'synthetic_business',models:[],relations:[]}:{databases:[]});};
    for(const token of ['mdbt_v1_synthetic','legacy-synthetic']){
      const opts={host:'https://modeldb-a.example.test',port:443,token};
      await RemoteModelDBClient.listDatabases(opts);await RemoteModelDBClient.getDatabaseCatalog({...opts,database:'synthetic_business'});
    }
    assert.deepEqual(paths,['/api/v1/databases','/api/v1/databases/synthetic_business/catalog','/api/v1/management/databases','/api/v1/management/databases/synthetic_business/catalog']);
    paths.length=0;globalThis.fetch=async(input)=>{paths.push(new URL(String(input)).pathname);return Response.json({error:'SECURITY_FORBIDDEN'},{status:403});};
    await assert.rejects(()=>RemoteModelDBClient.listDatabases({host:'https://modeldb-a.example.test',port:443,token:'mdbt_v1_synthetic'}));assert.deepEqual(paths,['/api/v1/databases']);
  }finally{globalThis.fetch=original;}
});
