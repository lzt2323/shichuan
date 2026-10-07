import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const { desktopBackend, createNativeWindowController } = createRequire(import.meta.url)('../apps/desktop/platform-window.cjs');
const flags = value => ({ added: [], getSwitchValue: () => value, appendSwitch(...args) { this.added.push(args); } });
test('Linux chooses Xwayland when available and honors explicit native Wayland', () => {
  const automatic = flags('');
  assert.deepEqual(desktopBackend('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, automatic), { nativeFrame: false });
  assert.deepEqual(automatic.added, [['ozone-platform', 'x11']]);
  const explicit = flags('wayland');
  assert.equal(desktopBackend('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, explicit).nativeFrame, true);
  assert.deepEqual(explicit.added, []);
  assert.equal(desktopBackend('linux', { WAYLAND_DISPLAY: 'wayland-0' }, flags('')).nativeFrame, true);
  assert.equal(desktopBackend('darwin', {}, flags('')).nativeFrame, false);
  assert.equal(desktopBackend('win32', {}, flags('')).nativeFrame, false);
});
test('native Wayland controller never needs cursor or global positioning and persists resized bounds', () => {
  const win = new EventEmitter(), saved = [], events = [];
  Object.assign(win, { getBounds: () => ({ x: 0, y: 0, width: 500, height: 600 }), isDestroyed: () => false, webContents: { send: (...args) => events.push(args) }, show() {}, focus() {}, setAlwaysOnTop() {} });
  const controller = createNativeWindowController(win, { edge: 'right', collapsed: true }, state => saved.push(state));
  controller.restore(); controller.dock(); controller.startWindowDrag(); controller.startWindowResize(); controller.pointer(true);
  assert.equal(controller.state().collapsed, false); assert.equal(controller.state().nativeFrame, true);
  win.emit('resize'); assert.deepEqual(saved[0].bounds, { x: 0, y: 0, width: 500, height: 600 });
  assert.equal(events[0][0], 'window:changed');
});
