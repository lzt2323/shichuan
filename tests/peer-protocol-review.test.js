import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPeerIdentity, createPeerGenesis, createPeerJoinProof, createPeerReplica } from '../shared/peer-protocol.js';

function fixture() {
  const a = { identity: createPeerIdentity(), device: { id: randomUUID(), name: 'creator', kind: 'desktop' } };
  const b = { identity: createPeerIdentity(), device: { id: randomUUID(), name: 'phone', kind: 'android' } };
  const genesis = createPeerGenesis({ groupId: randomUUID(), name: 'protocol review', ...a });
  const host = createPeerReplica({ genesis, ...a });
  const join = () => {
    const invite = host.createInvite(), ticket = host.requestJoin(createPeerJoinProof(b.identity, invite.code, b.device));
    host.respondJoin(ticket.requestId, true);
    return ticket;
  };
  const ticket = join();
  const guest = createPeerReplica({ ...host.snapshot(), ...b });
  const say = (replica, device, text) => replica.append('message', { id: randomUUID(), type: 'text', senderId: device.id, senderName: device.name, createdAt: new Date().toISOString(), text });
  return { a, b, host, guest, ticket, join, say };
}

test('revoked membership invalidates previously approved polling tickets', () => {
  const { host, guest, ticket, a, b, say } = fixture();
  host.append('member.remove', { deviceId: b.device.id });
  say(host, a.device, 'private after removal');
  const result = host.checkJoin(ticket.requestId, ticket.pollToken);
  assert.equal(result.status, 'revoked');
  assert.equal(result.group, undefined);
  assert.throws(() => host.verifyProof(guest.proof('file', { id: randomUUID() }), 'file'), /member/i);
});

test('explicitly approved rejoin permits future messages without resurrecting concurrent removed messages', () => {
  const { a, b, host, guest, join, say } = fixture();
  const before = say(guest, b.device, 'before removal'); host.merge([before]);
  host.append('member.remove', { deviceId: b.device.id });
  const concurrent = say(guest, b.device, 'unaware of removal'); host.merge([concurrent]);
  join();
  const returned = createPeerReplica({ ...host.snapshot(), ...b });
  const after = say(returned, b.device, 'after approved rejoin'); host.merge([after]);
  const texts = host.state().messages.map(message => message.text);
  assert.ok(texts.includes('before removal'));
  assert.ok(!texts.includes('unaware of removal'));
  assert.ok(texts.includes('after approved rejoin'));
  say(host, a.device, 'creator still active');
});

test('voluntary leave followed by approval can send again in the same group', () => {
  const { b, host, guest, join, say } = fixture();
  const leave = guest.append('member.leave', {}); host.merge([leave]);
  join();
  guest.merge(host.snapshot().events);
  const message = say(guest, b.device, 'joined again'); host.merge([message]);
  assert.ok(host.state().messages.some(value => value.text === 'joined again'));
});

test('partitioned appends converge regardless of merge arrival order and reject tampering atomically', () => {
  const { a, b, host, guest, say } = fixture();
  const hostMessage = say(host, a.device, 'partition A');
  const guestMessage = say(guest, b.device, 'partition B');
  host.merge([guestMessage]); guest.merge([hostMessage]);
  assert.deepEqual(host.state(), guest.state());
  const saved = host.snapshot();
  const bad = { ...guestMessage, payload: { ...guestMessage.payload, text: 'tampered' } };
  assert.throws(() => host.merge([bad]));
  assert.deepEqual(host.snapshot(), saved);
  assert.equal(host.merge(guest.snapshot().events), 0);
});
