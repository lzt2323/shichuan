// Wayland forbids global cursor reads and positioning. Prefer Xwayland when
// available; honor an explicit platform choice and use normal native chrome there.
function desktopBackend(platform, env, commandLine) {
  if (platform !== 'linux') return { nativeFrame: false };
  let backend = commandLine.getSwitchValue('ozone-platform') || env.ELECTRON_OZONE_PLATFORM_HINT;
  if (!backend && env.DISPLAY) { commandLine.appendSwitch('ozone-platform', 'x11'); backend = 'x11'; }
  const nativeFrame = backend === 'wayland' || (backend !== 'x11' && Boolean(env.WAYLAND_DISPLAY));
  return { nativeFrame };
}
function createNativeWindowController(win, saved, persist) {
  let pinned = Boolean(saved?.pinned);
  const state = () => ({ nativeFrame: true, pinned, collapsed: false, docked: false, edge: null, transition: '', contentWidth: win.getBounds().width, contentHeight: win.getBounds().height });
  const emit = () => { if (!win.isDestroyed()) win.webContents.send('window:changed', state()); };
  const remember = () => { if (!win.isDestroyed()) persist({ bounds: win.getBounds(), pinned, collapsed: false, edge: null }); };
  const expand = focus => { if (focus) { win.show(); win.focus(); } return state(); };
  const noop = () => {};
  win.on('resize', remember); win.on('move', remember);
  return { state, emit, expand, restore: emit, dock: state, collapse: state, setPinned(value) { pinned = Boolean(value); win.setAlwaysOnTop(pinned); remember(); emit(); return state(); }, setBusy: noop, pointer: noop, dragActivity: noop, nativeDragStart: noop, nativeDragEnd: noop, startWindowDrag: noop, startWindowResize: noop, endWindowDrag: noop, setReducedMotion: noop };
}
module.exports = { desktopBackend, createNativeWindowController };
