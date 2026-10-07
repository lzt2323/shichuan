import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createLanDiscovery, discoveryTxt, parseDiscoveredService } from '../server/discovery.js';
import { createDiscoveryDirectory, probeDirectory, directoryHosts, parseConnectionAddress, manualGroupCandidates } from '../server/discovery-directory.js';

test('each replica advertises a distinct bounded DNS-SD instance for the same group', async t => {
  const groupId = randomUUID(), publications = [];
  class Bonjour {
    server = { mdns: new EventEmitter() };
    find() { return { update() {}, stop() {} }; }
    publish(options) { publications.push(options); return { host: options.host, records: () => [], stop() {} }; }
    unpublishAll(done) { done(); }
    destroy(done) { done(); }
  }
  for (const address of ['192.168.1.10', '192.168.1.11']) {
    const entry = { groupId, hostDeviceId: randomUUID(), port: 48888, name: '同一群', peerProtocol: 'pickdrop-peer-v1', secret: 'must-not-announce' };
    const discovery = await createLanDiscovery({ getAnnouncements: () => [entry], onRecord() {}, interfaceAddress: address, BonjourImpl: Bonjour, udp: false });
    t.after(() => discovery.close());
  }
  assert.equal(publications.length, 2);
  assert.notEqual(publications[0].name, publications[1].name);
  assert.notEqual(publications[0].host, publications[1].host);
  for (const entry of publications) {
    assert.ok(Buffer.byteLength(entry.name) <= 63);
    assert.equal(entry.txt.peerProtocol, 'pickdrop-peer-v1');
    assert.equal(JSON.stringify(entry).includes('must-not-announce'), false);
    const records = parseDiscoveredService({ txt: entry.txt, addresses: ['192.168.1.10'], port: 48888 });
    assert.equal(records[0].peerProtocol, 'pickdrop-peer-v1');
  }
  assert.equal(discoveryTxt({ groupId, hostDeviceId: randomUUID(), peerProtocol: 'unknown' }).peerProtocol, undefined);
});

test('directory preserves replica hints without exposing credentials', async t => {
  const groupId = randomUUID(), entries = [0, 1].map(i => ({ groupId, hostDeviceId: randomUUID(), name: '共享群', port: 48000 + i, peerProtocol: 'pickdrop-peer-v1', privateKey: 'private', key: 'secret' }));
  const directory = await createDiscoveryDirectory({ address: '127.0.0.1', port: 0, getAnnouncements: () => entries });
  t.after(() => directory.close());
  const records = await probeDirectory('127.0.0.1', { port: directory.port });
  assert.equal(records.length, 2);
  assert.notEqual(records[0].hostDeviceId, records[1].hostDeviceId);
  assert.ok(records.every(record => record.peerProtocol === 'pickdrop-peer-v1'));
  assert.equal(JSON.stringify(records).includes('secret'), false);
  assert.equal(JSON.stringify(records).includes('private'), false);
});

test('manual IP discovery crosses a /24 boundary without scanning the /16', async () => {
  const groupId = randomUUID(), calls = [];
  assert.equal(directoryHosts({ address: '172.29.9.5', netmask: '255.255.0.0' }).includes('172.29.5.94'), false);
  const candidates = await manualGroupCandidates('172.29.5.94', { localAddress: '172.29.9.5', expectedGroupId: groupId, probe: async (address, options) => {
    calls.push({ address, ...options });
    return options.port === 47323 ? [{ groupId, baseUrl: 'http://172.29.5.94:51000' }, { groupId: randomUUID(), baseUrl: 'http://172.29.5.94:51001' }] : [];
  } });
  assert.deepEqual(candidates, ['http://172.29.5.94:51000', 'http://172.29.5.94']);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.address === '172.29.5.94' && call.localAddress === '172.29.9.5'));
  assert.deepEqual(calls.map(call => call.port), [47321, 47322, 47323, 47324]);
});

test('manual address parsing preserves explicit ports and validates invitations', async () => {
  const id = randomUUID();
  assert.deepEqual(parseConnectionAddress('172.29.5.94:51000'), { address: '172.29.5.94', origin: 'http://172.29.5.94:51000', explicitPort: true });
  assert.equal(parseConnectionAddress('http://172.29.5.94:80').explicitPort, true);
  const parsed = parseConnectionAddress(`http://172.29.5.94:51000/#invite=123456&group=${id}`);
  assert.equal(parsed.groupId, id); assert.equal(parsed.code, '123456');
  for (const address of ['', 'http://user:password@172.29.5.94', 'file:///etc/passwd', 'http://172.29.5.94/file', 'http://172.29.5.94/#invite=bad', 'http://172.29.5.94/#group=bad']) assert.throws(() => parseConnectionAddress(address));
  const candidates = await manualGroupCandidates('172.29.5.94:51000', { probe: async () => [{ groupId: id, baseUrl: 'http://172.29.5.94:52000' }] });
  assert.deepEqual(candidates, ['http://172.29.5.94:51000', 'http://172.29.5.94:52000']);
  const controller = new AbortController(); controller.abort(); let probed = false;
  await assert.rejects(manualGroupCandidates('172.29.5.94', { signal: controller.signal, probe: async () => { probed = true; return []; } }), { name: 'AbortError' });
  assert.equal(probed, false);
});
