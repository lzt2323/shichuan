import stringWidth from 'string-width';
import { terminalText } from './common.js';
import { fileSize } from '../../shared/protocol.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const cells = value => stringWidth(terminalText(value));
export const graphemes = value => [...segmenter.segment(terminalText(value))].map(part => part.segment);
// Preserve complete grapheme clusters while honoring the protocol's UTF-16 limit.
export function limitText(value, maxLength = 10000) {
  let result = '';
  for (const part of graphemes(value)) { if (result.length + part.length > maxLength) break; result += part; }
  return result;
}
export function clipText(value, width, tail = false) {
  width = Math.max(0, width);
  const clean = terminalText(value).replace(/\n/g, ' ');
  if (cells(clean) <= width) return clean;
  if (!width) return '';
  let result = '', used = 0;
  const parts = graphemes(clean); if (tail) parts.reverse();
  for (const part of parts) { const size = cells(part); if (used + size > width - 1) break; result = tail ? part + result : result + part; used += size; }
  return tail ? '…' + result : result + '…';
}
export function wrapText(value, width) {
  width = Math.max(1, width);
  const lines = [];
  for (const paragraph of terminalText(value).split('\n')) {
    let line = '', used = 0;
    for (const part of graphemes(paragraph)) {
      const size = cells(part);
      if (used + size > width && line) { lines.push(line); line = ''; used = 0; }
      if (size > width) { lines.push('�'); continue; }
      line += part; used += size;
    }
    lines.push(line);
  }
  return lines;
}
export function getLayout(width = 80, height = 24) {
  const columns = Math.max(1, Math.floor(width) - 1), rows = Math.max(1, Math.floor(height) - 1);
  const kind = width < 40 || height < 12 ? 'tiny' : height < 26 || width < 100 ? 'compact' : width >= 140 ? 'wide' : 'medium';
  const leftWidth = ['wide', 'medium'].includes(kind) ? 24 : 0, rightWidth = kind === 'wide' ? 30 : 0;
  const mainWidth = columns - leftWidth - rightWidth - Number(!!leftWidth) - Number(!!rightWidth);
  const bodyHeight = Math.max(1, rows - 5), contentHeight = Math.max(1, bodyHeight - 4);
  return { kind, columns, rows, leftWidth, rightWidth, mainWidth, bodyHeight, contentHeight };
}
export function groupTransfers(snapshot, groupId) { return (snapshot.transfers || []).filter(task => groupId && task.groupId === groupId); }
export const taskStatus = task => ({ queued: '等待', waiting: '等待在线副本', running: task.type === 'download' ? '下载中' : '上传中', done: '完成', failed: '失败', cancelled: '已取消' }[task.status] || task.status);
// Snapshot objects are replaced by polling. Cache immutable display rows by message
// content, rather than object identity, so each keystroke does not segment history.
const messageCache = new Map();
const cacheRowLimit = 20000;
let cacheRows = 0;
export function messageLines(messages, width, deviceId) {
  const lines = [];
  for (const message of messages) {
    const key = `${width}:${deviceId}:${message.id}`;
    const signature = [message.createdAt, message.senderName, message.senderId, message.type, message.fileName, message.size, message.text];
    let cached = messageCache.get(key);
    if (!cached || !signature.every((value, i) => value === cached.signature[i])) {
      const block = [];
      const time = new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      for (const line of wrapText(`${time}  ${message.senderName || '未知设备'}${message.senderId === deviceId ? ' · 我' : ''}`, width)) block.push({ text: line, tone: 'accent' });
      if (message.type === 'file') {
        for (const line of wrapText(`▣ ${message.fileName}`, width)) block.push({ text: line, bold: true });
        for (const line of wrapText(`${fileSize(message.size)} · 已存入群主机`, width)) block.push({ text: line, tone: 'muted' });
      } else for (const line of wrapText(message.text, width)) block.push({ text: line });
      block.push({ text: '' });
      if (cached) { cacheRows -= cached.lines.length; messageCache.delete(key); }
      cached = { signature, lines: block };
      if (block.length <= cacheRowLimit) {
        messageCache.set(key, cached); cacheRows += block.length;
        while (cacheRows > cacheRowLimit) { const oldest = messageCache.keys().next().value; cacheRows -= messageCache.get(oldest).lines.length; messageCache.delete(oldest); }
      }
    }
    for (const line of cached.lines) lines.push(line);
  }
  if (lines.length) lines.pop();
  return lines;
}
