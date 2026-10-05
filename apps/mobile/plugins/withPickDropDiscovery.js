const { withInfoPlist, AndroidConfig } = require('expo/config-plugins');
module.exports = function withPickDropDiscovery(config) {
  config = AndroidConfig.Permissions.withPermissions(config, ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.CHANGE_WIFI_MULTICAST_STATE']);
  return withInfoPlist(config, result => {
    result.modResults.NSBonjourServices = [...new Set([...(result.modResults.NSBonjourServices || []), '_pickdrop._tcp'])];
    result.modResults.NSLocalNetworkUsageDescription = '拾传需要发现同一网络中的电脑和传输群，让你直接选择设备加入并传送文件。';
    return result;
  });
};
