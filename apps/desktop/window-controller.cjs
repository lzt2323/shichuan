const { screen } = require('electron');
const WIDTH = 340, HEIGHT = 470, TAB_DEPTH = 40, TAB_SPAN = 48;
const EDGES = ['left', 'right', 'top'];
const tabSize = edge => edge === 'top' ? { width: 64, height: 34 } : { width: TAB_DEPTH, height: TAB_SPAN };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const tabWindows = new Set();
const inside = (point, box, padding = 0) => point.x >= box.x - padding && point.x < box.x + box.width + padding && point.y >= box.y - padding && point.y < box.y + box.height + padding;

// Electron screen and BrowserWindow coordinates are both device independent pixels.
function fitBounds(bounds, display = screen.getDisplayMatching(bounds)) {
  const area = display.workArea;
  const width = clamp(Number(bounds.width) || WIDTH, Math.min(280, area.width), Math.min(900, area.width));
  const height = clamp(Number(bounds.height) || HEIGHT, Math.min(340, area.height), Math.min(1100, area.height));
  return { x: clamp(Math.round(bounds.x), area.x, area.x + area.width - width), y: clamp(Math.round(bounds.y), area.y, area.y + area.height - height), width, height };
}
function initialBounds(saved, index = 0) {
  if (saved?.bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved.bounds[key]))) return fitBounds(saved.bounds);
  const area = screen.getPrimaryDisplay().workArea;
  return fitBounds({ x: area.x + area.width - WIDTH - 32 - (index % 5) * 40, y: area.y + 70 + (index % 5) * 48, width: WIDTH, height: HEIGHT });
}

function layoutTabs() {
  const lanes = new Map();
  for (const item of tabWindows) {
    if (item.win.isDestroyed() || !item.collapsed()) continue;
    const display = screen.getDisplayMatching(item.bounds());
    const key = `${display.id}:${item.edge()}`;
    if (!lanes.has(key)) lanes.set(key, { area: display.workArea, edge: item.edge(), items: [] });
    lanes.get(key).items.push(item);
  }
  for (const { area, edge, items } of lanes.values()) {
    const top = edge === 'top';
    // Keep hemispheres away from screen corners so perpendicular edges never overlap.
    const extent = top ? area.width : area.height;
    const inset = Math.min(24, Math.max(0, Math.floor((extent - tabSize(edge).width) / (top ? 2 : 1))));
    const start = (top ? area.x : area.y) + inset, length = extent - inset * (top ? 2 : 1);
    const span = top ? tabSize(edge).width : tabSize(edge).height;
    const desired = item => top ? item.bounds().x + Math.round((item.bounds().width - span) / 2) : item.bounds().y;
    items.sort((a, b) => desired(a) - desired(b) || a.win.id - b.win.id);
    const gap = items.length * (span + 8) <= length ? 8 : 0;
    let next = start;
    items.forEach((item, index) => {
      const remaining = (items.length - index) * (span + gap) - gap;
      const position = clamp(Math.max(next, desired(item)), start, Math.max(start, start + length - remaining));
      item.apply({
        x: top ? position : edge === 'left' ? area.x : area.x + area.width - TAB_DEPTH,
        y: top ? area.y : position,
        ...tabSize(edge),
      });
      next = position + span + gap;
    });
  }
}

