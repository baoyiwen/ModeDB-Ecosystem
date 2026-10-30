import {createBrowserIdentityClient} from '../../packages/sdk/src/browser-identity-client.js';
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {getBrowserPublicKeyContext, getBrowserRegistrationDescriptor, parseBrowserRegistrationDescriptor, registerBrowserCredential} from '../../packages/sdk/src/browser-registration.js';
import {browserIdentityIssue} from '../../apps/model-designer/src/config/browser-identity-state.js';
import {authenticationFixture} from '../fixtures/security-authentication.js';
import {integrationFixture, origin, syntheticProof} from '../fixtures/security-registration-integration.js';
import type {DeviceRegistrationBeginResponseV1} from '@mode-db/shared';

async function client(t: TestContext) {
  const f = await integrationFixture();
  t.mock.method(Date, 'now', () => f.now);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {configurable: true, value: {origin}});
  t.after(async () => { if(saved) Object.defineProperty(globalThis,'location',saved); else Reflect.deleteProperty(globalThis,'location'); await f.stop(); });
  let begin: DeviceRegistrationBeginResponseV1;
  const requests: Array<{url: string; init?: RequestInit}> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url=String(input); requests.push({url,init});
    assert.equal(new URL(url).origin, origin);
    assert.equal(init?.credentials, 'omit');assert.equal(init?.redirect, 'error');assert.equal(init?.cache, 'no-store');
    if(url.endsWith('/authentication/v1/capabilities')) return Response.json({format:'modeldb.device-authentication.v1',version:1,instanceId:f.instanceId,mode:'enabled',userVerification:'required',deployment:{serverOrigin:origin,rpId:f.descriptor.rpId,deploymentDescriptorSha256:'a'.repeat(64)}});
    if(url.endsWith('/capabilities')) return Response.json(f.service.capabilities());
    if(url.endsWith('/connection')) return Response.json(f.service.connection());
    const r=await f.post(new URL(url).pathname,JSON.parse(String(init?.body)));
    if(url.endsWith('/begin')) begin=r.json();
    return new Response(r.body,{status:r.statusCode,headers:{'content-type':'application/json'}});
  };
  const config={host:origin,port:443,fetchImpl};
  const createCredential = async (): Promise<Credential> => {
    const proof=syntheticProof(f.instanceId,begin!).credential;
    const decode=(s:string)=>Uint8Array.from(Buffer.from(s,'base64url')).buffer;
    return {id:proof.id,type:'public-key',rawId:decode(proof.rawId),response:{clientDataJSON:decode(proof.response.clientDataJSON),attestationObject:decode(proof.response.attestationObject)}} as unknown as Credential;
  };
  return {f,config,requests,createCredential};
}

