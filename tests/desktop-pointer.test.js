import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../apps/desktop/preload.cjs', import.meta.url), 'utf8');
async function fixture() {
  const handlers = new Map(), sent = [], timers = []; let denyCapture = false, captured = false, focused = true, tab;
  class Element {
    constructor() { this.dataset = {}; this.classList = {contains:()=>false}; this.style = {setProperty(){}}; }
    addEventListener() {} setAttribute() {} blur() {} closest(selector) { return selector.includes('#pickdrop-native-tab') ? this : null; }
    setPointerCapture() { if (denyCapture) throw new Error('native resize rejected capture'); captured = true; }
    hasPointerCapture() { return captured && !denyCapture; } releasePointerCapture() { captured = false; }
  }
  const root = new Element(), document = { documentElement:root, activeElement:null, hasFocus:()=>focused,
    createElement:()=>{ tab = new Element(); return tab; }, body:{append() {}} };
  const context = vm.createContext({ Element, document, innerWidth:64, innerHeight:34,
    window:{addEventListener(type,handler){if (!handlers.has(type)) handlers.set(type,[]); handlers.get(type).push(handler);}},
    setTimeout(fn){timers.push(fn); return fn;},clearTimeout(){},
    matchMedia:()=>({matches:false,addEventListener(){}}),
    require:()=>({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{on(){},send(...args){sent.push(args);},invoke:async()=>({group:{name:'test'},window:{collapsed:true,edge:'top'}})}}),
  });
  vm.runInContext(source,context);
  async function emit(type,event={}) { for (const handler of handlers.get(type)||[]) await handler(event); }
  await emit('DOMContentLoaded');
  return {context,sent,timers,emit,root,tab,deny(){denyCapture=true;},blur(){focused=false;},down:()=>emit('pointerdown',{button:0,target:tab,pointerId:7,screenX:32,screenY:17,preventDefault(){}})};
}
test('courier reveal survives rejected recapture and still ends on released pointer', async()=>{
  const f=await fixture();await f.down();f.deny();f.context.innerWidth=340;f.context.innerHeight=470;
  await f.emit('lostpointercapture',{pointerId:7,buttons:0});
  assert.equal(f.sent.some(call=>call[1]==='window-drag-end'),false);
  await f.emit('pointerup',{pointerId:7});
  assert.equal(f.sent.find(call=>call[1]==='window-drag-end')?.[2],false);
});
test('ordinary rejected capture loss cancels instead of leaving a stale drag', async()=>{
  const f=await fixture();await f.down();f.deny();await f.emit('lostpointercapture',{pointerId:7,buttons:0});
  assert.equal(f.sent.find(call=>call[1]==='window-drag-end')?.[2],true);
});
test('lost focus eventually cancels a held courier reveal and clears input focus lock', async()=>{
  const f=await fixture();await f.down();f.deny();f.context.innerWidth=340;f.context.innerHeight=470;
  await f.emit('lostpointercapture',{pointerId:7,buttons:0});f.blur();await f.emit('blur');
  for(const timer of f.timers) timer();
  assert.ok(f.sent.some(call=>call[1]==='input'&&call[2]===false));
  assert.equal(f.sent.find(call=>call[1]==='window-drag-end')?.[2],true);
});
