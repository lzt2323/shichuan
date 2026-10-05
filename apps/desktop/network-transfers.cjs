// Network loss must release native download leases promptly. Socket idle
// timeouts alone can take an hour after an adapter disappears.
function createNetworkTransferScope() {
  const controllers = new Set();
  function cancel() { for (const controller of controllers) controller.abort(); }
  return {
    begin() {
      const controller = new AbortController(); controllers.add(controller);
      return { signal: controller.signal, release: () => controllers.delete(controller) };
    },
    networkChanged(state) { if (!state.available || state.switching) cancel(); },
    close: cancel,
    get size() { return controllers.size; },
  };
}
module.exports = { createNetworkTransferScope };
