# 拾传 Android 内测 APK

下载 `PickDrop-*-Android-arm64-preview.apk`，在安卓手机上打开安装。已内置 JavaScript/Hermes 资源，不需要 Expo Go、Metro 或开发服务器。支持 ARM64 安卓手机，最低系统版本以 ANDROID-BUILD.txt 中的 sdkVersion 为准。

安装后：手机与电脑连接同一网络 → 电脑群菜单中「邀请设备加入」→ 手机扫码或填地址与六位码 → 电脑批准。

此包是使用 Expo 测试证书签名的 release 构建，应用名称为「拾传内测」、包名为 `app.pickdrop.mobile.preview`，不是正式商店版。请勿用于存放敏感资料；正式版必须使用独立私有签名和正式包名。此测试证书不保密，不能作为发布者身份保证。通过 SHA256SUMS.txt 校验从此仓库下载的文件。

GitHub Actions 检查 APK 签名、应用包名和内置页面资源；编译通过不等于所有真机功能已经验收。相机权限、文件选择、传输、系统分享和锁屏恢复仍需要手机实测。电脑托管传输群，需保持运行。
