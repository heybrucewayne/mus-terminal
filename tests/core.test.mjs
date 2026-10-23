import test from 'node:test';
import assert from 'node:assert/strict';
import { numberOrNull, filterMarkets, normalizeAlerts, evaluateAlerts, validateBackup } from '../assets/core.mjs';

test('missing market numbers stay missing rather than becoming zero', () => {
  for (const value of [null,undefined,'',' ',true,false,Infinity,'unavailable']) assert.equal(numberOrNull(value),null);
  assert.equal(numberOrNull('0'),0);
  assert.equal(numberOrNull('-1.5'),-1.5);
});

test('asset type and search filters compose without dropping complete snapshots', () => {
  const rows = [{id:'SOL',name:'Solana',kind:'crypto'},{id:'GOLD',name:'Gold',kind:'tradfi'},{id:'c:AAPL',name:'Apple',kind:'stock'}];
  assert.deepEqual(filterMarkets(rows,'crypto','sol'),[rows[0]]);
  assert.deepEqual(filterMarkets(rows,'markets',''),rows.slice(1));
  assert.deepEqual(filterMarkets(rows,'all','<script>'),[]);
  assert.equal(rows.length,3);
});

test('alerts fire once, inclusively, using only fresh quotes fetched this session', () => {
  const now = 1_000_000;
  const alerts = normalizeAlerts([
    {id:'a',assetId:'SOL',direction:'above',target:100},
    {id:'b',assetId:'SOL',direction:'below',target:100},
    {id:'c',assetId:'SOL',direction:'above',target:90,triggeredAt:now-1}
  ]);
  const quote = {id:'SOL',price:100,quotedAt:now};
  assert.deepEqual(evaluateAlerts(alerts,[quote],now,now-100).map(alert=>alert.id),['a','b']);
  for (const quotedAt of [0,now-91_000,now-101,now+10_000]) assert.equal(evaluateAlerts(alerts,[{...quote,quotedAt}],now,now-100).length,0);
  for (const price of [null,undefined,0,-1,Infinity]) assert.equal(evaluateAlerts(alerts,[{...quote,price}],now,now-100).length,0);
  assert.equal(evaluateAlerts(alerts,[],now).length,0);
});

test('corrupt and duplicated stored alerts are rejected', () => {
  const valid = {id:'a',assetId:'SOL',direction:'above',target:100};
  assert.equal(normalizeAlerts([null,valid,valid,{...valid,id:'b',target:null},{...valid,id:'c',direction:'anything'}]).length,1);
  assert.deepEqual(normalizeAlerts({}),[]);
});

test('backups use a versioned allowlist and reject invalid input before storage writes', () => {
  const input = {app:'mus-terminal',version:2,settings:{mus_theme_v1:'black',cc_custom:'[]',unexpected:'malicious'}};
  assert.deepEqual(validateBackup(input),{mus_theme_v1:'black',cc_custom:'[]'});
  for (const invalid of [{}, {...input,version:1}, {...input,settings:[]}, {...input,settings:{cc_custom:'broken'}}, {...input,settings:{cc_custom:'{}'}}, {...input,settings:{mus_theme_v1:'invalid'}}]) assert.throws(()=>validateBackup(invalid));
});
