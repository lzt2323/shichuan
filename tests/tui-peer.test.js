import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDaemon } from '../apps/tui/daemon.js';
import { locations } from '../apps/tui/common.js';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-tui-peer-')), daemons = [];
  const make = async name => {
    const base = path.join(root, name), paths = locations({ XDG_DATA_HOME: base+'/d', XDG_STATE_HOME: base+'/s', XDG_CONFIG_HOME: base+'/c', XDG_RUNTIME_DIR: base+'/r' });
    const daemon = await createDaemon({ paths, managerOptions: { peerGroups: true, host: '127.0.0.1', directoryPort: 0, monitorIntervalMs: 600000, discoveryFactory: async () => ({list:()=>[], refresh(){}, close(){}}) } });
    daemons.push(daemon); return daemon;
  };
  t.after(async () => { await Promise.all(daemons.map(d => d.close())); await fs.rm(root, {recursive:true,force:true}); });
  return {root, make};
}
async function join(a,b,g) {
  const invite = await a.manager.createInvite(g.id), ticket = await b.manager.joinAt(g.baseUrl, invite.code);
  await a.manager.respondJoin(g.id, ticket.requestId, true);
  return (await b.manager.checkJoin(ticket)).group;
}
async function settled(daemon, tasks) {
  for (let n=0;n<300;n++) {
    const found = tasks.map(({id})=>daemon.transfers.list().find(t=>t.id===id));
    if (found.every(t=>!['queued','running'].includes(t.status))) return found;
    await new Promise(r=>setTimeout(r,20));
  }
  throw new Error('transfer timeout');
}
test('Linux TUI replicas exchange bytes after creator exits, wait for missing holders, and enforce lifecycle permissions', async t=>{
  const {root,make}=await setup(t),a=await make('a'),b=await make('b'),c=await make('c');
  const g=await a.manager.createGroup('Linux 多端群'),gb=await join(a,b,g),gc=await join(a,c,g);
  await b.manager.getPeerStore(g.id).sync(g.baseUrl);
  await c.manager.getPeerStore(g.id).sync(gb.baseUrl);
  await b.manager.getPeerStore(g.id).sync(gc.baseUrl);
  await a.close();
  await b.dispatch('text',{group:g.id,text:'Linux survives creator exit'});
  const bytes=randomBytes(65537),source=path.join(root,'Linux 文件.bin');await fs.writeFile(source,bytes);
  const [sent]=await settled(b,await b.dispatch('send',{group:g.id,files:[source]}));assert.equal(sent.status,'done',sent.error);
  await c.manager.getPeerStore(g.id).sync(gb.baseUrl);
  assert.ok((await c.dispatch('messages',{group:g.id})).messages.some(m=>m.text==='Linux survives creator exit'));
  const [received]=await settled(c,await c.dispatch('receive',{group:g.id,messageId:sent.messageId,directory:path.join(root,'downloads')}));
  assert.equal(received.status,'done',received.error);assert.deepEqual(await fs.readFile(received.result),bytes);
  // All holders temporarily lack the blob: keep the request pending, not corrupt or silently complete.
  const bpath=b.manager.getHostedInbox(g.id).fileFor(sent.messageId).path,cpath=c.manager.getHostedInbox(g.id).fileFor(sent.messageId).path;
  await fs.rm(bpath);await fs.rm(cpath);
  const [waiting]=await settled(c,await c.dispatch('receive',{group:g.id,messageId:sent.messageId,directory:path.join(root,'later')}));assert.equal(waiting.status,'waiting');
  await fs.writeFile(bpath,bytes);
  for(let n=0;n<650&&c.transfers.list().find(task=>task.id===waiting.id)?.status!=='done';n++) await new Promise(resolve=>setTimeout(resolve,20));
  const [resumed]=await settled(c,[waiting]);assert.equal(resumed.status,'done',resumed.error);assert.deepEqual(await fs.readFile(resumed.result),bytes);
  await assert.rejects(b.dispatch('delete',{group:g.id}),/creator/);
  await c.dispatch('leave',{group:g.id});assert.equal(c.manager.listGroups().length,0);
  await b.dispatch('forget',{group:g.id});assert.equal(b.manager.listGroups().length,0);
});
