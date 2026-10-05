import path from 'node:path';
import { createInboxServer } from './index.js';
const inbox = await createInboxServer({ dataDir: path.resolve(process.env.PICKDROP_DATA || '.pickdrop'), port: Number(process.env.PICKDROP_PORT || 47321) });
console.log(`拾传收件箱已启动：${inbox.baseUrl}`);
console.log('配对地址（仅分享给自己的设备）：');
for (const link of inbox.pairingLinks) console.log(link);
const stop = async () => { await inbox.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
