#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { rpc, ensureDaemon } from './rpc.js';
import { locations, terminalText, expandPath } from './common.js';
import { installLauncher, uninstallLauncher, shellQuote } from './launcher.js';

const help = `拾传 PickDrop · Linux TUI / CLI

pickdrop                           打开终端群窗口（退出时停止本次服务）
pickdrop open                      打开终端群窗口
pickdrop install [--bin-dir PATH]   安装快捷命令（默认 ~/.local/bin）
pickdrop uninstall [--bin-dir PATH] 移除由拾传安装的快捷命令
pickdrop --background              打开界面，退出后后台继续传输
pickdrop start                     启动后台服务
pickdrop status                    查询状态，不自动启动服务
pickdrop stop                      停止服务及未完成传输
pickdrop create "工作群"           创建群
pickdrop nearby                    查看附近的群
pickdrop join --link "完整邀请链接" 申请加入，等待群成员批准
pickdrop join --address URL --code 123456
pickdrop invite --group "工作群"   显示一次性邀请码和完整链接
pickdrop requests --group "工作群" 查看待批准的设备
pickdrop approve REQUEST_ID --group "工作群" [--deny]
pickdrop message "你好" --group "工作群"
pickdrop messages --group "工作群" 查看文件 ID 与消息
pickdrop send ./file.zip --group "工作群" [--wait]
pickdrop receive FILE_ID --group "工作群" [--dir ~/Downloads] [--wait]
pickdrop receive --all --group "工作群" [--dir ~/Downloads] [--wait]
pickdrop cancel TASK_ID / retry TASK_ID
pickdrop networks                  查看网卡
pickdrop network --auto            自动选择网卡
pickdrop network --interface eth0 --address 192.168.1.20
pickdrop service install           写入可选 systemd 用户服务（不会自动启用）

后台已启动时，退出 TUI 不会停止它。CLI 操作前请先 pickdrop start。
发送成功表示文件已存入群主机；接收文件校验 SHA-256，同名另存。
接收默认沿用上次保存目录，首次为 ~/Downloads/拾传。
SSH 下文件属于远端 Linux。传输取消后重试会从头开始，不支持断点续传。
`;
const print = value => process.stdout.write(terminalText(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
async function waitTasks(ids) {
  for (;;) {
    const { transfers } = await rpc('status'), tasks = ids.map(({ id }) => transfers.find(t => t.id === id));
    if (tasks.some(t => !t)) throw new Error('服务已重启，传输记录不再存在，请重新发送');
    if (tasks.every(t => !['queued', 'running'].includes(t.status))) { print(tasks); if (tasks.some(t => t.status !== 'done')) process.exitCode = 1; return; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}
function unitQuote(value) { return '"' + value.replace(/%/g, '%%').replace(/[\\"]/g, '\\$&') + '"'; }
async function main() {
  const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, group: { type: 'string' }, link: { type: 'string' }, code: { type: 'string' }, address: { type: 'string' }, dir: { type: 'string' }, 'bin-dir': { type: 'string' }, interface: { type: 'string' }, auto: { type: 'boolean' }, all: { type: 'boolean' }, deny: { type: 'boolean' }, wait: { type: 'boolean' }, foreground: { type: 'boolean' }, background: { type: 'boolean' },
  } });
  const [command, ...args] = positionals;
  if (flags.help || command === 'help') return print(help);
  if (flags.version) return print(JSON.parse(await fs.readFile(new URL('./package.json', import.meta.url), 'utf8')).version);
  if (command === 'install' || command === 'uninstall') {
    const options = flags['bin-dir'] ? { binDirectory: expandPath(flags['bin-dir']) } : {};
    if (command === 'uninstall') { const result = await uninstallLauncher(options); return print(result.removed ? `已移除快捷命令：${result.destination}` : '快捷命令未安装。'); }
    const result = await installLauncher(options);
    print(`已安装快捷命令：${result.destination}\n打开界面：pickdrop open\n后台启动：pickdrop start\n关闭服务：pickdrop stop\n请将当前应用目录保留在固定位置。`);
    if (!result.onPath) print(`当前 PATH 尚未包含安装目录。当前终端运行：\n${result.pathCommand}\n永久生效，按当前 Shell 选择一条运行后重新打开终端：\nBash: printf '%s\\n' ${shellQuote(result.pathCommand)} >> ~/.bashrc\nZsh:  printf '%s\\n' ${shellQuote(result.pathCommand)} >> ~/.zshrc`);
    return;
  }
  if (command === 'daemon') {
    const { createDaemon } = await import('./daemon.js'); const daemon = await createDaemon();
    process.once('SIGTERM', () => void daemon.close()); process.once('SIGINT', () => void daemon.close()); return;
  }
  if (command === 'service') {
    if (args[0] !== 'install' || process.platform !== 'linux') throw new Error('Linux 上使用 pickdrop service install');
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user'); await fs.mkdir(dir, { recursive: true });
    const unit = `[Unit]\nDescription=PickDrop LAN transfer service\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${unitQuote(process.execPath)} ${unitQuote(fileURLToPath(import.meta.url))} daemon --foreground\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
    await fs.writeFile(path.join(dir, 'pickdrop.service'), unit, { mode: 0o600 });
    return print('已写入 systemd 用户服务。请将安装目录保留在固定位置。\n先 pickdrop stop，再运行：\nsystemctl --user daemon-reload\nsystemctl --user enable --now pickdrop\n无登录常驻需要管理员按需启用用户 linger。');
  }
  if (command === 'start') { await ensureDaemon(); return print('后台服务已启动；pickdrop stop 停止。'); }
  if (!command || command === 'open') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) { print(help); return; }
    let owned;
    try { await rpc('status', {}, { timeout: 1000 }); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      if (flags.background) await ensureDaemon();
      else { const { createDaemon } = await import('./daemon.js'); owned = await createDaemon(); }
    }
    try { const { startUI } = await import('./ui.js'); await startUI({ persistent: !owned }); }
    finally { await owned?.close(); }
    return;
  }
  if (command === 'status') {
    try { return print(await rpc('status')); }
    catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return print({ running: false, message: '后台未启动；运行 pickdrop 或 pickdrop start' }); throw error; }
  }
  const group = flags.group;
  if (command === 'stop') {
    try { return print(await rpc('stop')); }
    catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return print({ stopped: true, message: '服务已停止' }); throw error; }
  }
  if (command === 'create') return print(await rpc('create', { name: args.join(' ') }));
  if (command === 'nearby' || command === 'networks') return print(await rpc(command));
  if (command === 'network') { if (!flags.auto && (!flags.interface || !flags.address)) throw new Error('使用 --auto 或同时指定 --interface 和 --address'); return print(await rpc('network', { selection: flags.auto ? { mode: 'auto' } : { mode: 'manual', interfaceName: flags.interface, address: flags.address } })); }
  if (command === 'join') return print(await rpc('join', { link: flags.link, address: flags.address, code: flags.code }));
  if (command === 'invite') return print(await rpc('invite', { group }));
  if (command === 'requests') return print((await rpc('snapshot', { group })).requests);
  if (command === 'approve') return print(await rpc('respond', { group, requestId: args[0], allow: !flags.deny }));
  if (command === 'message') return print(await rpc('text', { group, text: args.join(' ') }));
  if (command === 'messages') return print(await rpc('messages', { group }));
  if (command === 'cancel' || command === 'retry') return print(await rpc(command, { id: args[0] }));
  if (command === 'send' || command === 'receive') {
    const tasks = await rpc(command, command === 'send' ? { group, files: args.map(file => expandPath(file)) } : { group, messageId: args[0], all: flags.all, ...(flags.dir !== undefined ? { directory: expandPath(flags.dir) } : {}) });
    return flags.wait ? waitTasks(tasks) : print(tasks);
  }
  throw new Error('未知命令，使用 pickdrop --help 查看用法');
}
main().catch(error => { process.stderr.write(terminalText(['ENOENT', 'ECONNREFUSED'].includes(error.code) ? '后台未启动，请先运行 pickdrop start' : error.message) + '\n'); process.exitCode = 1; });
