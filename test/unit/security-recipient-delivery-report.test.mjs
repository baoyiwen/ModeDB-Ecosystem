import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRecipientDeliveryTap, deliveryChecks } from '../../scripts/security-recipient-delivery-check.mjs';
const record={format:'modeldb.recipient-delivery-native.v1',ok:true,formats:['modeldb.backup.v2','modeldb.asset.v1','modeldb.asset.v2'],...Object.fromEntries(deliveryChecks.map(key=>[key,true])),realTwoDeviceTested:false,liveMaterialRead:false};
const tap=(native=record)=>'# '+JSON.stringify(native)+'\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('delivery report requires actual native completion and exact package/identity boundaries',()=>{assert.equal(parseRecipientDeliveryTap(tap(),0).unit.pass,1);});
test('delivery report refuses missing, ambiguous, skipped and failed raw results',()=>{for(const raw of [tap().replace('# skipped 0','# skipped 1'),tap()+'# pass 1\n',tap().replace('# pass 1','# pass 0'),tap().replace(/# \{[^\n]+\}\n/,''),tap()+'not ok 2 - failed\n'])assert.throws(()=>parseRecipientDeliveryTap(raw,0));assert.throws(()=>parseRecipientDeliveryTap(tap(),1));});
test('delivery report does not claim missing checks, new package formats or real two-device work',()=>{for(const key of deliveryChecks)assert.throws(()=>parseRecipientDeliveryTap(tap({...record,[key]:false}),0));assert.throws(()=>parseRecipientDeliveryTap(tap({...record,realTwoDeviceTested:true}),0));assert.throws(()=>parseRecipientDeliveryTap(tap({...record,formats:['modeldb.backup.v3']}),0));});
