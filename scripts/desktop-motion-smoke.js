import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = await mkdtemp(path.join(tmpdir(), 'pickdrop-motion-'));
const app = await electron.launch({ args: ['.'], env: { ...process.env, PICKDROP_USER_DATA: dir } });
const pause = ms => new Promise(r => setTimeout(r, ms));
const errors = [], alphaChecks = {};
app.process().stderr?.on('data', chunk => { const line = chunk.toString(); if (/Error|Exception/.test(line)) console.log('Electron stderr:', line); });
try {
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true');
  await mkdir('artifacts', { recursive: true });
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const state = async () => (await page.evaluate(() => window.pickdrop.bootstrap())).window;
  const point = p => app.evaluate((_electron, p) => { globalThis.__cursor = { x: Math.round(p.x), y: Math.round(p.y) }; }, p);
  await app.evaluate(({ screen }) => { globalThis.__cursor = { x: -10000, y: -10000 }; screen.getCursorScreenPoint = () => ({ ...globalThis.__cursor }); });
  const area = await app.evaluate(({ screen, BrowserWindow }) => screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds()).workArea);
  async function settled(collapsed) {
    for (let i = 0; i < 120; i++) { const s = await state(); if (!s.transition && (collapsed === undefined || s.collapsed === collapsed)) { await pause(30); return s; } await pause(25); }
    throw new Error('Window motion failed to settle');
  }
  async function headerDrag(target, expectedEdge) {
    const before = await bounds(), grip = await page.locator('.window-grip').boundingBox();
    const local = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
    await point({ x: before.x + local.x, y: before.y + local.y });
    await page.mouse.move(local.x, local.y); await page.mouse.down(); await pause(40);
    await point({ x: target.x + local.x, y: target.y + local.y }); await pause(350);
    const held = await state(); assert.equal(held.moving, true); assert.equal(held.candidateEdge, expectedEdge); assert.equal(held.edge, null);
    await page.mouse.up(); await settled(false); assert.equal((await state()).edge, expectedEdge);
  }
  async function collapse(edge) {
    await point({ x: -10000, y: -10000 });
    await page.evaluate(() => { document.activeElement?.blur(); return window.pickdrop.dock(); });
    await settled(true);
    await page.waitForFunction(() => document.documentElement.dataset.pickdropCollapsed === 'true');
    const b = await bounds(); assert.equal((await state()).edge, edge);
    assert.equal(b.width, edge === 'top' ? 24 : 12); assert.equal(b.height, edge === 'top' ? 12 : 24);
    if (edge === 'top') assert.equal(b.y, area.y);
    assert.equal(await page.locator('#pickdrop-native-tab').innerText(), '');
    const capture = await page.screenshot({ path: `artifacts/halfball-${edge}.png`, omitBackground: true, timeout: 10000 });
    alphaChecks[edge] = await app.evaluate(({ nativeImage }, encoded) => {
      const image = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64'));
      const bitmap = image.toBitmap(); let transparent = 0, painted = 0;
      for (let i = 3; i < bitmap.length; i += 4) { if (bitmap[i] < 30) transparent++; if (bitmap[i] > 220) painted++; }
      return { transparent, painted, pixels: bitmap.length / 4, size: image.getSize() };
    }, capture.toString('base64'));
    assert.ok(alphaChecks[edge].transparent > 0, `${edge} must have transparent corners`);
    assert.ok(alphaChecks[edge].painted > alphaChecks[edge].pixels / 2, `${edge} hemisphere should be visible`);
    console.log(`Verified ${edge} hemisphere ${b.width}×${b.height}`);
  }
  async function pullOut(dx, dy) {
    const b = await bounds(), local = { x: b.width / 2, y: b.height / 2 };
    await point({ x: b.x + local.x, y: b.y + local.y });
    await page.mouse.move(local.x, local.y); await page.mouse.down(); await pause(40);
    await point({ x: b.x + local.x + dx, y: b.y + local.y + dy }); await pause(80);
    assert.equal((await state()).moving, true); await page.mouse.up(); await settled(false);
    assert.equal((await state()).edge, null); assert.equal((await bounds()).width, 340); assert.equal((await bounds()).height, 470);
  }
  await headerDrag({ x: area.x + area.width - 340 - 10, y: area.y + 150 }, 'right');
  await collapse('right'); await pullOut(-220, 40);
  await headerDrag({ x: area.x + Math.round(area.width / 2) - 170, y: area.y + 8 }, 'top');
  await collapse('top'); await pullOut(80, 150);
  await headerDrag({ x: area.x + 8, y: area.y + 150 }, 'left');
  await collapse('left'); await pullOut(200, 20);
  // Clicking (without dragging) a captured half-ball expands it as well.
  await headerDrag({ x: area.x + 8, y: area.y + 200 }, 'left');
  await collapse('left'); await page.locator('#pickdrop-native-tab').click(); await settled(false);
  assert.equal((await bounds()).width, 340);
  // Corner resizing uses programmatic bounds while the native transparent window stays non-resizable.
  const before = await bounds(), handle = await page.locator('.custom-window-resize-handle').boundingBox();
  const local = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await point({ x: before.x + local.x, y: before.y + local.y });
  await page.mouse.move(local.x, local.y); await page.mouse.down(); await pause(40);
  await point({ x: before.x + local.x + 30, y: before.y + local.y + 20 }); await pause(60); await page.mouse.up(); await settled(false);
  assert.equal((await bounds()).width, 370); assert.equal((await bounds()).height, 490);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isResizable()), false);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await pause(40);
  await point({ x: -10000, y: -10000 }); await page.evaluate(() => window.pickdrop.dock());
  assert.equal((await state()).transition, ''); assert.equal((await bounds()).width, 12);
  assert.deepEqual(errors, []);
  await writeFile('artifacts/desktop-motion-smoke.json', JSON.stringify({ capturedHeaderDrag: true, holdWithoutSnap: true, threeEdgeDocking: true, threeEdgePullOut: true, halfballClick: true, transparentCorners: alphaChecks, customResize: true, reducedMotion: true, physicalMultiDisplayTested: false, errors }, null, 2));
  console.log('Desktop motion smoke passed: all three edges, 12×24/24×12 hemispheres, transparent pixels, pull-out/click, custom resize, reduced motion. Screen cursor mocked.');
} finally {
  await app.close(); await rm(dir, { recursive: true, force: true });
}