test('same-origin SDK registration uses real protocol, minimum polling, terminal states and memory-only continuation', async t=>{
  const c=await client(t), context=await getBrowserPublicKeyContext(c.config), d=await getBrowserRegistrationDescriptor(c.config,context);
  const r=await registerBrowserCredential({...c.config,createCredential:c.createCredential},context,d,'Synthetic UI');
  assert.equal(r.initialStatus.state,'pending');assert.deepEqual(Object.keys(r).sort(),['initialStatus','status']);
  assert.doesNotMatch(JSON.stringify(r),/continuationSecret|clientDataJSON|attestationObject/);
  assert.equal(c.f.registry.status().sessions,0);assert.equal(c.f.registry.readRegistrationStorage().credentials.length,0);
  await assert.rejects(()=>r.status(),{code:'SECURITY_REGISTRATION_RATE_LIMITED'});
  c.f.advance(5100);assert.equal((await r.status()).state,'pending');
  c.f.local(c.f.decision(r.initialStatus.registrationId));
  c.f.advance(5100);assert.equal((await r.status()).state,'approved');
  assert.equal(c.f.registry.status().sessions,0,'Approval must not log in');
  assert.ok(c.requests.every(r=>!r.url.includes('?')));
});
for (const action of ['registration.reject','expired']) test('SDK shows application '+action,async t=>{
  const c=await client(t),context=await getBrowserPublicKeyContext(c.config),d=await getBrowserRegistrationDescriptor(c.config,context);
  const r=await registerBrowserCredential({...c.config,createCredential:c.createCredential},context,d,'Synthetic terminal');
  if(action==='expired')c.f.advance(24*3600000+5100);else{c.f.local(c.f.decision(r.initialStatus.registrationId,action));c.f.advance(5100);}
  assert.equal((await r.status()).state,action==='expired'?'expired':'rejected');
});
test('import accepts strict live JSON and rejects scripts, extra fields, cross-instance/origin/RP/hash/TLS, expiry and oversized UTF-8',async t=>{
  const c=await client(t),d=c.f.descriptor;
  assert.deepEqual(parseBrowserRegistrationDescriptor(JSON.stringify(d),d),d);
  const invalid=[ '<script>globalThis.executed=true</script>', '{}', 'x'.repeat(16385), JSON.stringify({...d,script:'alert(1)'}),
    ...[{instanceId:'14c9b50a-4b71-4c34-8fb7-e072c6306100'},{serverOrigin:'https://other.example.test'},{rpId:'other.example.test'},{deploymentDescriptorSha256:'b'.repeat(64)},{tls:{mode:'owner-pinned',minVersion:'TLS1.2',spkiSha256:'b'.repeat(64)}},{expiresAtUtc:new Date(c.f.now-1).toISOString()}].map(v=>JSON.stringify({...d,...v})) ];
  for(const input of invalid)assert.throws(()=>parseBrowserRegistrationDescriptor(input,d));
  assert.equal(c.requests.length,0,'Import must not execute or navigate');
});
test('SDK refuses cross-origin destinations before fetch and binding drift before WebAuthn',async t=>{
  const c=await client(t);
  await assert.rejects(()=>getBrowserPublicKeyContext({...c.config,host:'https://other.example.test'}),{code:'SECURITY_REGISTRATION_ORIGIN_MISMATCH'});assert.equal(c.requests.length,0);
  const context=await getBrowserPublicKeyContext(c.config);
  await assert.rejects(()=>getBrowserRegistrationDescriptor(c.config,{...context,binding:{...context.binding,instanceId:'14c9b50a-4b71-4c34-8fb7-e072c6306100'}}),{code:'SECURITY_REGISTRATION_INSTANCE_MISMATCH'});
});
test('SDK sanitizes unknown failures and bounds response size; registration code errors stay machine readable',async t=>{
  const c=await client(t);
  for(const [body,status,code] of [[{code:'SECURITY_REGISTRATION_DISABLED'},403,'SECURITY_REGISTRATION_DISABLED'],[{error:'DO_NOT_LOG_PRIVATE_BODY'},503,'SECURITY_REGISTRATION_UNSUPPORTED'],[{x:'x'.repeat(65537)},200,'SECURITY_REGISTRATION_SCHEMA_INVALID']] as const){
    await assert.rejects(()=>getBrowserPublicKeyContext({...c.config,fetchImpl:async()=>Response.json(body,{status})}),{code});
  }
});
test('cancelled WebAuthn never completes or grants access; abort is passed to the browser',async t=>{
  const c=await client(t),context=await getBrowserPublicKeyContext(c.config),abort=new AbortController();
  await assert.rejects(()=>registerBrowserCredential({...c.config,signal:abort.signal,createCredential:async options=>{assert.equal(options.signal,abort.signal);throw new DOMException('Synthetic cancel','NotAllowedError');}},context,c.f.descriptor,'Synthetic cancel'),{name:'NotAllowedError'});
  assert.equal(c.requests.some(r=>r.url.endsWith('/complete')),false);assert.equal(c.f.registry.status().sessions,0);
});
test('public login binding survives registration expiry and contains no private identity material',async()=>{
  const a=await authenticationFixture();try{
    a.f.advance(2*3600000);assert.throws(()=>a.f.service.connection(),{code:'SECURITY_REGISTRATION_EXPIRED'});
    const caps=a.service.capabilities();assert.deepEqual(caps.deployment,{serverOrigin:origin,rpId:'modeldb-a.example.test',deploymentDescriptorSha256:'a'.repeat(64)});
    assert.doesNotMatch(JSON.stringify(caps),/continuationSecret|credentialId|rawId|publicKey|csrf/);
  }finally{await a.close();}
});
test('an aborted registration never submits the returned browser proof',async t=>{
  const c=await client(t),context=await getBrowserPublicKeyContext(c.config),abort=new AbortController();
  await assert.rejects(()=>registerBrowserCredential({...c.config,signal:abort.signal,createCredential:async()=>{const value=await c.createCredential();abort.abort();return value;}},context,c.f.descriptor,'Synthetic aborted'),{name:'AbortError'});
  assert.equal(c.requests.some(r=>r.url.endsWith('/complete')),false);
});
test('stale begin binding is rejected before invoking the authenticator',async t=>{
  const c=await client(t),context=await getBrowserPublicKeyContext(c.config);
  const fetchImpl:typeof fetch=async(input,init)=>{const r=await c.config.fetchImpl(input,init);if(String(input).endsWith('/begin'))return Response.json({...await r.json(),instanceId:'14c9b50a-4b71-4c34-8fb7-e072c6306100'});return r;};
  await assert.rejects(()=>registerBrowserCredential({...c.config,fetchImpl,createCredential:async()=>{assert.fail('No stale browser ceremony');}},context,c.f.descriptor,'Synthetic stale'),{code:'SECURITY_REGISTRATION_INSTANCE_MISMATCH'});
});
for(const [error,expected] of [[{name:'NotAllowedError'},'cancelled'],[{name:'AbortError'},'cancelled'],[{name:'NotSupportedError'},'unsupported'],[{code:'SECURITY_REGISTRATION_REJECTED'},'rejected'],[{code:'SECURITY_REGISTRATION_CHALLENGE_EXPIRED'},'expired'],[{code:'SECURITY_REGISTRATION_INSTANCE_MISMATCH'},'descriptor'],[{code:'SECURITY_AUTHENTICATION_PROOF_INVALID'},'identity'],[{code:'SECURITY_REGISTRATION_RATE_LIMITED'},'limited'],[{code:'SECURITY_REGISTRATION_DISABLED'},'closed'],[new Error('DO_NOT_DISPLAY'),'unavailable']] as const) {
  test('UI error category '+expected+': '+JSON.stringify(error),()=>assert.equal(browserIdentityIssue(error),expected));
}

