const { version, devDependencies } = require('./package.json');
module.exports = {
  appId: 'app.pickdrop.desktop',
  productName: 'PickDrop',
  electronVersion: devDependencies.electron,
  toolsets: { nsis: '1.2.1' },
  directories: { app: '.build/desktop', output: 'dist' },
  files: ['**/*', '!package-lock.json', '!pnpm-lock.yaml', '!node_modules/.modules.yaml'],
  asar: true,
  win: { target: [{ target: 'portable', arch: ['x64'] }], signAndEditExecutable: false },
  portable: { artifactName: `PickDrop-${version}-Windows.exe`, requestExecutionLevel: 'user' },
  mac: { target: 'dir', identity: null, category: 'public.app-category.utilities' },
};
