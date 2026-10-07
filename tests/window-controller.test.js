import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

function dockRight(c, win) { win.setBounds({ ...win.getBounds(), x: 1120, y: 240 }); c.dock(); }

function setup(t, initial = { x: 600, y: 100, width: 320, height: 420 }) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  const screen = new EventEmitter();
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 30, width: 1440, height: 840 } };
  let cursor = { x: 650, y: 120 };
  Object.assign(screen, { getDisplayMatching: () => display, getDisplayNearestPoint: () => display, getPrimaryDisplay: () => display, getAllDisplays: () => [display], getCursorScreenPoint: () => cursor });
  const context = { require: () => ({ screen }), module: { exports: {} }, Date, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(readFileSync(new URL('../apps/desktop/window-controller.cjs', import.meta.url), 'utf8'), context);
  let nextId = 1;
  function makeWindow(bounds = initial, saved = null) {
    const win = new EventEmitter(); let box = { ...bounds }, destroyed = false, visible = true;
    const persisted = [];
    Object.assign(win, {
      id: nextId++, isDestroyed: () => destroyed, isVisible: () => visible, getBounds: () => ({ ...box }),
      setBounds: value => { box = { ...box, ...value }; win.emit('move'); },
      setMaximumSize() {}, setMinimumSize() {}, setResizable() {}, show() { visible = true; }, focus() {},
      hide() { visible = false; win.emit('hide'); },
      webContents: { isDestroyed: () => false, send() {} },
    });
    const controller = context.module.exports.createWindowController(win, saved, value => persisted.push(structuredClone(value)));
    t.after(() => { destroyed = true; win.emit('closed'); });
    return { controller, win, persisted };
  }
  return { ...makeWindow(), makeWindow, initialBounds: context.module.exports.initialBounds, screen, tick: ms => { for (let elapsed = 0; elapsed < ms; elapsed += 16) t.mock.timers.tick(Math.min(16, ms - elapsed)); }, cursor: value => { cursor = { ...value }; } };
}

test('holding near an edge never snaps or collapses; release commits docking', t => {
  const { controller: c, win, cursor, tick } = setup(t);
  c.startWindowDrag(); cursor({ x: 1160, y: 120 }); tick(16);
  assert.equal(win.getBounds().x, 1110);
  assert.equal(c.state().candidateEdge, 'right');
  tick(1600);
  assert.equal(c.state().edge, null);
  assert.equal(c.state().collapsed, false);
  assert.equal(win.getBounds().x, 1110);
  c.endWindowDrag(); tick(200);
  assert.equal(c.state().edge, 'right');
  assert.equal(win.getBounds().x, 1120);
  cursor({ x: 200, y: 200 }); c.pointer(false); tick(900); tick(200);
  assert.equal(win.getBounds().width, 40);
});

test('a collapsed tab pulls out under the grabbed edge and stays free on release', t => {
  const { controller: c, win, cursor, tick } = setup(t);
  c.setReducedMotion(true); dockRight(c, win);
  const tab = win.getBounds(); cursor({ x: tab.x + 6, y: tab.y + 12 });
  c.startWindowDrag(); cursor({ x: tab.x - 194, y: tab.y + 82 }); tick(16);
  assert.equal(c.state().collapsed, false);
  assert.equal(win.getBounds().width, 320);
  assert.equal(win.getBounds().x, 920);
  assert.equal(win.getBounds().y, tab.y + 70);
  c.endWindowDrag(); tick(1200);
  assert.equal(c.state().edge, null);
  assert.equal(win.getBounds().width, 320);
});

test('motion is interruptible, pinned windows stay expanded, reduced motion is immediate', t => {
  const { controller: c, win, cursor, tick } = setup(t);
  dockRight(c, win); tick(64);
  assert.equal(c.state().transition, 'collapse');
  assert.ok(win.getBounds().width < 320 && win.getBounds().width > 40);
  c.expand(); tick(200);
  assert.equal(win.getBounds().width, 320);
  c.setPinned(true); cursor({ x: 100, y: 700 }); c.pointer(false); tick(2000);
  assert.equal(c.state().collapsed, false);
  c.setReducedMotion(true); c.setPinned(false); c.dock();
  assert.equal(win.getBounds().width, 40);
  assert.equal(c.state().transition, '');
  c.expand(); assert.equal(win.getBounds().width, 320);
});

