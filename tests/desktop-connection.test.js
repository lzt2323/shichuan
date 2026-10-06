import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the renderer's production connection functions with a deterministic
// network and clock; Electron smoke exercises their integration in real windows.
const source = readFileSync(new URL('../apps/desktop/public/app.js', import.meta.url), 'utf8');
const apiCode = source.slice(source.indexOf('async function api('), source.indexOf('function time('));
const joinCode = source.slice(source.indexOf('function retryConnection('), source.indexOf('async function sendText('));
function fixture(fetchImpl = async () => ({ ok: true, json: async () => ({ messages: [], devices: [] }) })) {
  const timers = [], sockets = [], states = [], nodes = new Map();
  const context = vm.createContext({ AbortController, AbortSignal, URL, Math, fetch: fetchImpl,
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    WebSocket: class {
      static OPEN = 1;
      constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
      close() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
    },
    document: {},
    $(id) { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
    groupName: () => 'Test', renderMessages() {}, showError(error) { throw error; },
    applyState(next) { states.push(next); },
    connection(value) { context.isOnline = value; }, renderConnection() {},
  });
  vm.runInContext(`let epoch=0, reconnectTimer, socket, reconnectAttempt=0, connectionError='';
    let requestController=new AbortController(); const ready=new Map(), prepareQueue=[];
    let config={room:{baseUrl:'http://192.168.1.2:47321',key:'token'},device:{id:'test'}};
    ${apiCode}\n${joinCode}\nglobalThis.inspect=()=>({epoch,reconnectAttempt,connectionError});`, context);
  return { context, timers, sockets, states, join: () => vm.runInContext('join()', context) };
}
test('desktop replaces a connection generation and rejects stale socket state/error events', async () => {
  const f = fixture(); await f.join(); const old = f.sockets[0];
  await f.join(); const next = f.sockets[1];
  old.onmessage({ data: JSON.stringify({ type: 'state', messages: [{ text: 'stale' }] }) });
  old.onerror(); assert.equal(next.readyState, 0); assert.equal(f.states.length, 2);
  next.readyState = 1; next.onopen(); assert.equal(f.context.isOnline, true);
  assert.equal(f.context.inspect().connectionError, '');
});
test('desktop aborts the previous HTTP join and never applies its response', async () => {
  let calls = 0, firstSignal;
  const f = fixture(async (_url, options) => {
    if (++calls === 1) {
      firstSignal = options.signal;
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    }
    return { ok: true, json: async () => ({ messages: [{ text: 'fresh' }] }) };
  });
  const previous = f.join(); await f.join(); await previous;
  assert.equal(firstSignal.aborted, true); assert.equal(f.states.length, 1);
  assert.equal(f.states[0].messages[0].text, 'fresh'); assert.equal(f.sockets.length, 1);
});
test('desktop bounds WebSocket handshake and retries with backoff, then resets on success', async () => {
  const f = fixture(); await f.join();
  const handshake = f.timers.find(timer => timer.delay === 8000); handshake.fn();
  assert.equal(f.sockets[0].readyState, 3);
  assert.match(f.context.inspect().connectionError, /握手超时/);
  const retry = f.timers.find(timer => timer.delay >= 1000 && timer.delay < 1400); assert.ok(retry);
  await retry.fn(); const next = f.sockets[1]; next.readyState = 1; next.onopen();
  assert.equal(f.context.inspect().reconnectAttempt, 0); assert.equal(f.context.isOnline, true);
});
test('desktop stops retrying revoked HTTP authorization and WS policy close', async () => {
  const denied = fixture(async () => ({ ok: false, status: 401, json: async () => ({ error: 'revoked' }) }));
  await denied.join(); assert.equal(denied.timers.length, 0); assert.equal(denied.sockets.length, 0);
  assert.match(denied.context.inspect().connectionError, /授权已失效/);
  const f = fixture(); await f.join(); f.sockets[0].onclose({ code: 1008 });
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 0);
  assert.match(f.context.inspect().connectionError, /授权已失效/);
});

test('desktop cancels connections before a network rebind and waits for network availability', async () => {
  let requests = 0;
  const f = fixture(async () => { requests++; return { ok: true, json: async () => ({ messages: [], devices: [] }) }; });
  await f.join(); const old = f.sockets[0];
  vm.runInContext("config.network={available:true,switching:true}; cancelConnection('switching');", f.context);
  assert.equal(old.readyState, 3); assert.equal(f.context.isOnline, false);
  await f.join(); assert.equal(requests, 2); assert.equal(f.sockets.length, 1);
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 0);
  vm.runInContext('config.network={available:true,switching:false};', f.context);
  await f.join(); assert.equal(requests, 4); assert.equal(f.sockets.length, 2);
});
