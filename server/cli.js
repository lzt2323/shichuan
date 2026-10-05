import path from 'node:path';
import os from 'node:os';
import { createInboxServer } from './index.js';
import { chooseNetwork, listNetworkInterfaces } from './network.js';

try {
  const interfaces = await listNetworkInterfaces();
  const explicit = process.env.PICKDROP_HOST;
  const localAddresses = Object.values(os.networkInterfaces()).flat().filter(Boolean).filter(item => item.family === 'IPv4').map(item => item.address);
  if (explicit && (explicit === '0.0.0.0' || !localAddresses.includes(explicit))) throw new Error('PICKDROP_HOST 必须是本机已连接的明确 IPv4 地址，不能使用 0.0.0.0');
  const selected = explicit ? { address: explicit, name: 'PICKDROP_HOST' } : chooseNetwork(interfaces);
  if (!selected) throw new Error('没有已连接的 IPv4 网络，请连接 Wi-Fi / 有线网络后重试');
  const inbox = await createInboxServer({ dataDir: path.resolve(process.env.PICKDROP_DATA || '.pickdrop'), host: selected.address, port: Number(process.env.PICKDROP_PORT || 47321) });
  console.log('旧版单收件箱入口；多群、网络选择与短期邀请请使用 pnpm tui。');
  console.log(`已绑定 ${selected.name} · ${inbox.baseUrl}`);
  if (inbox.pairingLinks.length) { console.log('旧版配对地址（含长期凭据，仅交给自己的设备）：'); for (const link of inbox.pairingLinks) console.log(link); }
  else console.log('当前仅供本机访问，不生成可分享邀请地址。');
  const stop = async () => { await inbox.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) { console.error(`拾传未启动：${error.message}`); process.exitCode = 1; }