test('subthreshold clicks do not move; cancelled drags cannot attach to an edge', t => {
  const { controller: c, cursor, tick } = setup(t);
  c.startWindowDrag(); cursor({ x: 652, y: 122 }); tick(32);
  assert.equal(c.state().moving, false); c.endWindowDrag();
  c.startWindowDrag(); cursor({ x: 1162, y: 122 }); tick(16);
  assert.equal(c.state().candidateEdge, 'right');
  c.endWindowDrag(true); tick(200);
  assert.equal(c.state().edge, null);
  assert.equal(c.state().moving, false);
});


test('dragging the pointer all the way to the screen edge still docks an overshooting window', t => {
  const { controller: c, win, cursor, tick } = setup(t);
  cursor({ x: 780, y: 120 }); c.startWindowDrag(); cursor({ x: 1439, y: 120 }); tick(16);
  assert.ok(win.getBounds().x + win.getBounds().width > 1440);
  assert.equal(c.state().candidateEdge, 'right'); c.endWindowDrag(); tick(200);
  assert.equal(c.state().edge, 'right'); assert.equal(win.getBounds().x, 1120);
});

test('docking halfway through an expansion preserves the full content size', t => {
  const { controller: c, win, tick } = setup(t);
  dockRight(c, win); tick(200); c.expand(); tick(64); c.dock(); tick(200); c.expand(); tick(200);
  assert.equal(win.getBounds().width, 320); assert.equal(win.getBounds().height, 420);
});


test('entering during collapse is rechecked once the tab finishes animating', t => {
  const { controller: c, win, cursor, tick } = setup(t);
  dockRight(c, win); tick(64); cursor({ x: 1434, y: 250 }); c.pointer(true); tick(400);
  assert.equal(c.state().collapsed, false);
});


test('crossing a display seam follows the pointer display; negative-coordinate edges dock correctly', t => {
  const { controller: c, win, screen, cursor, tick } = setup(t);
  const left = { id: 2, bounds: { x: -1440, y: 0, width: 1440, height: 900 }, workArea: { x: -1440, y: 30, width: 1440, height: 840 } };
  screen.getDisplayNearestPoint = () => left;
  screen.getDisplayMatching = () => left;
  cursor({ x: 780, y: 120 }); c.startWindowDrag(); cursor({ x: -700, y: 150 }); tick(16);
  assert.equal(c.state().edge, null); assert.equal(c.state().candidateEdge, null);
  cursor({ x: -1440, y: 150 }); tick(16);
  assert.equal(c.state().candidateEdge, 'left'); c.endWindowDrag(); tick(200);
  assert.equal(c.state().edge, 'left'); assert.equal(win.getBounds().x, -1440);
});


test('new windows use the selected compact dimensions, while saved dimensions survive', t => {
  const { initialBounds } = setup(t);
  const fresh = initialBounds(); assert.equal(fresh.width, 340); assert.equal(fresh.height, 470);
  const saved = initialBounds({ bounds: { x: 20, y: 40, width: 400, height: 550 } });
  assert.equal(saved.width, 400); assert.equal(saved.height, 550);
});

test('top docking waits for release, uses the work area, and preserves full bounds after pulling out', t => {
  const { controller: c, win, cursor, tick } = setup(t);
  cursor({ x: 760, y: 120 }); c.startWindowDrag(); cursor({ x: 760, y: 32 }); tick(400);
  assert.equal(c.state().candidateEdge, 'top'); assert.equal(c.state().edge, null);
  c.endWindowDrag(); tick(200); assert.equal(c.state().edge, 'top'); assert.equal(win.getBounds().y, 30);
  c.setReducedMotion(true); c.dock();
  const ball = win.getBounds(); assert.equal(ball.width, 64); assert.equal(ball.height, 34); assert.equal(ball.y, 30);
  cursor({ x: ball.x + 12, y: ball.y + 6 }); c.startWindowDrag();
  cursor({ x: ball.x + 112, y: ball.y + 106 }); tick(16); c.endWindowDrag();
  assert.equal(c.state().collapsed, false); assert.equal(c.state().edge, null);
  assert.equal(win.getBounds().width, 320); assert.equal(win.getBounds().height, 420);
  assert.equal(win.getBounds().y, 130);
});

