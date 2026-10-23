import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/quote.js';

function response() {
  return {headers:{},setHeader(key,value){this.headers[key]=value;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
}

test('Yahoo null fields fall through to valid values and remain missing otherwise', async t => {
  const original = globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>({ok:true,json:async()=>({chart:{result:[{
    meta:{regularMarketPrice:null,previousClose:null,chartPreviousClose:90,regularMarketDayHigh:null},
    indicators:{quote:[{close:[100,null]}]}
  }]}})});
  const res=response();await handler({method:'GET',query:{symbol:'TEST'}},res);
  assert.equal(res.code,200);assert.equal(res.body.price,100);assert.equal(res.body.prev,90);
  assert.equal(res.body.high,null);assert.equal(res.body.low,null);
  assert.ok(Math.abs(res.body.chgPct-11.11111111)<0.00001);
});

test('unsupported quote methods and invalid symbols fail without network access', async t => {
  const original = globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>{throw new Error('Network should not be called');};
  const invalid=response();await handler({method:'GET',query:{symbol:'../../secret'}},invalid);assert.equal(invalid.code,400);
  const post=response();await handler({method:'POST',query:{}},post);assert.equal(post.code,405);
});