function createWindowController(win, saved, persist) {
  let expandedBounds = win.getBounds(), edge = EDGES.includes(saved?.edge) ? saved.edge : null;
  let pinned = Boolean(saved?.pinned), collapsed = false, uiBusy = false, nativeBusy = false, inputBusy = false, dragBusy = false;
  let focused = win.isFocused?.() ?? true, blurTimer;
  let motionTimer, motionTarget, finishMotion, dragPoll, windowDrag = null, candidateEdge = null, transition = '', motionDuration = 0, reducedMotion = false;
  let suppressMoveUntil = 0, hoverTimer, leaveTimer, moveTimer, dragTimer, revealTimer, saveTimer, draggingOut = false;
  const alive = () => !win.isDestroyed();
  const busy = () => pinned || uiBusy || nativeBusy || inputBusy || dragBusy || draggingOut || Boolean(windowDrag) || Boolean(transition);
  const state = () => ({ pinned, docked: collapsed, collapsed, edge, candidateEdge, moving: Boolean(windowDrag?.moved), transition, motionDuration, accepting: dragBusy, contentWidth: expandedBounds.width, contentHeight: expandedBounds.height });
  const emit = () => { if (alive() && !win.webContents.isDestroyed()) win.webContents.send('window:changed', state()); };
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => persist({ bounds: expandedBounds, edge, pinned, collapsed }), 150); };
  function applyBounds(bounds) { if (!alive()) return; suppressMoveUntil = Date.now() + 600; win.setBounds(bounds, false); }
  function stopMotion() {
    clearInterval(motionTimer); motionTimer = null; transition = ''; motionDuration = 0; motionTarget = null; finishMotion = null;
  }
  function animateBounds(target, kind, done = () => {}) {
    stopMotion();
    if (reducedMotion || !win.isVisible()) { applyBounds(target); done(); emit(); save(); scheduleCollapse(); return; }
    const from = win.getBounds(), start = Date.now();
    const distance = Math.max(Math.abs(target.width - from.width), Math.abs(target.height - from.height));
    const duration = kind === 'expand' ? Math.min(280, 200 + distance / 10) : kind === 'collapse' ? Math.min(220, 150 + distance / 10) : 180;
    motionDuration = duration; transition = kind; motionTarget = { ...target }; finishMotion = done; emit();
    motionTimer = setInterval(() => {
      if (!alive()) { stopMotion(); return; }
      const t = Math.min(1, (Date.now() - start) / duration), eased = 1 - Math.pow(1 - t, 3);
      const next = {};
      for (const key of ['x', 'y', 'width', 'height']) next[key] = Math.round(from[key] + (target[key] - from[key]) * eased);
      applyBounds(next);
      if (t === 1) {
        stopMotion(); done(); emit(); save();
        if (collapsed && inside(screen.getCursorScreenPoint(), win.getBounds())) pointer(true);
        else scheduleCollapse();
      }
    }, 16);
  }
  const tabRecord = { win, collapsed: () => collapsed, edge: () => edge, bounds: () => expandedBounds, apply: bounds => {
    const current = win.getBounds();
    if (!transition && current.width === bounds.width && current.height === bounds.height) { applyBounds(bounds); return; }
    win.setMaximumSize(900, 1100);
    animateBounds(bounds, 'collapse', () => {
      win.setResizable(false);
      win.setMaximumSize(bounds.width, bounds.height);
    });
  } };
  tabWindows.add(tabRecord);
  function alignExpanded(display = screen.getDisplayMatching(expandedBounds)) {
    expandedBounds = fitBounds(expandedBounds, display);
    if (edge) {
      const area = display.workArea;
      if (edge === 'top') expandedBounds.y = area.y;
      else expandedBounds.x = edge === 'left' ? area.x : area.x + area.width - expandedBounds.width;
    }
  }
  function expand(focus = false) {
    clearTimeout(hoverTimer); hoverTimer = null; clearTimeout(leaveTimer);
    if (collapsed) {
      stopMotion(); collapsed = false; alignExpanded();
      win.setMaximumSize(900, 1100); win.setMinimumSize(1, 1);
      animateBounds(expandedBounds, 'expand', () => win.setMinimumSize(280, 340));
      layoutTabs(); emit(); save();
    }
    if (focus) { win.show(); win.focus(); }
    return state();
  }
  function collapse(force = false) {
    clearTimeout(hoverTimer); hoverTimer = null; clearTimeout(leaveTimer);
    if (!edge || collapsed || (!force && busy())) return state();
    if (!transition) expandedBounds = fitBounds(win.getBounds());
    stopMotion(); collapsed = true; win.setMinimumSize(1, 1); win.setMaximumSize(900, 1100);
    layoutTabs(); emit(); save();
    return state();
  }
  function scheduleCollapse() {
    clearTimeout(leaveTimer);
    if (!edge || collapsed || busy() || !win.isVisible()) return;
    leaveTimer = setTimeout(() => {
      if (alive() && !busy() && !inside(screen.getCursorScreenPoint(), win.getBounds())) collapse();
    }, 800);
  }
  function pointer(entered) {
    if (windowDrag || transition === 'expand' || transition === 'snap') return;
    if (entered) {
      clearTimeout(leaveTimer);
      if (collapsed && !hoverTimer) hoverTimer = setTimeout(() => { hoverTimer = null; if (alive() && win.isVisible() && !windowDrag) expand(); }, 180);
    } else {
      clearTimeout(hoverTimer); hoverTimer = null;
      scheduleCollapse();
    }
  }
  function dock() {
    if (collapsed) return state();
    if (transition) { stopMotion(); applyBounds(expandedBounds); win.setMinimumSize(280, 340); }
    expandedBounds = fitBounds(win.getBounds());
    const area = screen.getDisplayMatching(expandedBounds).workArea;
    if (!edge) {
      const distances = { left: expandedBounds.x - area.x, right: area.x + area.width - expandedBounds.x - expandedBounds.width, top: expandedBounds.y - area.y };
      edge = EDGES.reduce((nearest, side) => distances[side] < distances[nearest] ? side : nearest, 'left');
    }
    alignExpanded(); applyBounds(expandedBounds); layoutTabs(); emit(); save();
    if (!pinned) collapse(true);
    return state();
  }
  function setPinned(value) {
    pinned = Boolean(value); if (pinned) expand(); else scheduleCollapse();
    emit(); save(); return state();
  }
  function setBusy(kind, value) {
    if (kind === 'ui') uiBusy = focused && Boolean(value);
    if (kind === 'native') nativeBusy = Boolean(value);
    if (kind === 'input') inputBusy = focused && Boolean(value);
    if (busy()) clearTimeout(leaveTimer); else scheduleCollapse();
  }
  function dragActivity(value) {
    clearTimeout(dragTimer); dragBusy = Boolean(value);
    if (dragBusy) {
      if (collapsed) { if (!revealTimer) revealTimer = setTimeout(() => { revealTimer = null; if (dragBusy) expand(); }, 120); }
      else expand();
      dragTimer = setTimeout(() => { dragBusy = false; emit(); scheduleCollapse(); }, 1800);
    } else { clearTimeout(revealTimer); revealTimer = null; scheduleCollapse(); }
    emit();
  }
  function nativeDragStart() {
    draggingOut = true; expand();
    // dragend comes from Chromium; focus/blur do not safely identify an OS drag end.
    clearTimeout(leaveTimer);
  }
  function nativeDragEnd() { draggingOut = false; scheduleCollapse(); }
  function edgeFor(bounds, display = screen.getDisplayMatching(bounds)) {
    const area = display.workArea;
    // Crossing the outer edge still counts, even when the grab point is far inside.
    const distances = { left: bounds.x - area.x, right: area.x + area.width - bounds.x - bounds.width, top: bounds.y - area.y };
    const nearest = EDGES.reduce((result, side) => distances[side] < distances[result] ? side : result, 'left');
    return distances[nearest] <= 24 ? nearest : null;
  }
  function startWindowDrag() {
    if (windowDrag || nativeBusy || draggingOut) return;
    // Finish an interrupted reveal before taking the grab offset.
    if (transition) { if (collapsed) expand(); stopMotion(); win.setMaximumSize(900, 1100); applyBounds(expandedBounds); win.setMinimumSize(280, 340); }
    clearTimeout(hoverTimer); hoverTimer = null; clearTimeout(leaveTimer); clearTimeout(moveTimer);
    windowDrag = { point: screen.getCursorScreenPoint(), bounds: win.getBounds(), moved: false };
    dragPoll = setInterval(updateWindowDrag, 16);
  }
  function startWindowResize() {
    if (collapsed || windowDrag || nativeBusy || draggingOut) return;
    settleMotion(); clearTimeout(leaveTimer); clearTimeout(moveTimer);
    windowDrag = { point: screen.getCursorScreenPoint(), bounds: win.getBounds(), moved: false, resizing: true };
    dragPoll = setInterval(updateWindowDrag, 16);
  }
  function updateWindowDrag() {
    if (!windowDrag || !alive()) return;
    const point = screen.getCursorScreenPoint(), dx = point.x - windowDrag.point.x, dy = point.y - windowDrag.point.y;
    if (!windowDrag.moved && Math.hypot(dx, dy) < 5) return;
    if (windowDrag.resizing) {
      if (!windowDrag.moved) { windowDrag.moved = true; edge = null; emit(); }
      const display = screen.getDisplayMatching(windowDrag.bounds), area = display.workArea;
      const source = windowDrag.bounds;
      const target = fitBounds({ ...source,
        width: clamp(source.width + dx, 280, Math.max(280, area.x + area.width - source.x)),
        height: clamp(source.height + dy, 340, Math.max(340, area.y + area.height - source.y)),
      }, display);
      expandedBounds = target; applyBounds(target); emit();
      return;
    }
    if (!windowDrag.moved) {
      stopMotion(); windowDrag.moved = true;
      const source = windowDrag.bounds;
      if (collapsed) {
        // Keep the grabbed hemisphere under the pointer, including shifted group handles.
        windowDrag.bounds = { ...expandedBounds,
          x: edge === 'top' ? source.x + Math.round((source.width - expandedBounds.width) / 2) : edge === 'right' ? source.x + source.width - expandedBounds.width : source.x,
          y: source.y,
        };
        collapsed = false; win.setMaximumSize(900, 1100); win.setMinimumSize(280, 340);
      }
      edge = null; emit(); layoutTabs();
    }
    const target = { ...windowDrag.bounds, x: Math.round(windowDrag.bounds.x + dx), y: Math.round(windowDrag.bounds.y + dy) };
    // No easing or clamping under the pointer; both make a dragged window lag.
    applyBounds(target); expandedBounds = target;
    const next = edgeFor(target, screen.getDisplayNearestPoint(point));
    if (next !== candidateEdge) { candidateEdge = next; emit(); }
  }
  function endWindowDrag(cancel = false) {
    if (!windowDrag) return;
    if (!cancel) updateWindowDrag();
    const moved = windowDrag.moved, resizing = windowDrag.resizing;
    const resizeDisplay = resizing ? screen.getDisplayMatching(windowDrag.bounds) : null;
    clearInterval(dragPoll); dragPoll = null; windowDrag = null; candidateEdge = null;
    if (moved) {
      const raw = win.getBounds();
      const display = resizeDisplay || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      edge = cancel || resizing ? null : edgeFor(raw, display);
      expandedBounds = fitBounds(raw, display); alignExpanded(display);
      animateBounds(expandedBounds, 'snap', () => win.setMinimumSize(280, 340));
      save();
    }
    emit(); scheduleCollapse();
  }
  function settleMotion() {
    if (!motionTarget) return;
    const target = motionTarget, done = finishMotion;
    stopMotion(); applyBounds(target); done?.(); emit(); save();
  }
  function setReducedMotion(value) { reducedMotion = Boolean(value); if (reducedMotion) { settleMotion(); scheduleCollapse(); } }
  function moved() {
    if (!alive() || collapsed || windowDrag || transition || Date.now() < suppressMoveUntil) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!alive() || collapsed || windowDrag || transition) return;
      expandedBounds = fitBounds(win.getBounds());
      // Native resize/move notifications do not tell us when the button is up.
      // Only our captured drag release attaches a window to an edge.
      if (edge && edgeFor(expandedBounds) !== edge) edge = null;
      emit(); save(); scheduleCollapse();
    }, 150);
  }
  function displaysChanged(removed = false) {
    if (!alive()) return;
    endWindowDrag(true); stopMotion();
    const center = { x: expandedBounds.x + expandedBounds.width / 2, y: expandedBounds.y + expandedBounds.height / 2 };
    if (removed && !screen.getAllDisplays().some(display => inside(center, display.bounds))) expandedBounds = fitBounds(expandedBounds, screen.getPrimaryDisplay());
    alignExpanded();
    if (collapsed) layoutTabs();
    else { win.setMaximumSize(900, 1100); applyBounds(expandedBounds); win.setMinimumSize(280, 340); }
    save(); emit(); scheduleCollapse();
  }
  win.on('move', moved); win.on('resize', moved);
  win.on('blur', () => {
    focused = false; uiBusy = false; inputBusy = false;
    // Native blur can arrive before Chromium's released-pointer IPC. Allow that
    // queued release to commit, but still cancel a genuinely interrupted drag.
    clearTimeout(blurTimer); blurTimer = setTimeout(() => { endWindowDrag(true); scheduleCollapse(); }, 60);
    scheduleCollapse();
  });
  win.on('focus', () => { focused = true; clearTimeout(blurTimer); });
  win.on('hide', () => { endWindowDrag(true); settleMotion(); clearTimeout(leaveTimer); clearTimeout(hoverTimer); hoverTimer = null; });
  // Poll only to notice leaving this small window, never to capture the screen edge.
  let wasInside = false;
  const pointerPoll = setInterval(() => {
    if (!alive() || !win.isVisible()) return;
    const nowInside = inside(screen.getCursorScreenPoint(), win.getBounds());
    if (nowInside !== wasInside) { wasInside = nowInside; pointer(nowInside); }
  }, 100);
  const changedEvents = new Map(['display-added', 'display-removed', 'display-metrics-changed'].map(event => [event, () => displaysChanged(event === 'display-removed')]));
  changedEvents.forEach((handler, event) => screen.on(event, handler));
  win.on('closed', () => {
    tabWindows.delete(tabRecord); layoutTabs();
    clearInterval(pointerPoll); clearInterval(dragPoll); stopMotion(); [hoverTimer, leaveTimer, moveTimer, dragTimer, revealTimer, saveTimer, blurTimer].forEach(clearTimeout);
    changedEvents.forEach((handler, event) => screen.removeListener(event, handler));
    persist({ bounds: expandedBounds, edge, pinned, collapsed });
  });
  if (edge) { alignExpanded(); applyBounds(expandedBounds); }
  return { restore: () => { if (saved?.collapsed && edge && !pinned) collapse(true); }, state, expand, collapse, dock, setPinned, setBusy, pointer, dragActivity, nativeDragStart, nativeDragEnd, startWindowDrag, startWindowResize, endWindowDrag, setReducedMotion, emit };
}
module.exports = { initialBounds, createWindowController };
