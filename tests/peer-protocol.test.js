import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPeerIdentity, createPeerGenesis, createPeerReplica, createPeerJoinProof } from '../shared/peer-protocol.js';
function fixture(){
 const make=name=>({device:{id:randomUUID(),name,kind:'desktop'},identity:createPeerIdentity(randomBytes(32).toString('hex'))});
 const owner=make('owner'),guest=make('guest'),third=make('third');
 const genesis=createPeerGenesis({groupId:randomUUID(),name:'peer',...owner});
 const replica=(person,events=[])=>createPeerReplica({...person,genesis,events,randomBytes});
 const a=replica(owner);a.append('member.add',{...guest.device,publicKey:guest.identity.publicKey});a.append('member.add',{...third.device,publicKey:third.identity.publicKey});
 return {owner,guest,third,a,b:replica(guest,a.snapshot().events),c:replica(third,a.snapshot().events),replica};
}
function text(person,value,id=randomUUID()){return{id,type:'text',text:value,senderId:person.device.id,senderName:person.device.name,createdAt:new Date().toISOString()};}
test('partitioned replicas converge without creator and reject tampering atomically',()=>{
 const {a,b,c,guest,third}=fixture();b.append('message',text(guest,'B'));c.append('message',text(third,'C'));
 const before=b.snapshot();assert.throws(()=>b.merge([{...c.snapshot().events.at(-1),payload:text(third,'forged')}]),/signature/);assert.deepEqual(b.snapshot(),before);
 b.merge(c.snapshot().events);c.merge(b.snapshot().events);a.merge(c.snapshot().events);
 assert.deepEqual(a.state().messages,b.state().messages);assert.deepEqual(b.state().messages,c.state().messages);assert.equal(a.state().messages.length,2);
});
test('credential reset quarantines old key concurrent messages but retains causal history',()=>{
 const {a,b,guest,replica}=fixture();b.append('message',text(guest,'before'));a.merge(b.snapshot().events);
 const replacement={...guest,identity:createPeerIdentity(randomBytes(32).toString('hex'))};a.append('member.add',{...guest.device,publicKey:replacement.identity.publicKey});
 b.append('message',text(guest,'old key after reset'));a.merge(b.snapshot().events);
 const restored=replica(replacement,a.snapshot().events);restored.append('message',text(guest,'new key'));a.merge(restored.snapshot().events);
 assert.deepEqual(a.state().messages.map(m=>m.text),['before','new key']);
});
test('removal quarantines concurrent events, proof rejects stale credential and approved tickets revoke',()=>{
 const {a,b,guest}=fixture();const invite=a.createInvite(),ticket=a.requestJoin(createPeerJoinProof(guest.identity,invite.code,guest.device));a.respondJoin(ticket.requestId,true);
 assert.equal(a.checkJoin(ticket.requestId,ticket.pollToken).status,'approved');
 a.append('member.remove',{deviceId:guest.device.id});b.append('message',text(guest,'partition'));a.merge(b.snapshot().events);
 assert.equal(a.state().messages.length,0);assert.equal(a.checkJoin(ticket.requestId,ticket.pollToken).status,'revoked');assert.throws(()=>a.verifyProof(b.proof('file',{id:randomUUID()}),'file'),/active member/);
});
test('proof rejects invalid timestamps and replay; rollback preserves invitations',()=>{
 const {a,b,guest}=fixture();const proof=b.proof('sync',{});assert.deepEqual(a.verifyProof(proof,'sync'),{});assert.throws(()=>a.verifyProof(proof,'sync'),/Replayed/);
 const invitation=a.createInvite(),checkpoint=a.checkpoint();a.append('rename',{name:'transient'});a.restore(checkpoint);
 assert.equal(a.state().name,'peer');assert.ok(a.requestJoin(createPeerJoinProof(guest.identity,invitation.code,guest.device)).requestId);
 const invalid=b.proof('sync',{});invalid.timestamp=null;assert.throws(()=>a.verifyProof(invalid,'sync'),/Invalid peer proof/);
});
test('concurrent conflicting message IDs cannot overwrite another author',()=>{
 const {a,b,c,guest,third}=fixture(),id=randomUUID();b.append('message',text(guest,'one',id));c.append('message',text(third,'two',id));a.merge(b.snapshot().events);a.merge(c.snapshot().events);assert.equal(a.state().messages.length,0);b.merge(c.snapshot().events);c.merge(b.snapshot().events);assert.deepEqual(b.state(),c.state());
});
test('approved pairing survives invitation expiry and paginated approval snapshot stays fixed',()=>{
 let time=0;const person={device:{id:randomUUID(),name:'owner',kind:'desktop'},identity:createPeerIdentity(randomBytes(32).toString('hex'))},guest={device:{id:randomUUID(),name:'guest',kind:'android'},identity:createPeerIdentity(randomBytes(32).toString('hex'))};
 const genesis=createPeerGenesis({groupId:randomUUID(),name:'stable',...person}),a=createPeerReplica({...person,genesis,now:()=>time,randomBytes});const i=a.createInvite(),ticket=a.requestJoin(createPeerJoinProof(guest.identity,i.code,guest.device));a.respondJoin(ticket.requestId,true);const approved=a.checkJoin(ticket.requestId,ticket.pollToken);a.append('message',text(person,'later'));time=300001;const resumed=a.checkJoin(ticket.requestId,ticket.pollToken);assert.equal(resumed.status,'approved');assert.deepEqual(resumed.group.peer.events,approved.group.peer.events);
});
test('old credential cannot leave or revoke the replacement credential from a concurrent branch',()=>{
 const{a,b,guest,replica}=fixture();const replacement={...guest,identity:createPeerIdentity(randomBytes(32).toString('hex'))};
 a.append('member.add',{...guest.device,publicKey:replacement.identity.publicKey});b.append('member.leave',{});a.merge(b.snapshot().events);
 assert.equal(a.state().members.find(m=>m.id===guest.device.id)?.publicKey,replacement.identity.publicKey);
 const renewed=replica(replacement,a.snapshot().events);renewed.append('message',text(guest,'new identity survives'));a.merge(renewed.snapshot().events);assert.equal(a.state().messages.at(-1).text,'new identity survives');
});
test('ordinary inviter on a stale branch cannot replace a creator-granted identity',()=>{
 const{a,b,guest,third,replica}=fixture();
 // A stale inviter has not observed the victim admission yet.
 const early=a.snapshot().events.filter(e=>!(e.type==='member.add'&&e.payload.id===third.device.id));const stale=replica(guest,early),evil=createPeerIdentity(randomBytes(32).toString('hex'));
 stale.append('message',text(guest,'raise clock'));stale.append('member.add',{...third.device,publicKey:evil.publicKey});a.merge(stale.snapshot().events);
 assert.equal(a.state().members.find(m=>m.id===third.device.id).publicKey,third.identity.publicKey);
 const attacker=replica({...third,identity:evil},stale.snapshot().events);attacker.append('message',text(third,'evil'));a.merge(attacker.snapshot().events);assert.equal(a.state().messages.some(m=>m.text==='evil'),false);const victim=replica(third,a.snapshot().events);victim.append('message',text(third,'real victim'));a.merge(victim.snapshot().events);assert.equal(a.state().messages.at(-1).text,'real victim');
});
test('invalidated inviter authorization quarantines its child grants and descendant messages',()=>{
 const{a,b,guest,replica}=fixture();const child={device:{id:randomUUID(),name:'child',kind:'android'},identity:createPeerIdentity(randomBytes(32).toString('hex'))};
 a.append('member.remove',{deviceId:guest.device.id});b.append('member.add',{...child.device,publicKey:child.identity.publicKey});const c=replica(child,b.snapshot().events);c.append('message',text(child,'must quarantine'));a.merge(c.snapshot().events);
 assert.equal(a.state().members.some(m=>m.id===child.device.id),false);assert.equal(a.state().messages.some(m=>m.text==='must quarantine'),false);
});
