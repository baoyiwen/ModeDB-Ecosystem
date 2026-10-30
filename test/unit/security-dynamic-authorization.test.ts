/** DR-P2.3: real software signatures, synthetic security storage and actual isolated engines. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import Fastify from '../../packages/server/node_modules/fastify/fastify.js';
import type websocketType from '../../packages/server/node_modules/@fastify/websocket/types/index.js';
import { AuthoringEngine } from '@mode-db/core';
import { securityReleaseDigest, interfaceParameterPlaceholder, type SecurityGrant, type WireExecuteBody } from '@mode-db/shared';
import { AuthorizationService } from '../../packages/server/src/security/authorization-service.js';
import { installRegistryEntrypoints } from '../../packages/server/src/security/registry-entrypoints.js';
import { WireRequestDispatcher } from '../../packages/server/src/request-dispatcher.js';
import { WriteSerializationGate } from '../../packages/server/src/write-serialization-gate.js';
import { SecurityError } from '../../packages/server/src/security/security-errors.js';
import type { AtomicCommitPoint } from '../../packages/common/src/atomic-file.js';
import { authenticationFixture } from '../fixtures/security-authentication.js';
import { origin, SID, syntheticProof } from '../fixtures/security-registration-integration.js';
import { DEVICE_REGISTRATION_API_V1 as REG } from '../../packages/shared/src/device-registration-contracts.js';
import { fixtureVaultKeys } from '../vault-keys.js';

const { WebSocket } = await import(new URL('../../packages/server/node_modules/ws/wrapper.mjs', import.meta.url).href) as typeof import('ws');
const { default: websocket } = await import(new URL('../../packages/server/node_modules/@fastify/websocket/index.js', import.meta.url).href) as {default: typeof websocketType};
const database = 'synthetic_business';
const full: SecurityGrant[] = [{database,resource:'*',actions:['model.read','model.write','transfer.import','schema.manage']}];
const read: SecurityGrant[] = [{database,resource:'*',actions:['model.read']}];
const insert: WireExecuteBody = {op:'insert',model:'Item',data:{name:'synthetic-created'},sync:true};
const query: WireExecuteBody = {op:'executeQuery',snapshot:{plan:{version:2,originModel:'Item',start:{kind:'all'},hops:[],trailing:{type:'atom',field:'name',op:'eq',value:'synthetic-original'}},execute:{},analysis:{groupBy:null,compute:null}}};
const queryRelease = {version:'1.0.0',callableName:'ListItems',signature:'synthetic',queryInterface:{status:'active',contract:{permissions:{mode:'none'},parameters:[]},query:{pagination:{mode:'none'}}},executionTemplate:{format:1,snapshot:query.op==='executeQuery'?query.snapshot:{},parameters:[],resultAdapter:{kind:'rows',rootNodeId:'item',fieldsByNode:{item:[{sourceField:'name',outputName:'label'}]},edgesBySource:{}},pagination:{mode:'none'}}};
const operationRelease = {version:'1.0.0',callableName:'CreateItem',signature:'synthetic',operationInterface:{status:'active',contract:{permissions:{mode:'none'}}},executionTemplate:{format:1,operation:insert,parameters:[],result:{returns:'summary'}}};
const surfaceRelease = {version:'1.0.0',publishedAt:'2026-10-27T00:00:00.000Z',signature:'synthetic',bindingSurface:{status:'active'},contract:{format:1,surfaceId:'Items',name:'Items',version:'1.0.0',parameters:[],query:{interfaceId:'query',callableName:'ListItems',version:'1.0.0',parameterBindings:[]},writeback:{mode:'explicit',refresh:'manual',mutations:[{id:'Create',trigger:{kind:'create',nodeId:'item'},operation:{interfaceId:'operation',callableName:'CreateItem',version:'1.0.0',operationType:'create'},parameterBindings:[]}]}}};
const pinned = (resource:string, action:'callable.query'|'callable.operation'|'callable.binding', release:unknown):SecurityGrant => ({database,resource,actions:[action],releaseDigest:securityReleaseDigest(release)});
const queryGrant = pinned('ListItems','callable.query',queryRelease);
const operationGrant = pinned('CreateItem','callable.operation',operationRelease);
const surfaceGrant = pinned('Items','callable.binding',surfaceRelease);

async function fixture(grants:readonly SecurityGrant[]=full, surface:unknown=surfaceRelease, onCommitPoint?: (point:AtomicCommitPoint)=>void) {
  const a = await authenticationFixture(-7,false,onCommitPoint,grants), {f}=a;
  const business = new AuthoringEngine({atlas:database,storageRoot:f.root,keyProvider:fixtureVaultKeys(f.root),engineLogger:false});
  const designer = new AuthoringEngine({atlas:'designer',storageRoot:f.root,keyProvider:fixtureVaultKeys(f.root),engineLogger:false});
  business.registerModel('Item',{name:'String'});
  await business.insert('Item',{name:'synthetic-original'},{sync:true});
  for(const [model,release] of [['sys_query_interface',queryRelease],['sys_operation_interface',operationRelease],['sys_binding_surface',surface]] as const) {
    designer.registerModel(model,{library_code:'String',surface_id:'String',release_json:'String',release_history_json:'String'});
    await designer.insert(model,{library_code:database,surface_id:'Items',release_json:JSON.stringify(release),release_history_json:''},{sync:true});
  }
  const gate = new WriteSerializationGate();
  let beforeEngine: (db:string)=>Promise<void> = async()=>{};
  let opened = 0;
  const getEngine = async(db:string) => {opened++;await beforeEngine(db);assert.ok([database,'designer'].includes(db));return db==='designer'?designer:business;};
  const dispatcher = new WireRequestDispatcher({dev:false,getEngine,writeGate:gate,designerWorkspace:'designer'});
  const app = Fastify({logger:false});await app.register(websocket);
  installRegistryEntrypoints({app,registry:f.registry,dispatcher,designerWorkspace:'designer',workspace:f.root,writeGate:gate,getEngine,listDatabases:()=>[{name:database,status:'active'}],catalog:async()=>{throw Error('UNUSED');}});
  await app.ready();
  const b=await a.begin(),login=await a.service.complete(a.assertion(b.response),b.ceremonySecret,a.context);
  const verified=f.registry.verifyBrowserSession(login.session,origin),id=verified.credential.id;
  const auth=()=>new AuthorizationService(()=>f.registry.verifySession(login.session),'designer');
  const restrict=(next:readonly SecurityGrant[])=>f.registry.withLocalActor(SID,()=>f.registry.restrictRegisteredCredential(f.registry.status().revision,id,next));
  const change=(mode:'disabled'|'revoked'|'user')=>{
    const next=f.registry.readRegistrationStorage(),key=next.credentials.find(k=>k.id===id)!;
    if(mode==='user'){const user=next.users.find(u=>u.id===key.userId)!;user.enabled=false;user.updatedAtUtc=new Date(f.now).toISOString();}
    else {key.state=mode;key.updatedAtUtc=new Date(f.now).toISOString();if(mode==='disabled')key.disabledAtUtc=key.updatedAtUtc;else key.revokedAtUtc=key.updatedAtUtc;}
    f.registry.commitRegistrationStorage(f.registry.status().revision,next);
  };
  const headers=(host='modeldb-a.example.test')=>({host,origin,'sec-fetch-site':'same-origin','x-modeldb-csrf':verified.csrf,cookie:`mdbs_session_${createHash('sha256').update(`${origin}|http://${host}`).digest('hex').slice(0,24)}=${login.session}`});
  const rpc=(body:WireExecuteBody,db=database)=>app.inject({url:'/api/v1/rpc',method:'POST',headers:headers(),payload:{version:1,database:db,operation:body}});
  return {a,f,business,designer,gate,dispatcher,app,login,verified,id,auth,restrict,change,rpc,headers,
    setBeforeEngine(fn:typeof beforeEngine){beforeEngine=fn;},get opened(){return opened;},
    async stream(token?:string){if(!app.server.listening)await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert.ok(address&&typeof address==='object');const host=`127.0.0.1:${address.port}`;const ws=new WebSocket(`ws://${host}/api/v1/stream`,{headers:headers(host)});await once(ws,'open');const ready=once(ws,'message');ws.send(JSON.stringify({version:1,type:'security.hello',database,...(token?{token}:{csrf:verified.csrf})}));const [data]=await ready;assert.equal(JSON.parse(String(data)).type,'security.ready');return ws;},
    async close(){await app.close();await business.flushAll();await designer.flushAll();await a.close();}
  };
}

test('public-key HTTP/RPC uses live own grants and rejects raw cross-database, relations, import and management escalation',async()=>{
  const x=await fixture(read);try{
    await x.dispatcher.executeAuthorized(database,query,x.auth());
    const allowed=await x.rpc(query);assert.equal(allowed.statusCode,200,allowed.body);
    for(const body of [insert,{op:'insertMany',model:'Item',rows:[{name:'forbidden'}]},{op:'delete',model:'Item',id:'absent'},{op:'registerModel',name:'Forbidden',fields:{}}] as WireExecuteBody[])assert.equal((await x.rpc(body)).statusCode,403);
    assert.equal((await x.rpc(query,'other')).statusCode,403);
    assert.equal((await x.app.inject({url:'/api/v1/security/admin/overview',headers:x.headers()})).statusCode,403);
    assert.equal(x.f.registry.listCredentials().length,0);
    x.restrict([]);assert.equal((await x.rpc(query)).statusCode,403);
    const event=x.f.registry.auditEvents().find(e=>e.action==='registration.credential.restrict');assert.equal(event?.resource?.credentialId,x.id);assert.equal(event?.actor.principalId,SID);
  }finally{await x.close();}
});

test('restriction is local-only, CAS checked, cannot add scopes/change a digest and ordinary storage cannot mutate grants',async()=>{
  const x=await fixture([queryGrant,...full]);try{
    const revision=x.f.registry.status().revision;
    assert.throws(()=>x.f.registry.restrictRegisteredCredential(revision,x.id,[]),{code:'SECURITY_LOCAL_IDENTITY_DENIED'});
    assert.throws(()=>x.f.registry.withLocalActor(SID,()=>x.f.registry.restrictRegisteredCredential(revision-1,x.id,[])),{code:'SECURITY_POLICY_CONFLICT'});
    for(const g of [[{...queryGrant,releaseDigest:'a'.repeat(64)}],[{database:'other',resource:'*',actions:['model.read']}],[{database,resource:'Item',actions:['model.read']}],[{...queryGrant,unexpected:true}]]) {
      assert.throws(()=>x.f.registry.withLocalActor(SID,()=>x.f.registry.restrictRegisteredCredential(revision,x.id,g)));
    }
    const next=x.f.registry.readRegistrationStorage();next.credentials[0].grants=[];
    assert.throws(()=>x.f.registry.commitRegistrationStorage(revision,next));
    assert.equal(x.f.registry.status().revision,revision);
    x.restrict(read);assert.deepEqual(x.f.registry.verifySession(x.login.session).credential.grants,read);
  }finally{await x.close();}
});

test('credential subscriptions isolate a key while user invalidation fans out to every key for that user',async()=>{
  const x=await fixture();try{
    const b=await x.f.begin();const result=await x.f.post(REG.complete,syntheticProof(x.f.instanceId,b));assert.equal(result.statusCode,202);
    const decision=x.f.decision(b.registrationId);delete (decision as {name?:string}).name;
    x.f.local({...decision,principalId:x.verified.credential.principalId});
    const sibling=x.f.registry.readRegistrationStorage().credentials.find(k=>k.id!==x.id)!;
    assert.equal(sibling.userId,x.f.registry.readRegistrationStorage().credentials[0].userId);
    const hits:string[]=[];
    const off=x.f.registry.onInvalidation(()=>hits.push('key'),x.id),offSibling=x.f.registry.onInvalidation(()=>hits.push('sibling'),sibling.id),offOther=x.f.registry.onInvalidation(()=>hits.push('other'),'synthetic-other-id');
    x.restrict(read);assert.deepEqual(hits,['key']);hits.length=0;
    x.change('user');assert.deepEqual(hits.sort(),['key','sibling']);
    off();offSibling();offOther();
    assert.throws(()=>x.f.registry.verifySession(x.login.session),{code:'SECURITY_CREDENTIAL_REVOKED'});
  }finally{await x.close();}
});

for(const mode of ['disabled','revoked','user'] as const)test(`durable ${mode} invalidates HTTP, new login, refresh and remains denied after reopen`,async()=>{
  const x=await fixture();try{
    const policy=x.f.registry.status().policyVersion;x.change(mode);assert.equal(x.f.registry.status().policyVersion,policy+1);
    assert.equal((await x.rpc(query)).statusCode,401);
    assert.throws(()=>x.f.registry.rotateSession(x.login.session),{code:'SECURITY_CREDENTIAL_REVOKED'});
    const b=await x.a.begin();await assert.rejects(()=>x.a.service.complete(x.a.assertion(b.response,2),b.ceremonySecret,x.a.context),{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'});
    await x.a.reopen();assert.throws(()=>x.f.registry.verifySession(x.login.session),{code:'SECURITY_CREDENTIAL_REVOKED'});
  }finally{await x.close();}
});

for(const mode of ['restrict','disabled','revoked','user'] as const)test(`idle public-key WS closes on ${mode} without receiving another message`,async()=>{
  const x=await fixture();try{const ws=await x.stream(),closed=once(ws,'close');if(mode==='restrict')x.restrict(read);else x.change(mode);const [code]=await closed;assert.equal(code,1008);}finally{await x.close();}
});

test('idle public-key WS expires on the server deadline without a client message',async()=>{
  const x=await fixture();try{x.f.advance(30*60000-60);const ws=await x.stream(),closed=once(ws,'close');x.f.advance(61);const [code]=await closed;assert.equal(code,1008);}finally{await x.close();}
});

test('registry failure closes streams and denies the restriction; reopening preserves the last durable grant set',async()=>{
  const x=await fixture();try{const ws=await x.stream(),closed=once(ws,'close');x.f.fail(true);assert.throws(()=>x.restrict(read),{code:'SECURITY_STORE_WRITE_FAILED'});await closed;await x.a.reopen();assert.deepEqual(x.f.registry.verifySession(x.login.session).credential.grants,full);assert.ok(!x.f.registry.auditEvents().some(e=>e.action==='registration.credential.restrict'));}finally{await x.close();}
});

for(const kind of ['raw','operation','binding'] as const)test(`queued ${kind} write rechecks before opening an engine`,async()=>{
  const grants=kind==='raw'?full:[operationGrant,surfaceGrant];const x=await fixture(grants);
  try{
    let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r);
    const block=x.gate.runExclusive(database,()=>new Promise<void>(r=>{release=r;started();}));await ready;
    const body:WireExecuteBody=kind==='raw'?insert:kind==='operation'?{op:'executeOperationInterface',callableName:'CreateItem'}:{op:'executeBindingSurface',surfaceId:'Items',action:{kind:'mutate',mutationId:'Create'}};
    const pending=x.dispatcher.executeAuthorized(database,body,x.auth());const denied=assert.rejects(pending,{code:'SECURITY_FORBIDDEN'});
    x.restrict([]);const before=x.opened;release();await block;await denied;assert.equal(x.opened,before);assert.equal((await x.business.persistence.getMergedReader().getAll('Item')).length,1);
  }finally{await x.close();}
});

test('engine-await and asynchronous authorization microtask cannot preserve a removed write capability',async()=>{
  for(const point of ['engine','authorization'] as const){const x=await fixture();try{
    if(point==='engine')x.setBeforeEngine(async()=>{x.restrict(read);});
    const auth=x.auth(),operation=auth.operation.bind(auth);
    if(point==='authorization')auth.operation=async(...args)=>{const check=await operation(...args);queueMicrotask(()=>x.restrict(read));return check;};
    await assert.rejects(()=>x.dispatcher.executeAuthorized(database,insert,auth),{code:'SECURITY_FORBIDDEN'});
    assert.equal((await x.business.persistence.getMergedReader().getAll('Item')).length,1);
  }finally{await x.close();}}
});

for(const kind of ['query','operation','binding-read','binding-write'] as const)test(`published ${kind} rechecks exact release and parent after child engine waits`,async()=>{
  const x=await fixture([queryGrant,operationGrant,surfaceGrant]);try{
    let triggered=false;x.setBeforeEngine(async(db)=>{if(db===database&&!triggered){triggered=true;x.restrict(kind.startsWith('binding')?[queryGrant,operationGrant]:[surfaceGrant]);}});
    const body:WireExecuteBody=kind==='query'?{op:'executeInterface',callableName:'ListItems'}:kind==='operation'?{op:'executeOperationInterface',callableName:'CreateItem'}:{op:'executeBindingSurface',surfaceId:'Items',action:kind==='binding-read'?{kind:'read'}:{kind:'mutate',mutationId:'Create'}};
    assert.equal((await x.rpc(body)).statusCode,403);
    assert.equal((await x.business.persistence.getMergedReader().getAll('Item')).length,1);
  }finally{await x.close();}
});

test('publication batch rechecks every earlier business scope after all metadata awaits',async()=>{
  const designerGrant:SecurityGrant={database:'designer',resource:'*',actions:['model.read','model.write','schema.manage']};
  const other:SecurityGrant={database:'other',resource:'*',actions:['model.read','schema.manage']};
  const x=await fixture([...full,designerGrant,other]);try{
    const reader=x.designer.persistence.getMergedReader(),getAll=reader.getAll.bind(reader);let calls=0;
    reader.getAll=async(...args)=>{const rows=await getAll(...args);if(++calls===2)x.restrict([designerGrant,other]);return rows;};
    const row=(await getAll('sys_query_interface'))[0];
    const body:WireExecuteBody={op:'batchUpdate',updates:[{model:'sys_query_interface',id:row._id,partial:{library_code:database}},{model:'sys_query_interface',id:row._id,partial:{library_code:'other'}}]};
    await assert.rejects(()=>x.dispatcher.executeAuthorized('designer',body,x.auth()),{code:'SECURITY_FORBIDDEN'});
    reader.getAll=getAll;assert.equal((await getAll('sys_query_interface'))[0].library_code,database);
  }finally{await x.close();}
});

for(const throughSurface of [false,true])test(`published batch preserves first commit and rejects later items after ${throughSurface?'parent surface':'operation'} scope removal`,async()=>{
  const batchRelease={...operationRelease,executionTemplate:{...operationRelease.executionTemplate,operation:{...insert,data:{name:interfaceParameterPlaceholder('name')}},parameters:[{id:'name',name:'name',type:'string',required:true}],batch:{itemsParameter:'items',maxItems:10,failureMode:'continue'},transaction:{mode:'batch',rollbackOnFailure:false},result:{returns:'summary',includeItemResults:true}}};
  const batchGrant=pinned('CreateItem','callable.operation',batchRelease);
  const surface=structuredClone(surfaceRelease);
  surface.contract.writeback.mutations[0].parameterBindings=[{parameterId:'items',source:{kind:'literal',value:[{name:'first'},{name:'second'},{name:'third'}]}}] as never;
  const parentGrant=pinned('Items','callable.binding',surface);
  const x=await fixture([batchGrant,parentGrant],surface);try{
    const row=(await x.designer.persistence.getMergedReader().getAll('sys_operation_interface'))[0];await x.designer.update('sys_operation_interface',row._id,{release_json:JSON.stringify(batchRelease)},{sync:true});
    const original=x.business.insert.bind(x.business);let n=0;
    x.business.insert=async(...args)=>{const result=await original(...args);if(++n===1)x.restrict(throughSurface?[batchGrant]:[]);return result;};
    const body:WireExecuteBody=throughSurface?{op:'executeBindingSurface',surfaceId:'Items',action:{kind:'mutate',mutationId:'Create'}}:{op:'executeOperationInterface',callableName:'CreateItem',parameters:{items:[{name:'first'},{name:'second'},{name:'third'}]}};
    const response=await x.rpc(body);assert.equal(response.statusCode,200,response.body);
    const output=throughSurface?response.json().result.mutation.result.output:response.json().result.output;
    assert.equal(output.status,'partial');assert.equal(output.successCount,1);assert.equal(output.failureCount,2);assert.equal(output.items[1].error.code,'SECURITY_FORBIDDEN');
    assert.equal((await x.business.persistence.getMergedReader().getAll('Item')).length,2);
  }finally{await x.close();}
});

test('already committed single write remains successful after in-flight revocation with a durable success audit',async()=>{
  const x=await fixture();try{const original=x.business.insert.bind(x.business);x.business.insert=async(...args)=>{const row=await original(...args);x.change('revoked');return row;};const result=await x.rpc(insert);assert.equal(result.statusCode,200,result.body);assert.equal((await x.business.persistence.getMergedReader().getAll('Item')).length,2);assert.ok(x.f.registry.auditEvents().some(e=>e.action==='data.execute'&&e.result==='succeeded'));assert.equal((await x.rpc(insert)).statusCode,401);}finally{await x.close();}
});

test('permission reduction persists across reopen and signing counter updates do not invalidate streams',async()=>{
  const x=await fixture();try{
    const ws=await x.stream();const policy=x.f.registry.status().policyVersion;
    const b=await x.a.begin();await x.a.service.complete(x.a.assertion(b.response,2),b.ceremonySecret,x.a.context);
    assert.equal(x.f.registry.status().policyVersion,policy);assert.equal(ws.readyState,1);
    const closed=once(ws,'close');x.restrict(read);await closed;
    await x.a.reopen();assert.deepEqual(x.f.registry.verifySession(x.login.session).credential.grants,read);
  }finally{await x.close();}
});

for(const mode of ['disabled','user'] as const)test(`re-enabling ${mode} requires a new login and never revives an existing session`,async()=>{
  const x=await fixture();try{
    x.change(mode);const next=x.f.registry.readRegistrationStorage();
    if(mode==='user'){next.users[0].enabled=true;next.users[0].updatedAtUtc=new Date(x.f.now).toISOString();}
    else{next.credentials[0].state='active';delete next.credentials[0].disabledAtUtc;next.credentials[0].updatedAtUtc=new Date(x.f.now).toISOString();}
    x.f.registry.commitRegistrationStorage(x.f.registry.status().revision,next);
    assert.throws(()=>x.f.registry.verifySession(x.login.session),{code:'SECURITY_CREDENTIAL_REVOKED'});
    const b=await x.a.begin(),login=await x.a.service.complete(x.a.assertion(b.response,2),b.ceremonySecret,x.a.context);x.f.registry.verifySession(login.session);
  }finally{await x.close();}
});

test('a registered key change leaves a sibling API stream and its independent session usable',async()=>{
  const x=await fixture();try{
    const api=x.f.registry.createCredential(x.verified.credential.principalId,'synthetic sibling API',read);
    const session=x.f.registry.createSession(api.token),ws=await x.stream(api.token);
    x.change('disabled');assert.equal(ws.readyState,1);x.f.registry.authenticate(api.token);x.f.registry.verifySession(session.session);
    const message=once(ws,'message');ws.send(JSON.stringify({version:1,type:'security.rpc',id:'query',operation:query}));const [data]=await message;assert.equal(JSON.parse(String(data)).type,'security.result');ws.close();await once(ws,'close');
  }finally{await x.close();}
});

test('queued WS mutation is rejected after revocation and its socket closes before another operation',async()=>{
  const x=await fixture();try{
    const ws=await x.stream();let release!:()=>void,held!:()=>void,enqueued!:()=>void;
    const ready=new Promise<void>(r=>held=r),queued=new Promise<void>(r=>enqueued=r);
    const block=x.gate.runExclusive(database,()=>new Promise<void>(r=>{release=r;held();}));await ready;
    const execute=x.dispatcher.executeAuthorized.bind(x.dispatcher);x.dispatcher.executeAuthorized=(...args)=>{const result=execute(...args);enqueued();return result;};
    ws.send(JSON.stringify({version:1,type:'security.rpc',id:'write',operation:insert}));await queued;
    const closed=once(ws,'close');x.change('revoked');await closed;release();await block;
    // The next gate entry waits until the denied RPC has left the queue.
    await x.gate.runExclusive(database,async()=>{});
    assert.equal((await x.business.persistence.getMergedReader().getAll('Item')).length,1);
  }finally{await x.close();}
});

for(const callable of [false,true])test(`${callable?'published':'raw'} query withholds results revoked during asynchronous execution`,async()=>{
  const x=await fixture(callable?[queryGrant]:read);try{
    const create=x.business.createRuntime.bind(x.business);x.business.createRuntime=(...args)=>{queueMicrotask(()=>x.restrict([]));return create(...args);};
    const response=await x.rpc(callable?{op:'executeInterface',callableName:'ListItems'}:query);assert.equal(response.statusCode,403);assert.ok(!response.body.includes('synthetic-original'));
  }finally{await x.close();}
});

test('binding read checks both pins after its asynchronous call log, while completed mutation keeps refreshFailed',async()=>{
  const x=await fixture([surfaceGrant,queryGrant]);try{
    let hits=0;x.setBeforeEngine(async(db)=>{if(db==='designer'&&++hits===4)x.restrict([surfaceGrant]);});
    const result=await x.rpc({op:'executeBindingSurface',surfaceId:'Items',action:{kind:'read'}});assert.equal(result.statusCode,403,result.body);assert.ok(!result.body.includes('synthetic-original'));
  }finally{await x.close();}
  const surface=structuredClone(surfaceRelease);surface.contract.writeback.refresh='afterMutation';
  const y=await fixture([pinned('Items','callable.binding',surface),queryGrant,operationGrant],surface);
  try{
    const original=y.business.insert.bind(y.business);y.business.insert=async(...args)=>{const row=await original(...args);y.restrict([operationGrant]);return row;};
    const result=await y.rpc({op:'executeBindingSurface',surfaceId:'Items',action:{kind:'mutate',mutationId:'Create'}});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().result.status,'refreshFailed');assert.ok(result.json().result.mutation);assert.equal((await y.business.persistence.getMergedReader().getAll('Item')).length,2);
  }finally{await y.close();}
});

test('public-key callable HTTP route pins its release and cannot inherit raw or child grants',async()=>{
  const x=await fixture([queryGrant]);try{
    const url=`/api/v1/databases/${database}/query-interfaces/ListItems`;
    const result=await x.app.inject({url,method:'POST',headers:x.headers(),payload:{parameters:{}}});assert.equal(result.statusCode,200,result.body);
    const row=(await x.designer.persistence.getMergedReader().getAll('sys_query_interface'))[0];await x.designer.update('sys_query_interface',row._id,{release_json:JSON.stringify({...queryRelease,signature:'changed'})},{sync:true});
    const denied=await x.app.inject({url,method:'POST',headers:x.headers(),payload:{parameters:{}}});assert.equal(denied.statusCode,403);assert.equal(denied.json().error,'SECURITY_RELEASE_SCOPE_CHANGED');assert.equal((await x.rpc(query)).statusCode,403);
  }finally{await x.close();}
});

test('public-key relation and bulk writes require live whole-database write/import scopes',async()=>{
  const x=await fixture();try{
    x.business.registerModel('Other',{name:'String'});x.business.registerRelation('Item','Other','others','items','many-to-many');
    const item=(await x.business.persistence.getMergedReader().getAll('Item'))[0],other=await x.business.insert('Other',{name:'synthetic-other'},{sync:true});
    const body:WireExecuteBody={op:'bindPair',source:{model:'Item',id:item._id},target:{model:'Other',id:other._id},forward:'others',reverse:'items'};
    assert.equal((await x.rpc(body)).statusCode,200);x.restrict(read);
    for(const denied of [body,{op:'unlinkPair',source:{model:'Item',id:item._id},target:{model:'Other',id:other._id},forward:'others',reverse:'items'},{op:'delete',model:'Item',id:item._id},{op:'insertMany',model:'Item',rows:[{name:'denied'}]}] as WireExecuteBody[])assert.equal((await x.rpc(denied)).statusCode,403);
    assert.equal((await x.business.persistence.getMergedReader().getAll('Item')).length,1);
  }finally{await x.close();}
});

test('audit failures reject before execution and report uncertainty after a committed public-key write',async()=>{
  const x=await fixture();try{
    const record=x.f.registry.recordAccess.bind(x.f.registry);x.f.registry.recordAccess=()=>{throw new SecurityError('SECURITY_AUDIT_CAPACITY');};
    assert.equal((await x.rpc(insert)).statusCode,503);assert.equal((await x.business.persistence.getMergedReader().getAll('Item')).length,1);
    x.f.registry.recordAccess=(...args)=>{if(args[2]==='succeeded')throw new SecurityError('SECURITY_AUDIT_CAPACITY');record(...args);};
    const result=await x.rpc(insert);assert.equal(result.statusCode,503);assert.equal(result.json().error,'SECURITY_OUTCOME_UNCONFIRMED');assert.equal((await x.business.persistence.getMergedReader().getAll('Item')).length,2);
  }finally{await x.close();}
});

for(const point of ['staged','journaled','replaced'] as const)test(`restriction ${point} failure closes the writer and recovers one atomic grant/audit outcome`,async()=>{
  let armed=false;
  const x=await fixture(full,surfaceRelease,(p)=>{if(armed&&p===point)throw Error('SYNTHETIC_DYNAMIC_FAULT');});
  try{armed=true;assert.throws(()=>x.restrict(read),{code:'SECURITY_STORE_WRITE_FAILED'});assert.throws(()=>x.f.registry.verifySession(x.login.session),{code:'SECURITY_CLOSED'});await x.a.reopen();const committed=point!=='staged';assert.deepEqual(x.f.registry.verifySession(x.login.session).credential.grants,committed?read:full);assert.equal(x.f.registry.auditEvents().filter(e=>e.action==='registration.credential.restrict').length,committed?1:0);}finally{armed=false;await x.close();}
});

for(const kind of ['batchUpdate','batchDelete'] as const)test(`raw ${kind} rechecks each independent item and reports committed partial counts`,async()=>{
  const x=await fixture();try{
    const first=(await x.business.persistence.getMergedReader().getAll('Item'))[0],second=await x.business.insert('Item',{name:'second'},{sync:true});
    if(kind==='batchUpdate'){const update=x.business.update.bind(x.business);let n=0;x.business.update=async(...args)=>{const row=await update(...args);if(++n===1)x.restrict(read);return row;};}
    else{const remove=x.business.delete.bind(x.business);let n=0;x.business.delete=async(...args)=>{const result=await remove(...args);if(++n===1)x.restrict(read);return result;};}
    const body:WireExecuteBody=kind==='batchUpdate'?{op:kind,updates:[first,second].map(r=>({model:'Item',id:r._id,partial:{name:'updated'}}))}:{op:kind,deletes:[first,second].map(r=>({model:'Item',id:r._id}))};
    const result=await x.rpc(body);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().result.successCount,1);assert.equal(result.json().result.failureCount,1);
    const rows=await x.business.persistence.getMergedReader().getAll('Item');assert.equal(rows.find(r=>r._id===second._id)?.name,'second');if(kind==='batchDelete')assert.equal(rows.length,1);
  }finally{await x.close();}
});

for(const lookup of [false,true])test(`relation ${lookup?'import lookup':'pair'} rechecks after asynchronous index preparation and before first mutation`,async()=>{
  const x=await fixture();try{
    x.business.registerModel('Other',{name:'String'});x.business.registerRelation('Item','Other','others','items','many-to-many');
    const item=(await x.business.persistence.getMergedReader().getAll('Item'))[0],other=await x.business.insert('Other',{name:'match'},{sync:true});
    if(lookup){const reader=x.business.persistence.getMergedReader(),getAll=reader.getAll.bind(reader);reader.getAll=async(...args)=>{const rows=await getAll(...args);x.restrict(read);return rows;};}
    else{const get=x.business.indexer.getForward.bind(x.business.indexer);x.business.indexer.getForward=async(...args)=>{const ids=await get(...args);x.restrict(read);return ids;};}
    const body:WireExecuteBody=lookup?{op:'bindImportLookup',forward:'others',reverse:'items',importModel:'Item',peerModel:'Other',peerMatchField:'name',pairs:[{importedId:item._id,lookupValue:'match'}]}:{op:'bindPair',source:{model:'Item',id:item._id},target:{model:'Other',id:other._id},forward:'others',reverse:'items'};
    assert.equal((await x.rpc(body)).statusCode,403);
    const relation=x.business.registry.getRelations().find(r=>r.forward==='others')!;assert.equal((await x.business.indexer.getStats(relation)).totalLinks,0);
  }finally{await x.close();}
});
