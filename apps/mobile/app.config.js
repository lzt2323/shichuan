// Preview builds use an isolated package so the public Expo test certificate
// can never become the signing identity of a future production installation.
module.exports = ({ config }) => {
  if (process.env.PICKDROP_ANDROID_PREVIEW !== '1') return config;
  return {
    ...config,
    name: '拾传内测',
    android: { ...config.android, package: 'app.pickdrop.mobile.preview', versionCode: 301 },
  };
};
