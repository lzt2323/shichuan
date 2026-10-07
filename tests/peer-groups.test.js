import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile}from'node:fs/promises';import{randomUUID,randomBytes}from'node:crypto';import os from'node:os';import path from'node:path';import{createGroupManager}from'../server/groups.js';
async function setup(t){const root=await mkdtemp(path.join(os.tmpdir(),'pickdrop-peer-'));const all=[];const make=async name=>{const m=await createGroupManager({dataDir:path.join(root,name),device:{id:randomUUID(),name,kind:'desktop'},host:'127.0.0.1',peerGroups:true,directoryPort:0,discoveryFactory:async()=>({list:()=>[],refresh(){},async close(){}}),monitorIntervalMs:600000});all.push(m);return m};t.after(async()=>{await Promise.all(all.map(m=>m.close({force:true})));await rm(root,{recursive:true,force:true})});return{make};}
async function join(host,peer,g){const i=await host.createInvite(g.id),t=await peer.joinAt(g.baseUrl,i.code);await host.respondJoin(g.id,t.requestId,true);return(await peer.checkJoin(t)).group;}
test('creator exits; peers exchange messages, download from holders and survive local replica cleanup',async t=>{
 const{make}=await setup(t),a=await make('a'),b=await make('b'),c=await make('c'),g=await a.createGroup('peer');const gb=await join(a,b,g),gc=await join(a,c,g);
 await b.getPeerStore(g.id).sync(g.baseUrl);await b.getPeerStore(g.id).sync(gc.baseUrl);await a.close();
 await b.authenticated(g.id,'/api/messages',{method:'POST',body:{text:'creator offline'}});await c.getPeerStore(g.id).sync(gb.baseUrl);assert.equal((await c.authenticated(g.id,'/api/state')).messages[0].text,'creator offline');
 const content=randomBytes(5000),res=await fetch(gb.baseUrl+'/api/files?name=peer.bin',{method:'POST',headers:{'X-Room-Key':gb.key,'X-Device-Id':b.device.id},body:content});assert.equal(res.status,201);const message=await res.json();await c.getPeerStore(g.id).sync(gb.baseUrl);
 const cached=await c.preparePeerFile(g.id,message.id);const{readFile}=await import('node:fs/promises');assert.deepEqual(await readFile(cached),content);
 await b.getHostedInbox(g.id).deleteFiles([message.id]);assert.ok(b.getPeerStore(g.id).state().messages.some(m=>m.id===message.id));
 assert.deepEqual(await readFile(await b.preparePeerFile(g.id,message.id)),content);
 await writeFile(cached,Buffer.alloc(content.length,1));assert.deepEqual(await readFile(await c.preparePeerFile(g.id,message.id)),content);
});
test('unreachable peer sync does not lose pending invitations or deadlock reciprocal sync',async t=>{
 const{make}=await setup(t),a=await make('a'),b=await make('b'),g=await a.createGroup('peer'),gb=await join(a,b,g),store=a.getPeerStore(g.id);
 const i=await a.createInvite(g.id);assert.equal(await store.sync('http://127.0.0.1:1'),false);const c=await make('c'),ticket=await c.joinAt(g.baseUrl,i.code);assert.ok(ticket.requestId);
 await Promise.all([store.sync(gb.baseUrl),b.getPeerStore(g.id).sync(g.baseUrl)]);
 await a.respondJoin(g.id,ticket.requestId,true);assert.equal((await c.checkJoin(ticket)).status,'approved');
});
test('peer forget and rejoin uses signed identity, rename and dissolution propagate',async t=>{
 const{make}=await setup(t),a=await make('a'),b=await make('b'),g=await a.createGroup('peer');await join(a,b,g);await b.forgetGroup(g.id);const gb=await join(a,b,g);
 await a.renameGroup(g.id,'renamed');await b.getPeerStore(g.id).sync(g.baseUrl);assert.equal(b.getPeerStore(g.id).state().name,'renamed');
 await assert.rejects(b.deleteGroup(g.id),/creator/);await a.deleteGroup(g.id);assert.equal(b.getPeerStore(g.id).state().dissolved,true);assert.equal(a.listGroups().length,0);assert.equal(gb.mode,'peer');
});
test('legacy upgrade retains more than one history page and refuses old guest credentials',async t=>{
 const{make}=await setup(t),a=await make('a'),g=await a.createGroup('peer');
 // Create an actual legacy manager, independent of the peer default fixture.
 const legacyRoot=await mkdtemp(path.join(os.tmpdir(),'pickdrop-upgrade-'));const legacy=await createGroupManager({dataDir:legacyRoot,device:{id:randomUUID(),name:'old',kind:'desktop'},host:'127.0.0.1',directoryPort:0,discoveryFactory:async()=>({list:()=>[],refresh(){},async close(){}}),monitorIntervalMs:600000});t.after(async()=>{await legacy.close({force:true});await rm(legacyRoot,{recursive:true,force:true});});
 const old=await legacy.createGroup('legacy'),oldGuest=await join(legacy,a,old);
 const body=Buffer.from('legacy-file'),fileResponse=await fetch(old.baseUrl+'/api/files?name=old.bin',{method:'POST',headers:{'X-Room-Key':old.key,'X-Device-Id':legacy.device.id},body});const oldFile=await fileResponse.json();
 const{mkdir}=await import('node:fs/promises');await mkdir(path.join(legacyRoot,'groups',old.id,'peer.json'));await assert.rejects(legacy.upgradeGroup(old.id));assert.equal(legacy.listGroups()[0].authVersion,2);assert.ok(await legacy.authenticated(old.id,'/api/state'));await rm(path.join(legacyRoot,'groups',old.id,'peer.json'),{recursive:true});
 for(let n=0;n<105;n++)await legacy.authenticated(old.id,'/api/messages',{method:'POST',body:{text:`old-${n}`}});
 const upgraded=await legacy.upgradeGroup(old.id);assert.equal(upgraded.id,old.id);assert.equal(upgraded.mode,'peer');const messages=(await legacy.authenticated(old.id,'/api/state')).messages;assert.equal(messages.length,106);assert.equal(messages[1].text,'old-0');assert.equal(messages.at(-1).text,'old-104');
 const revoked=await fetch(upgraded.baseUrl+'/api/state',{headers:{'X-Room-Key':oldGuest.key,'X-Device-Id':a.device.id}});assert.equal(revoked.status,401);const{readFile}=await import('node:fs/promises');assert.deepEqual(await readFile(await legacy.preparePeerFile(old.id,oldFile.id)),body);
});
test('legacy forgetting permits explicitly approved credential reset and preserves other membership',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pickdrop-reset-'));const all=[];const make=async name=>{const m=await createGroupManager({dataDir:path.join(root,name),device:{id:randomUUID(),name,kind:'desktop'},host:'127.0.0.1',directoryPort:0,discoveryFactory:async()=>({list:()=>[],refresh(){},async close(){}}),monitorIntervalMs:600000});all.push(m);return m;};t.after(async()=>{await Promise.all(all.map(m=>m.close({force:true})));await rm(root,{recursive:true,force:true});});
 const host=await make('h'),guest=await make('g'),group=await host.createGroup('legacy'),first=await join(host,guest,group);await guest.forgetGroup(group.id);const invite=await host.createInvite(group.id),ticket=await guest.joinAt(group.baseUrl,invite.code);assert.equal((await host.listJoinRequests(group.id))[0].reset,true);await host.respondJoin(group.id,ticket.requestId,true);const next=(await guest.checkJoin(ticket)).group;assert.notEqual(next.key,first.key);
 const denied=await fetch(group.baseUrl+'/api/state',{headers:{'X-Room-Key':first.key,'X-Device-Id':guest.device.id}});assert.equal(denied.status,401);assert.ok(await guest.authenticated(group.id,'/api/state'));
});
test('each sync reauthenticates before sending history even when an old peer IP is reused',async t=>{
 const{make}=await setup(t),a=await make('a'),b=await make('b'),g=await a.createGroup('private'),gb=await join(a,b,g);await a.getPeerStore(g.id).sync(gb.baseUrl);await b.close({force:true});
 await a.authenticated(g.id,'/api/messages',{method:'POST',body:{text:'not-for-impostor'}});
 const{createServer}=await import('node:http'),captured=[];const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;captured.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');});
 await new Promise(resolve=>server.listen(Number(new URL(gb.baseUrl).port),'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 assert.equal(await a.getPeerStore(g.id).sync(gb.baseUrl),false);assert.equal(captured.length,1);assert.deepEqual(captured[0].payload.events,[]);assert.deepEqual(captured[0].payload.known,[]);assert.equal(captured[0].payload.peers,undefined);assert.equal(JSON.stringify(captured).includes('not-for-impostor'),false);
});
test('offline dissolution stays durable and propagates after creator and member restart',async t=>{
 const{make}=await setup(t);let a=await make('a'),b=await make('b');const g=await a.createGroup('pending');await join(a,b,g);await b.close({force:true});
 await assert.rejects(a.deleteGroup(g.id),e=>e.status===409);assert.equal(a.listGroups()[0].pendingDeparture,'dissolve');await a.close({force:true});
 a=await make('a');b=await make('b');assert.equal(a.getPeerStore(g.id).state().dissolved,true);await a.reconnectGroup(g.id,b.listGroups()[0].baseUrl);assert.equal(b.getPeerStore(g.id).state().dissolved,true);await a.deleteGroup(g.id);assert.equal(a.listGroups().length,0);
});