test('public identity client shares discovery, strict import and pending lifecycle without revealing continuation',async t=>{
  const c=await client(t), identity=createBrowserIdentityClient({...c.config,createCredential:c.createCredential});t.after(()=>identity.dispose());
  const context=await identity.load();assert.equal(Object.isFrozen(context.binding),true);
  const descriptor=await identity.importDescriptor(JSON.stringify(c.f.descriptor));
  Reflect.set(descriptor,'instanceId','14c9b50a-4b71-4c34-8fb7-e072c6306100');
  const application=await identity.register('Synthetic public client');assert.equal(application.initialStatus.state,'pending');
  assert.doesNotMatch(JSON.stringify(identity),/continuation|csrf|token/i);
  c.f.advance(5100);c.f.local(c.f.decision(application.initialStatus.registrationId));
  assert.equal((await application.status()).state,'approved');assert.equal(c.f.registry.status().sessions,0);
  identity.dispose();const count=c.requests.length;
  await assert.rejects(()=>application.status(),{name:'AbortError'});assert.equal(c.requests.length,count);
});
test('public client rejects cross-origin before sending any request',async t=>{
  const c=await client(t),identity=createBrowserIdentityClient({...c.config,host:'https://other.example.test'});t.after(()=>identity.dispose());
  await assert.rejects(()=>identity.load(),{code:'SECURITY_REGISTRATION_ORIGIN_MISMATCH'});assert.equal(c.requests.length,0);
});
test('public client serializes authenticator actions and never replays busy requests',async t=>{
  const c=await client(t);let release!:()=>void;const blocked=new Promise<void>(done=>{release=done;});
  const identity=createBrowserIdentityClient({...c.config,fetchImpl:async(...args)=>{await blocked;return c.config.fetchImpl(...args);}});t.after(()=>identity.dispose());
  const load=identity.load();await assert.rejects(()=>identity.register('Duplicate'),{code:'SECURITY_IDENTITY_BUSY'});release();await load;
  assert.equal(c.requests.some(r=>r.url.endsWith('/begin')),false);
});
test('dispose rejects late discovery results even when fetch ignores AbortSignal',async t=>{
  const c=await client(t);let release!:()=>void;const blocked=new Promise<void>(done=>{release=done;});
  const identity=createBrowserIdentityClient({...c.config,fetchImpl:async(...args)=>{await blocked;return c.config.fetchImpl(...args);}});
  const load=identity.load();identity.dispose();release();await assert.rejects(()=>load,{name:'AbortError'});
  await assert.rejects(()=>identity.descriptor(),{name:'AbortError'});
});
test('parent abort before discovery performs no fetch and dispose is idempotent',async t=>{
  const c=await client(t),abort=new AbortController();abort.abort();const identity=createBrowserIdentityClient({...c.config,signal:abort.signal});
  await assert.rejects(()=>identity.load(),{name:'AbortError'});identity.dispose();identity.dispose();assert.equal(c.requests.length,0);
});
test('dispose while authenticator is open prevents registration submission',async t=>{
  const c=await client(t);const identity=createBrowserIdentityClient({...c.config,createCredential:async()=>{const proof=await c.createCredential();identity.dispose();return proof;}});
  await assert.rejects(()=>identity.register('Synthetic disposed ceremony'),{name:'AbortError'});
  assert.equal(c.requests.some(r=>r.url.endsWith('/complete')),false);
});
test('public client rejects changed deployment before opening login ceremony',async t=>{
  const c=await client(t);let changed=false,called=false;
  const identity=createBrowserIdentityClient({...c.config,getCredential:async()=>{called=true;return null;},fetchImpl:async(...args)=>{const r=await c.config.fetchImpl(...args);if(changed&&String(args[0]).endsWith('/authentication/v1/capabilities'))return Response.json({...await r.json(),deployment:{serverOrigin:origin,rpId:c.f.descriptor.rpId,deploymentDescriptorSha256:'b'.repeat(64)}});return r;}});t.after(()=>identity.dispose());
  await identity.load();changed=true;await assert.rejects(()=>identity.login(),{code:'SECURITY_AUTHENTICATION_DEPLOYMENT_MISMATCH'});assert.equal(called,false);
});
