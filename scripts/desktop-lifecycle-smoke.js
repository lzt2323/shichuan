import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real Electron, isolated account. Check top-layer pixels and actual management IPC.
const dir = await mkdtemp(path.join(tmpdir(), 'pickdrop-lifecycle-'));
let app = await electron.launch({ args: ['.'], env: { ...process.env, PICKDROP_USER_DATA: dir } });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.connected === 'true');
  const alpha = () => app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    const { width, height } = image.getSize(), pixels = image.toBitmap();
    return [0, width - 1, (height - 1) * width, width * height - 1].map(index => pixels[index * 4 + 3]);
  });
  assert.deepEqual(await alpha(), [0, 0, 0, 0]);
  await page.locator('#group-menu-button').click();
  await page.locator('#create-group').click();
  await page.waitForTimeout(220);
  assert.deepEqual(await alpha(), [0, 0, 0, 0], 'dialog backdrop must preserve all four transparent corners');
  assert.equal(await page.locator('#new-group-name').inputValue(), '传输群 2');
  assert.equal(await page.locator('#new-group-name').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  assert.notEqual(await page.locator('#new-group-name').evaluate(node => getComputedStyle(node).boxShadow), 'none');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/desktop-modal-rounded.png', omitBackground: true });
  await page.locator('#close-panel').click();
  await page.locator('#group-menu-button').click();
  await page.locator('#group-settings').click();
  await page.locator('#rename-group-name').fill('测试传输');
  await page.locator('#rename-group').click();
  await page.waitForFunction(() => document.querySelector('#group-name').textContent === '测试传输');
  await page.locator('#delete-group').click();
  const welcomeOpened = app.waitForEvent('window');
  await page.locator('#confirm-operation').click();
  let welcome = await welcomeOpened;
  await welcome.waitForFunction(() => document.querySelector('#timeline')?.textContent.includes('开始传输'));
  assert.deepEqual(await welcome.evaluate(() => window.pickdrop.listGroups()), [], 'deleting the last group must not silently recreate a group');
  await app.close();
  app = await electron.launch({ args: ['.'], env: { ...process.env, PICKDROP_USER_DATA: dir } });
  welcome = await app.firstWindow();
  await welcome.waitForFunction(() => document.querySelector('#timeline')?.textContent.includes('开始传输'));
  assert.deepEqual(await welcome.evaluate(() => window.pickdrop.listGroups()), [], 'restart must keep an intentionally empty account empty');
  await welcome.locator('#group-menu-button').click();
  await welcome.locator('#join-group').click();
  await welcome.locator('#join-address').fill('http://172.29.5.94:54321/#invite=123456&group=11111111-1111-4111-8111-111111111111');
  await welcome.locator('#join-address').blur();
  assert.equal(await welcome.locator('#join-code').inputValue(), '123456');
  assert.equal(await welcome.locator('#join-address').inputValue(), 'http://172.29.5.94:54321');
  console.log('Desktop lifecycle passed: modal alpha, rounded focus ring, suggested names, rename/delete IPC, empty welcome, full invitation paste.');
} finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
