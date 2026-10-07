// Regenerate the selected A / Pick-up brand with an externally installed sharp renderer.
// Run: node scripts/generate-brand-assets.js
// If sharp is not resolvable, set PICKDROP_SHARP_MODULE to its absolute module path.
// The geometry below is original vector artwork redrawn from the approved concept.
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require(process.env.PICKDROP_SHARP_MODULE || 'sharp');
} catch (error) {
  // Also support the bundled tooling runtime, without adding a production dependency.
  if (process.env.PICKDROP_SHARP_MODULE) throw error;
  try {
    sharp = require(path.resolve(path.dirname(process.execPath), '../node_modules/sharp'));
  } catch {
    throw new Error('Install sharp outside the project and set PICKDROP_SHARP_MODULE to its module path.');
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'assets/brand');
await mkdir(output, { recursive: true });

const colors = { teal: '#126A5A', mint: '#32C6A2', ivory: '#F3F5EE' };
const hand = 'M133 264 C109 247 96 233 72 233 C42 233 28 253 32 278 C45 357 128 407 228 409 C354 412 427 350 436 240 C440 195 427 167 403 165 C374 163 350 184 329 211 C294 257 254 282 211 283 C179 284 158 280 133 264 Z';
function symbol(handColor, squareColor = handColor, scale = 1) {
  return `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)"><g transform="translate(22 36)"><path fill="${handColor}" d="${hand}"/><rect x="176" y="53" width="145" height="145" rx="30" fill="${squareColor}" transform="rotate(-24 248.5 125.5)"/></g></g>`;
}
function svg(content, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512" role="img" aria-label="${title}"><title>${title}</title>${content}</svg>\n`;
}

const variants = [
  { name: 'mark', body: symbol(colors.teal, colors.mint), title: 'PickDrop 拾传 · 拾点彩色标志', sizes: [1024] },
  { name: 'mark-mono', body: symbol('#000000'), title: 'PickDrop 拾传 · 拾点单色标志', sizes: [1024] },
  { name: 'app-icon', body: `<rect x="0" y="0" width="512" height="512" rx="112" fill="${colors.teal}"/>${symbol(colors.ivory, colors.ivory, 0.84)}`, title: 'PickDrop 拾传 · 应用图标', sizes: [1024, 512, 256, 128, 64, 32, 16] },
  { name: 'mac-icon', body: `<rect x="46" y="48" width="420" height="420" rx="92" fill="#123F35" opacity=".12"/><g transform="translate(256 256) scale(.82) translate(-256 -256)"><rect width="512" height="512" rx="112" fill="${colors.teal}"/>${symbol(colors.ivory, colors.ivory, 0.84)}</g>`, title: 'PickDrop 拾传 · macOS 图标', sizes: [1024, 512, 256, 128, 64, 32, 16] },
  { name: 'mobile-icon', body: `<rect width="512" height="512" fill="${colors.teal}"/>${symbol(colors.ivory, colors.ivory, 0.84)}`, title: 'PickDrop 拾传 · 移动应用图标', sizes: [1024] },
  { name: 'adaptive-foreground', body: symbol(colors.ivory, colors.ivory, 0.63), title: 'PickDrop 拾传 · Android 自适应图标前景', sizes: [1024] },
  { name: 'monochrome-icon', body: symbol('#FFFFFF', '#FFFFFF', 0.63), title: 'PickDrop 拾传 · Android 主题图标', sizes: [1024] },
  { name: 'trayTemplate', body: symbol('#000000', '#000000', 1.08), title: 'PickDrop 拾传 · 托盘模板图标', sizes: [18, 36] },
];

{
  const manifest = { concept: 'A · 拾点 / Pick-up', colors, viewBox: [0, 0, 512, 512], files: [] };
  for (const variant of variants) {
    const source = svg(variant.body, variant.title);
    await writeFile(path.join(output, `${variant.name}.svg`), source);
    for (const size of variant.sizes) {
      const filename = variant.name === 'trayTemplate'
        ? (size === 18 ? 'trayTemplate.png' : 'trayTemplate@2x.png')
        : `${variant.name}${size === 1024 ? '' : `-${size}`}.png`;
      await sharp(Buffer.from(source)).resize(size, size).png().toFile(path.join(output, filename));
      manifest.files.push({ file: filename, width: size, height: size });
    }
  }
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
await copyFile(path.join(output, 'mac-icon.png'), path.join(root, 'apps/desktop/assets/mac-icon.png'));
console.log(`Generated PickDrop brand assets in ${output}`);
