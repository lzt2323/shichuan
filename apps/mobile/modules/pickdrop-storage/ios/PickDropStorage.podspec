Pod::Spec.new do |s|
  s.name = 'PickDropStorage'
  s.version = '1.0.0'
  s.summary = 'PickDrop media and file export'
  s.description = 'PhotoKit image saving, document export and temporary shared-file storage for PickDrop.'
  s.license = { :type => 'MIT' }
  s.author = 'PickDrop'
  s.homepage = 'https://github.com/lzt2323/shichuan'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/lzt2323/shichuan.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
