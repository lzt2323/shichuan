import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createPeerReplica, PEER_PROTOCOL, canonical } from '../shared/peer-protocol.js';
import { downloadVerified, verifyLocalFile } from '../shared/download.js';
import { readJsonWithBackup, writeJsonWithBackup } from './persistence.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function read(req) { const chunks = []; let count = 0; for await (const chunk of req) { count += chunk.length; if (count > 16 * 1024 * 1024) throw fail(413, '同步数据过大'); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks)); } catch { throw fail(400, '无效同步请求'); } }
export async function openPeerStore({ dataDir, identity, device, genesis, events, onChange = () => {}, request, endpoint = () => null, localAddress = () => undefined, acquireTransfer = () => () => {} }) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'peer.json');
  const saved = await readJsonWithBackup(file, value => value?.genesis?.protocol === PEER_PROTOCOL && Array.isArray(value.events), { recover: false });
  let replica = createPeerReplica({ identity, device, genesis: saved?.genesis || genesis, events: saved?.events || events || [], randomBytes });
  if (saved && events?.length) replica.merge(events);
  const knowledge = new Map();
  const peers = new Map((saved?.peers || []).filter(p => p?.deviceId !== device.id).map(p => [p.baseUrl, p]));
  let inbox, queue = Promise.resolve(), closed = false;
  const transfers=new Map(), rates=new Map();
  const beginTransfer=()=>{if(closed)throw fail(503,'设备服务已关闭');const release=acquireTransfer(),controller=new AbortController();let done;const finished=new Promise(resolve=>{done=resolve;});transfers.set(controller,finished);return{signal:controller.signal,finish(){transfers.delete(controller);release();done();}};};
  const rate=(req,kind,maximum)=>{const key=`${kind}:${req.socket.remoteAddress}`,value=rates.get(key);const current=value&&value.until>Date.now()?value:{count:0,until:Date.now()+60000};if(++current.count>maximum)throw fail(429,'请求过多，请稍后重试');rates.set(key,current);for(const[k,v]of rates)if(v.until<Date.now())rates.delete(k);};
  const persist = () => writeJsonWithBackup(file, { ...replica.snapshot(), peers: [...peers.values()].map(({ online, ...p }) => p) });
  const serial = fn => { const job = queue.catch(() => {}).then(fn); queue = job; return job; };
  const change = () => { inbox?.refreshPeerState(); onChange(replica.state()); };
  const remember = peer => {
    if (!peer || peer.deviceId === device.id || typeof peer.baseUrl !== 'string') return;
    try { const u = new URL(peer.baseUrl); if (u.protocol !== 'http:' || u.username || u.password || u.pathname !== '/') return; peers.set(u.origin, { deviceId: peer.deviceId, baseUrl: u.origin, online: Boolean(peer.online) }); } catch { /* Untrusted reachability hint. */ }
    if (peers.size > 128) peers.delete(peers.keys().next().value);
  };
  const snapshotPayload = known => {
    const snapshot = replica.snapshot();
    let batch = {};
    if (Array.isArray(known)) { const present = new Set(known), missing = snapshot.events.filter(e => !present.has(e.eventId)); batch = {events:missing.slice(0,128),known:snapshot.events.map(e=>e.eventId),hasMore:missing.length>128}; }
    return {...snapshot,...batch,peers:[...peers.values()].map(({deviceId,baseUrl})=>({deviceId,baseUrl})),endpoint:endpoint()?{deviceId:device.id,baseUrl:endpoint()}:null};
  };
  async function mutation(fn) {
    return serial(async () => {
      const before = replica.checkpoint();
      try { const result = await fn(); await persist(); change(); return result; }
      catch (error) { replica.restore(before); throw error; }
    });
  }
  const api = {
    state: () => replica.state(), snapshot: () => replica.snapshot(),
    peers: () => [...peers.values()].map(p=>({...p})),
    bindInbox(value) { inbox = value; },
    async initialize() { await persist(); },
    async appendMessage(message) { await mutation(() => replica.append('message', message)); },
    append: (type,payload) => mutation(() => replica.append(type,payload)),
    remember,
    createInvite: () => replica.createInvite(),
    listJoinRequests: () => replica.listJoinRequests(),
    respondJoin: (id,allow) => mutation(() => replica.respondJoin(id,allow)),
    async sync(baseUrl) {
      if (closed || baseUrl === endpoint()) return false;
      let authenticated=false;
      for(let page=0;page<16&&!closed;page++) {
        let result;
        try { result = await request(baseUrl, `/api/peer/sync?group=${replica.state().id}`, {method:'POST',body:replica.proof('sync',authenticated ? snapshotPayload(knowledge.get(baseUrl) || []) : {genesis:replica.snapshot().genesis,events:[],known:[]})}); }
        catch { const p=peers.get(baseUrl);if(p)p.online=false;return false; }
        let more=false, revokedSender=false;const wasAuthenticated=authenticated;
        try {
          await mutation(() => {
            const payload = replica.verifyProof(result,'sync-result',{allowUnknown:true});
            const wasMember=replica.state().members.some(m=>m.id===result.senderDeviceId&&m.publicKey===result.senderPublicKey);
            if (canonical(payload.genesis) !== canonical(replica.snapshot().genesis)) throw fail(401,'群身份不匹配');
            replica.merge(payload.events);
            const currentMember=replica.state().members.some(m=>m.id===result.senderDeviceId&&m.publicKey===result.senderPublicKey);
            if (!wasMember && !currentMember) throw fail(403,'对方不是当前群成员');
            if (!currentMember) {revokedSender=true;return;}
            authenticated=true;remember({deviceId:result.senderDeviceId,baseUrl,online:true});
            for(const p of payload.peers||[]) remember(p);
            if(Array.isArray(payload.known))knowledge.set(baseUrl,payload.known);
            else if(Array.isArray(payload.accepted))knowledge.set(baseUrl,[...new Set([...(knowledge.get(baseUrl)||[]),...payload.accepted])]);
            more=Boolean(!wasAuthenticated||payload.hasMore||payload.needsMembership||replica.snapshot().events.some(e=>!(knowledge.get(baseUrl)||[]).includes(e.eventId)));
          });
          if(revokedSender)return false;
          if(!more)return true;
        } catch {const p=peers.get(baseUrl);if(p)p.online=false;return false;}
      }
      return false; // A bounded page round is not a durable acknowledgement of the complete log.
    },
    async syncAll() { let acknowledged=0;for(const p of [...peers.values()]) if(!closed && await api.sync(p.baseUrl))acknowledged++;return acknowledged; },
    async prepareFile(id, {signal} = {}) {
      const transfer=beginTransfer();
      if(signal)transfer.signal=AbortSignal.any([transfer.signal,signal]);
      try {
        const message = replica.state().messages.find(m=>m.id===id && m.type==='file' && !m.deleted); if(!message)throw fail(404,'找不到文件');
        const folder=path.join(dataDir,'files',id), target=path.join(folder,message.fileName);
        if(await verifyLocalFile(target,message))return target;
        for(const peer of [...peers.values()].sort((a,b)=>Number(b.online)-Number(a.online))) {
          transfer.signal.throwIfAborted();
          const partial=path.join(folder,`.peer-${randomBytes(8).toString('hex')}`);
          try {
            await fs.mkdir(folder,{recursive:true,mode:0o700});
            const proof=replica.proof('file',{id});
            await downloadVerified({url:`${peer.baseUrl}/api/peer/files/${id}?group=${replica.state().id}`,headers:{'X-Peer-Proof':JSON.stringify(proof)},destination:partial,size:message.size,sha256:message.sha256,signal:transfer.signal,localAddress:localAddress(),responseTimeoutMs:5000});
            await fs.rename(partial,target);return target;
          } catch {if(transfer.signal.aborted)throw transfer.signal.reason;}
          finally {await fs.rm(partial,{force:true}).catch(()=>{});}
        }
        throw fail(503,'当前没有在线文件副本，持有设备上线后可重试');
      } finally {transfer.finish();}
    },
    async handle(req,res,url) {
      const route=url.pathname;
      if(!route.startsWith('/api/peer/'))return false;
      if(route==='/api/peer/info'&&req.method==='GET'){json(res,200,{protocol:PEER_PROTOCOL,groupId:replica.state().id,deviceId:device.id});return true;}
      if(route==='/api/peer/pair/request'&&req.method==='POST'){rate(req,'pair',10);const body=await read(req);const ticket=replica.requestJoin(body);onChange(replica.state());json(res,202,ticket);return true;}
      if(route.startsWith('/api/peer/pair/status/')&&req.method==='GET'){const result=replica.checkJoin(route.slice('/api/peer/pair/status/'.length),req.headers['x-poll-token']);
        if(result.status==='approved'){const offset=Math.max(0,Number(url.searchParams.get('offset'))||0),all=result.group.peer.events;result.group.peer.events=all.slice(offset,offset+128);result.group.peer.nextOffset=offset+result.group.peer.events.length;result.group.peer.hasMore=result.group.peer.nextOffset<all.length;}
        json(res,200,result);return true;}
      if(route==='/api/peer/sync'&&req.method==='POST'){
        rate(req,'sync',240);const proof=await read(req);let result;
        await mutation(()=>{
          const payload=replica.verifyProof(proof,'sync',{allowUnknown:true});
          const wasMember=replica.state().members.some(m=>m.id===proof.senderDeviceId&&m.publicKey===proof.senderPublicKey);
          if(canonical(payload.genesis)!==canonical(replica.snapshot().genesis))throw fail(401,'群身份不匹配');
          replica.merge(payload.events);
          const memberNow=replica.state().members.some(m=>m.id===proof.senderDeviceId&&m.publicKey===proof.senderPublicKey);
          if(memberNow){remember({...payload.endpoint,deviceId:proof.senderDeviceId,online:true});for(const p of payload.peers||[])remember(p);}
          const stillMember=replica.state().members.some(m=>m.id===proof.senderDeviceId&&m.publicKey===proof.senderPublicKey);
          result=replica.proof('sync-result',stillMember ? snapshotPayload(payload.known) : {genesis:replica.snapshot().genesis,events:[],accepted:payload.events.map(e=>e.eventId),needsMembership:!wasMember,revoked:wasMember});
        });json(res,200,result);return true;
      }
      if(route.startsWith('/api/peer/files/')&&req.method==='GET'){
        let proof;try{proof=JSON.parse(req.headers['x-peer-proof']||'');}catch{throw fail(401,'缺少设备证明');}
        const payload=replica.verifyProof(proof,'file'),id=route.slice('/api/peer/files/'.length);if(payload.id!==id)throw fail(401,'文件请求不匹配');
        const message=replica.state().messages.find(m=>m.id===id&&m.type==='file');if(!message)throw fail(404,'找不到文件');
        const target=path.join(dataDir,'files',id,message.fileName),stat=await fs.stat(target).catch(()=>null);if(!stat||stat.size!==message.size)throw fail(404,'此设备没有文件副本');
        const transfer=beginTransfer();try{const {createReadStream}=await import('node:fs');const {pipeline}=await import('node:stream/promises');res.writeHead(200,{'Content-Length':stat.size,'Content-Type':'application/octet-stream','X-Content-SHA256':message.sha256});await pipeline(createReadStream(target),res,{signal:transfer.signal});return true;}finally{transfer.finish();}
      }
      throw fail(404,'未知点对点接口');
    },
    async close(){closed=true;for(const controller of transfers.keys())controller.abort(new Error('网络已切换或设备已关闭'));await Promise.allSettled([...transfers.values()]);await queue.catch(()=>{});},
  };
  return api;
}
