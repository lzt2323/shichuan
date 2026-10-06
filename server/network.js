import os from 'node:os';
import { isIPv4 } from 'node:net';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const isPublicIPv4 = address => isIPv4(address) && !address.startsWith('127.') && address !== '0.0.0.0' && !address.startsWith('169.254.');
function classify(name, description = '', platform = process.platform) {
  const text = `${name} ${description}`.toLowerCase();
  if (/utun|tun\d|tap\d|tailscale|zerotier|wireguard|wg\d|ppp|vpn|ipsec/.test(text)) return 'vpn';
  if (/vmnet|vbox|docker|veth|bridge|br-|hyper-v|virtual|wsl|awdl|llw|anpi|thunderbolt bridge/.test(text)) return 'virtual';
  if (/wi-fi|wifi|wireless|wlan|^wl/.test(text) || (platform === 'linux' && existsSync(`/sys/class/net/${name}/wireless`))) return 'wifi';
  if (/ethernet|^eth\d|^en[psox]/.test(text)) return 'ethernet';
  return 'unknown';
}
export function normalizeInterfaces(raw, { hardware = {}, platform = process.platform } = {}) {
  const result = [];
  for (const [name, entries] of Object.entries(raw)) for (const entry of entries || []) {
    if (!entry || entry.internal || !['IPv4', 4].includes(entry.family) || !isPublicIPv4(entry.address)) continue;
    const description = hardware[name] || entry.description || '', type = classify(name, description, platform);
    result.push({ id: `${name}:${entry.address}`, name, interfaceName: name, description, address: entry.address, netmask: entry.netmask, cidr: entry.cidr, type, virtual: ['vpn', 'virtual'].includes(type), connected: true });
  }
  return result.sort((a, b) => Number(a.virtual) - Number(b.virtual) || ({ wifi: 0, ethernet: 1, unknown: 2, vpn: 3, virtual: 4 }[a.type] - { wifi: 0, ethernet: 1, unknown: 2, vpn: 3, virtual: 4 }[b.type]) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}
let hardwareCache, hardwareTime = 0;
export async function listNetworkInterfaces() {
  if (!hardwareCache || Date.now() - hardwareTime > 60000) {
    const hardware = {};
    try {
      if (process.platform === 'darwin') {
        const { stdout } = await run('/usr/sbin/networksetup', ['-listallhardwareports'], { timeout: 2000 });
        for (const block of stdout.split(/\n\s*\n/)) { const name = block.match(/Device:\s*(\S+)/)?.[1], label = block.match(/Hardware Port:\s*(.+)/)?.[1]; if (name && label) hardware[name] = label; }
      } else if (process.platform === 'win32') {
        const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetAdapter | Select-Object Name,InterfaceDescription | ConvertTo-Json -Compress'], { timeout: 3000, windowsHide: true });
        const adapters = JSON.parse(stdout); for (const adapter of Array.isArray(adapters) ? adapters : [adapters]) hardware[adapter.Name] = adapter.InterfaceDescription;
      }
    } catch { /* Connected IPv4 addresses still remain selectable without labels. */ }
    hardwareCache = hardware; hardwareTime = Date.now();
  }
  return normalizeInterfaces(os.networkInterfaces(), { hardware: hardwareCache });
}
export function chooseNetwork(interfaces, selection = { mode: 'auto' }) {
  if (!selection || !['auto', 'manual'].includes(selection.mode)) throw Object.assign(new Error('请选择自动或指定网络'), { status: 400 });
  if (selection.mode === 'auto') return interfaces.find(item => !item.virtual) || null;
  const found = interfaces.find(item => (selection.id ? item.id === selection.id : item.name === (selection.interfaceName || selection.name) && item.address === selection.address));
  if (!found) throw Object.assign(new Error('所选网卡或 IP 已断开，请刷新网络列表'), { status: 409 });
  return found;
}
// Keep the user's physical adapter when DHCP updates its address. Automatic
// recovery may move to another physical link, but never silently onto a VPN.
export function recoverNetwork(interfaces, selection, previous) {
  if (selection?.mode === 'manual') return interfaces.find(item => item.name === (selection.interfaceName || selection.name) && item.address === selection.address) || previous || null;
  return interfaces.find(item => !item.virtual && item.name === previous?.name && item.address === previous?.address)
    || interfaces.find(item => !item.virtual && item.name === previous?.name)
    || chooseNetwork(interfaces, { mode: 'auto' });
}
export function publicEndpoint(address, port) {
  if (!isPublicIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('当前没有可分享的局域网地址，请选择已连接的网络'), { status: 503 });
  return `http://${address}:${port}`;
}
