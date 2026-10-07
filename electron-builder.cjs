const { version, devDependencies } = require('./package.json');
module.exports = {
  appId: 'app.pickdrop.desktop',
  productName: 'PickDrop',
  electronVersion: devDependencies.electron,
  toolsets: { nsis: '1.2.1' },
  directories: { app: '.build/desktop', output: 'dist' },
  files: ['**/*', '!package-lock.json', '!pnpm-lock.yaml', '!node_modules/.modules.yaml'],
  asar: true,
  win: { target: [{ target: 'portable', arch: ['x64'] }], icon: 'apps/desktop/assets/icon.png', signExecutable: false },
  portable: { artifactName: `PickDrop-${version}-Windows.exe`, requestExecutionLevel: 'user' },
  mac: { target: 'dir', identity: null, icon: 'apps/desktop/assets/mac-icon.png', category: 'public.app-category.utilities', extendInfo: { NSLocalNetworkUsageDescription: '拾传需要发现并连接同一网络中的设备和传输群，以同步消息和传送文件。', NSBonjourServices: ['_pickdrop._tcp'] } },
};
