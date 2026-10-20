import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { preparePivotParameters, pivotParameterDefault, describePivotInterfaceConditions } from '../../apps/model-designer/src/pivot/interface-input.js';
import type { InterfaceParameter, QueryFilter, QueryInterface } from '../../apps/model-designer/src/query-designer/types.js';
import { customerOrdersQueryFixture } from '../../apps/model-designer/src/query-designer/fixtures.js';
import type { EngineModelNode } from '../../apps/model-designer/src/types/engine-schema.js';
import zh from '../../apps/model-designer/src/i18n/locales/zh/ui.json';
import en from '../../apps/model-designer/src/i18n/locales/en/ui.json';
import ja from '../../apps/model-designer/src/i18n/locales/ja/ui.json';

const parameter = (id: string, type: InterfaceParameter['type'], extra: Partial<InterfaceParameter> = {}): InterfaceParameter => ({ id, name: `${id}Name`, type, required: false, ...extra });

describe('Pivot published interface inputs', () => {
  it('produces typed values keyed by published names and preserves false, zero and JSON', () => {
    const parameters = [parameter('s','string'),parameter('n','number'),parameter('b','boolean'),parameter('j','json'),parameter('d','date'),parameter('dt','datetime'),parameter('r','recordRef'),parameter('e','enum')];
    const result = preparePivotParameters(parameters, { s:'  text  ', n:'0', b:'false', j:'[0,false,null]', d:'2024-02-29', dt:'2026-10-17T12:00:00-04:00', r:'{"model":"Node","id":"0001"}', e:'ACTIVE', unknown:'not sent' });
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.values, { sName:'  text  ', nName:0, bName:false, jName:[0,false,null], dName:'2024-02-29', dtName:'2026-10-17T16:00:00.000Z', rName:{model:'Node',id:'0001'}, eName:'ACTIVE' });
    assert.equal(preparePivotParameters([parameter('r','recordRef')],{r:'000123'}).values.rName,'000123');
  });
  it('omits blank values so false/zero/null defaults and optional semantics remain with the server', () => {
    const parameters = [parameter('required','string',{required:true}),parameter('optional','number'),parameter('zero','number',{required:true,defaultValue:0}),parameter('false','boolean',{required:true,defaultValue:false}),parameter('null','json',{required:true,defaultValue:null})];
    const result = preparePivotParameters(parameters, {required:'',optional:'', zero:'', false:'', null:''});
    assert.deepEqual(result.values, {});
    assert.deepEqual(result.issues,[{parameterId:'required',code:'required'}]);
    assert.equal(pivotParameterDefault(parameters[2]!), '0');
    assert.equal(pivotParameterDefault(parameters[3]!), 'false');
    assert.equal(pivotParameterDefault(parameters[4]!), 'null');
  });
  it('reports invalid numbers, booleans, JSON and calendar dates before a request', () => {
    const parameters = [parameter('n','number'),parameter('b','boolean'),parameter('j','json'),parameter('d','date'),parameter('dt','datetime')];
    const result = preparePivotParameters(parameters,{n:' ',b:'yes',j:'{bad',d:'2025-02-29',dt:'no date'});
    assert.deepEqual(result.issues.map((issue)=>issue.code),['number','boolean','json','date','datetime']);
    assert.deepEqual(result.values, {});
    assert.equal(preparePivotParameters([parameter('n','number')],{n:'Infinity'}).issues[0]?.code,'number');
    assert.equal(preparePivotParameters([parameter('dt','datetime')],{dt:'2026-02-30T12:00'}).issues[0]?.code,'datetime');
    assert.equal(preparePivotParameters([parameter('dt','datetime')],{dt:'2026-10-17T12:00'}).values.dtName,new Date('2026-10-17T12:00').toISOString());
  });

  const models: EngineModelNode[] = [{ id:'Order', model_name:'Order',parent_id:null,name_i18n:{zh:'订单',en:'Order',ja:'注文'},props_objects_array:[{id:'status',name:'status',name_i18n:{zh:'状态',en:'Status',ja:'状態'},type:'String',is_primary:false,encrypt_level:0,metadata:{}}] }];
  const rule = (id:string, value:QueryFilter['value'], nodeId='node_order'):QueryFilter => ({id,enabled:true,target:{nodeId,modelId:'Order',fieldId:'status'},operator:'eq',value});
  it('preserves AND/OR structure, fixed values and parameter references while excluding disabled groups', () => {
    const asset: QueryInterface = structuredClone(customerOrdersQueryFixture);
    asset.query.filterTree={id:'root',kind:'group',enabled:true,combinator:'and',children:[rule('fixed',{kind:'literal',value:'ACTIVE'}),{id:'or',kind:'group',enabled:true,combinator:'or',children:[rule('input',{kind:'parameter',parameterId:'param_status'}),rule('other',{kind:'literal',value:'WAITING'})]},{id:'disabled',kind:'group',enabled:false,combinator:'and',children:[rule('hidden',{kind:'parameter',parameterId:'hidden'})]}]};
    const before=JSON.stringify(asset);
    const result=describePivotInterfaceConditions({queryInterface:asset,models,relations:[],locale:'zh'});
    assert.equal(result.where?.kind,'group');
    if(result.where?.kind!=='group') throw new Error('group missing');
    assert.equal(result.where.children.length,2);
    assert.deepEqual(result.where.children[0],{kind:'rule',id:'fixed',label:'订单 [orders] · 状态',operator:'eq',value:{kind:'literal',value:'ACTIVE'}});
    assert.equal(result.where.children[1]?.kind,'group');
    if(result.where.children[1]?.kind==='group') assert.equal(result.where.children[1].combinator,'or');
    assert.deepEqual(result.parameterTargets.get('param_status'),['订单 [orders] · 状态']);
    assert.equal(result.parameterTargets.has('hidden'),false);
    assert.equal(JSON.stringify(asset),before,'display must not mutate the release');
  });
  it('keeps repeated model aliases, relationship quantifiers, inherited labels and HAVING conditions', () => {
    const asset: QueryInterface = structuredClone(customerOrdersQueryFixture);
    asset.designGraph.nodes.push({id:'second',modelId:'Order',alias:'parentOrder',role:'joined'});
    asset.designGraph.edges.push({id:'parent',relationId:'parent-rel',fromNodeId:'node_order',toNodeId:'second',alias:'parent',traversal:'reverse',required:false,cardinality:'one'});
    asset.query.filterTree={id:'root',kind:'group',enabled:true,combinator:'and',children:[rule('first',{kind:'parameter',parameterId:'param_status'}),{id:'rel',kind:'relation',enabled:true,target:{edgeId:'parent',relationId:'parent-rel'},sourceNodeId:'node_order',targetNodeId:'second',quantifier:'none',condition:{id:'nested',kind:'group',enabled:true,combinator:'and',children:[rule('second',{kind:'parameter',parameterId:'param_status'},'second')]}}]};
    asset.query.aggregation={groupBy:[],metrics:[{id:'total',function:'count',source:{nodeId:'node_order',modelId:'Order',fieldId:'status'},outputName:'orderCount'}],having:{id:'having',kind:'group',enabled:true,combinator:'and',children:[{id:'count',enabled:true,target:{metricId:'total'},operator:'gt',value:{kind:'literal',value:3}}]}};
    const result=describePivotInterfaceConditions({queryInterface:asset,models,relations:[{id:'parent-rel',source_model_id:'Order',target_model_id:'Order',kind:'relation',reverse_name:'parent',reverse_name_i18n:{zh:'父订单',en:'Parent order'}}],locale:'zh'});
    assert.deepEqual(result.parameterTargets.get('param_status'),['订单 [orders] · 状态','订单 [parentOrder] · 状态']);
    if(result.where?.kind!=='group') throw new Error('group missing');
    assert.equal(result.where.children[1]?.kind,'relation');
    if(result.where.children[1]?.kind==='relation') {assert.equal(result.where.children[1].quantifier,'none');assert.equal(result.where.children[1].label,'父订单 [parent]');}
    if(result.having?.kind!=='group') throw new Error('having missing');
    assert.equal(result.having.children[0]?.kind,'rule');
    if(result.having.children[0]?.kind==='rule')assert.equal(result.having.children[0].label,'orderCount');
    const english=describePivotInterfaceConditions({queryInterface:asset,models,relations:[],locale:'en'});
    assert.deepEqual(english.parameterTargets.get('param_status'),['Order [orders] · Status','Order [parentOrder] · Status']);
  });
  it('supports older flat filters and distinguishes no enabled conditions', () => {
    const asset:QueryInterface=structuredClone(customerOrdersQueryFixture);
    assert.ok(describePivotInterfaceConditions({queryInterface:asset,models,relations:[],locale:'zh'}).where);
    asset.query.filters.forEach((filter)=>{filter.enabled=false;});
    assert.equal(describePivotInterfaceConditions({queryInterface:asset,models,relations:[],locale:'zh'}).where,undefined);
  });
  it('provides all Pivot translation keys in Chinese, English and Japanese', () => {
    for(const key of Object.keys(zh).filter((key)=>key.startsWith('pivot'))) for(const locale of [en,ja]) assert.ok((locale as Record<string,string>)[key],key);
  });
});
