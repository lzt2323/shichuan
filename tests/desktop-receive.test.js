import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mergeState } from '../shared/history.js';
const source = readFileSync(new URL('../apps/desktop/public/app.js', import.meta.url), 'utf8');
const receiveCode = source.slice(source.indexOf('function hydrate('), source.indexOf('function renderDevices('));
function fixture() {
  const received = [], context = vm.createContext({ mergeState,
    bridge: { prepareFile: async id => { received.push(id); } }, renderDevices() {}, renderMessages() {},
  });
  vm.runInContext(`let state={messages:[],devices:[]}, historyLoaded=false, epoch=1, preparing=0;
    const observedFiles=new Set(), ready=new Map(), prepareQueue=[], AUTO_RECEIVE_BYTES=8*1024**2;
    ${receiveCode}`, context);
  return { received, async apply(next) { context.next = next; vm.runInContext('applyState(next)', context); await new Promise(resolve => setImmediate(resolve)); },
    reconnect() { vm.runInContext('historyLoaded=false; ready.clear();', context); }, clear() { vm.runInContext('ready.clear(); prepareQueue.length=0;', context); } };
}
const file = (id, size = 20, sequence = 1) => ({ id, type: 'file', size, sequence });
test('opening and reconnecting a desktop group never downloads historical attachments', async () => {
  const f = fixture(), messages = [file('old'), file('old-large', 16 * 1024 ** 2, 2)];
  await f.apply({ mode:'snapshot', messages, devices:[] }); assert.deepEqual(f.received, []);
  f.reconnect(); await f.apply({ mode:'snapshot', messages:[...messages, file('arrived-offline',30,3)], devices:[] }); assert.deepEqual(f.received, []);
});
test('new small files auto-receive once while large and deleted files remain on demand', async () => {
  const f = fixture(); await f.apply({ mode:'snapshot', messages:[], devices:[] });
  const messages = [file('small'), file('large', 16*1024**2,2), {...file('removed',20,3),deleted:true}];
  await f.apply({ mode:'delta', messages, devices:[] }); assert.deepEqual(f.received, ['small']);
  await f.apply({ mode:'delta', messages:[], devices:[{id:'peer',online:true}] }); assert.deepEqual(f.received, ['small']);
});
test('clearing receive cache does not trigger downloads on later presence snapshots', async () => {
  const f = fixture(); await f.apply({ mode:'snapshot', messages:[], devices:[] });
  await f.apply({ mode:'delta', messages:[file('small')], devices:[] }); f.clear();
  await f.apply({ mode:'snapshot', messages:[file('small')], devices:[] }); assert.deepEqual(f.received, ['small']);
});
