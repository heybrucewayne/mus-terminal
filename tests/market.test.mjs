import test from 'node:test';
import assert from 'node:assert/strict';

const tick = {symbol:'SOLUSDT',lastPrice:'100',priceChangePercent:'2',highPrice:'102',lowPrice:'98',quoteVolume:'10000'};
function response() {
  return { headers:{},code:0,body:null,setHeader(key,value){this.headers[key]=value;},status(code){this.code=code;return this;},json(body){this.body=body;return this;} };
}
let sequence = 0;
const handler = async () => (await import(`../api/market.js?case=${sequence++}`)).default;

test('concurrent requests share one provider call and then reuse the cached snapshot', async t => {
  const original = globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  let calls = 0;
  globalThis.fetch = async () => {calls++;await new Promise(resolve=>setTimeout(resolve,20));return {ok:true,json:async()=>[tick,{...tick,symbol:'BTCUPUSDT'}]};};
  const serve = await handler();
  const responses = Array.from({length:5},response);
  await Promise.all(responses.map(res=>serve({method:'GET'},res)));
  assert.equal(calls,1);
  for (const res of responses) { assert.equal(res.code,200);assert.equal(res.body.tickers.length,1);assert.equal(res.body.stale,false); }
  await serve({method:'GET'},response());
  assert.equal(calls,1);
});

test('provider outage labels a recent cache stale and rejects an expired cache', async t => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  t.after(()=>{globalThis.fetch=originalFetch;Date.now=originalNow;});
  globalThis.fetch = async()=>({ok:true,json:async()=>[tick]});
  const serve = await handler();
  const initial = response();
  await serve({method:'GET'},initial);
  const at = Date.parse(initial.body.updatedAt);
  globalThis.fetch = async()=>{throw new Error('offline');};
  Date.now = ()=>at+30_000;
  const stale = response();await serve({method:'GET'},stale);
  assert.equal(stale.code,200);assert.equal(stale.body.stale,true);assert.equal(stale.headers['Cache-Control'],'no-store');
  Date.now = ()=>at+301_000;
  const expired = response();await serve({method:'GET'},expired);
  assert.equal(expired.code,503);assert.equal(expired.body.tickers,undefined);
});

test('bad methods and invalid provider payloads fail with explicit statuses', async t => {
  const original = globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  globalThis.fetch = async()=>{calls++;return {ok:true,json:async()=>[{...tick,lastPrice:null}]};};
  const serve = await handler();
  const post = response();await serve({method:'POST'},post);
  assert.equal(post.code,405);assert.equal(post.headers.Allow,'GET');assert.equal(calls,0);
  const get = response();await serve({method:'GET'},get);
  assert.equal(get.code,503);assert.equal(get.body.tickers,undefined);
});