test('multiple group balls on the top edge remain separate and retain independent saved sizes', t => {
  const { controller: a, win: one, makeWindow, tick } = setup(t);
  const { controller: b, win: two } = makeWindow();
  a.setReducedMotion(true); b.setReducedMotion(true); a.dock(); b.dock(); tick(200);
  assert.equal(a.state().edge, 'top'); assert.equal(b.state().edge, 'top');
  assert.ok(one.getBounds().x + 64 <= two.getBounds().x || two.getBounds().x + 64 <= one.getBounds().x);
  a.expand(); b.expand(); assert.equal(one.getBounds().width, 320); assert.equal(two.getBounds().width, 320);
});

test('custom resize keeps a transparent window usable and respects minimum dimensions', t => {
  const { controller: c, win, cursor, tick } = setup(t);
  c.setReducedMotion(true); cursor({ x: 920, y: 520 }); c.startWindowResize();
  cursor({ x: 990, y: 580 }); tick(16); c.endWindowDrag();
  assert.equal(win.getBounds().width, 390); assert.equal(win.getBounds().height, 480); assert.equal(c.state().edge, null);
  c.startWindowResize(); cursor({ x: 200, y: 200 }); tick(16); c.endWindowDrag();
  assert.equal(win.getBounds().width, 280); assert.equal(win.getBounds().height, 340);
});

test('hide and reduced-motion changes settle an in-flight transition instead of leaving a fragment', t => {
  const { controller: c, win, tick } = setup(t);
  dockRight(c, win); tick(48); win.hide();
  assert.equal(c.state().transition, ''); assert.equal(win.getBounds().width, 40); assert.equal(win.getBounds().height, 48);
  win.show(); c.expand(); tick(32); c.setReducedMotion(true);
  assert.equal(c.state().transition, ''); assert.equal(win.getBounds().width, 320);
});

test('saved top docking restores as a small hemisphere, while pinned state stays expanded', t => {
  const { makeWindow } = setup(t);
  const { controller: c, win } = makeWindow(undefined, { edge: 'top', collapsed: true });
  c.setReducedMotion(true); c.restore(); assert.equal(win.getBounds().width, 64); assert.equal(win.getBounds().height, 34);
  const pinned = makeWindow(undefined, { edge: 'top', collapsed: true, pinned: true });
  pinned.controller.setReducedMotion(true); pinned.controller.restore(); assert.equal(pinned.win.getBounds().width, 320);
});


test('blur before released-pointer IPC still commits a completed edge drag', t => {
  const { controller: c, win, cursor, tick } = setup(t);
  c.startWindowDrag(); cursor({ x: 1160, y: 120 }); tick(16);
  win.emit('blur'); tick(16); c.endWindowDrag();
  cursor({ x: 200, y: 200 }); tick(1300);
  assert.equal(c.state().edge, 'right'); assert.equal(c.state().collapsed, true);
});
test('a genuinely interrupted held drag stays detached after blur', t => {
  const { controller: c, win, cursor, tick } = setup(t);
  c.startWindowDrag(); cursor({ x: 1160, y: 120 }); tick(16);
  win.emit('blur'); tick(1000);
  assert.equal(c.state().edge, null); assert.equal(c.state().moving, false);
});
test('blur releases focus locks but preserves pin and native-operation protection', t => {
  const { controller: c, win, cursor, tick } = setup(t);
  c.startWindowDrag(); cursor({ x: 1160, y: 120 }); tick(16); c.endWindowDrag(); tick(200);
  c.setBusy('ui', true); c.setBusy('input', true); win.emit('blur');
  c.setBusy('ui', true); c.setBusy('input', true); cursor({ x: 200, y: 200 }); tick(1300);
  assert.equal(c.state().collapsed, true);
  c.expand(); c.setBusy('native', true); tick(1300); assert.equal(c.state().collapsed, false);
  c.setBusy('native', false); c.setPinned(true); tick(1300); assert.equal(c.state().collapsed, false);
  c.setPinned(false); tick(1300); assert.equal(c.state().collapsed, true);
});
test('dragging files makes the courier reach before expanding without focusing', t => {
  const { controller: c, win, tick } = setup(t); let focusCalls = 0; win.focus = () => focusCalls++;
  c.setReducedMotion(true); dockRight(c, win); c.dragActivity(true);
  assert.equal(c.state().accepting, true); assert.equal(c.state().collapsed, true);
  tick(144); assert.equal(c.state().collapsed, false); assert.equal(focusCalls, 0);
  c.dragActivity(false); assert.equal(c.state().accepting, false);
});
