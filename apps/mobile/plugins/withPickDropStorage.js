const { withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = config => withDangerousMod(config, ['ios', async config => {
  const file = path.join(config.modRequest.platformProjectRoot, 'expo-sharing-extension', 'ShareIntoViewController.swift');
  let source = await fs.readFile(file, 'utf8');
  // Keep imported bytes in an app-owned staging directory and avoid overwriting same-name shares.
  const expected = 'let destinationURL = containerURL.appendingPathComponent(fileName)';
  if (source.split(expected).length !== 3) throw new Error('Expo sharing extension template changed; review PickDrop staging patch before building.');
  source = source.replaceAll('let destinationURL = containerURL.appendingPathComponent(fileName)', 'let staging = containerURL.appendingPathComponent("PickDropIncoming", isDirectory: true)\n    try? FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)\n    let destinationURL = staging.appendingPathComponent(UUID().uuidString + "-" + fileName)');
  await fs.writeFile(file, source);
  return config;
}]);
