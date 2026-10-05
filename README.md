# 拾传 · PickDrop

局域网文件群聊。把文件拖进小窗，群内设备共享文字与文件；电脑接收完成后，可把文件卡片拖到桌面或文件夹。项目采用 MIT 许可证。

## 下载与版本管理

源码仓库：[lzt2323/shichuan](https://github.com/lzt2323/shichuan)。安装包统一从 [GitHub Releases](https://github.com/lzt2323/shichuan/releases) 下载；源码历史不包含安装包和用户数据。开发分支、检查和标签发布约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 0.2.1 桌面内测版

- Windows x64 免安装单文件：`PickDrop-0.2.1-Windows.exe`。
- Mac Apple 芯片版：`PickDrop-0.2.1-Mac-AppleSilicon.zip`，解压后打开 `PickDrop.app`。

无需安装 Node.js。Mac 版本未签名、公证，系统可能拦截；Intel Mac 需另行构建。Windows 在 macOS 上交叉构建，尚未完成 Windows 实机启动、防火墙与物理拖放验证。

### 使用方法

1. 各台电脑运行应用，接入同一个可信局域网。
2. 点击顶部群名，创建群或打开已有群；每个群对应一个独立窗口，可以同时打开多个群。
3. 群内选择「邀请设备」，在另一台电脑选择「加入群」并输入 6 位邀请码，已有成员确认后加入。
4. 拖入文件直接发送，输入文字按 Enter 发送。文件显示可拖出后，可拖往桌面、Finder 或资源管理器。
5. 拖动标题栏自由移动，靠近左、右或顶部边缘 24px 内出现提示，松手后吸附；按住时不会自动吸附。小半球可直接拖回桌面。点击贴边按钮也能收起到最近边缘：侧边 12×24、顶部 24×12，鼠标停留约 180ms 展开，拖入文件立即开始展开，离开约 800ms 自动收起。图钉保持展开；180ms 过渡遵循系统减少动态效果设置。

邀请码有效期 5 分钟、单次使用；现有可信成员均可邀请和确认新成员。邀请码只用于首次入群，设备身份、成员关系与群连接持久保存。重启后通过局域网发现更新地址，无需再次输入。创建群的电脑托管该群，传输时必须保持运行。

默认窗口 340×470，右下角拖动可调整大小（最小 280×340）。界面采用蓝白多人传输会话，文件与文字按时间排列，文件操作放在主按钮与更多菜单中。多个群的聊天记录、文件缓存、窗口位置、尺寸与贴边状态分别保存。关闭窗口会隐藏窗口，服务继续运行；从托盘菜单可以恢复，退出应用才关闭服务。

### 数据与升级

数据保存在 Electron `userData` 目录，Mac 通常为 `~/Library/Application Support/PickDrop`，Windows 为 `%APPDATA%/PickDrop`（开发运行名称可能不同）。

- `groups.json`：设备身份、群与连接凭据。
- `preferences.json`：窗口与偏好设置。
- `groups/<群 ID>/`：本机托管群的历史与文件。
- `received/`：按群隔离的接收缓存，下载时验证文件大小及 SHA-256。

旧版本机收件箱会非破坏性迁移成「我的传输群」，保留原始数据。旧版远程连接缺少新群标识，升级后需用新邀请码重新加入一次。不要公开含密钥的配置文件。

## 当前边界

当前是可信局域网原型，通过 HTTP/WebSocket 传输，**尚无 TLS 或端到端加密**，不应开放公网。局域网发现使用 UDP 组播 `239.255.47.32:47320`，各群服务使用动态 TCP 端口；防火墙需允许当前专用网络访问。发现后的地址会经过身份挑战校验。

尚未实现：公网中继、可靠离线投递、托管设备故障切换、成员撤销与密钥轮换、文件夹发送、断点续传、已读回执。物理多屏热拔插及真实系统鼠标拖放仍需实机验证。

`apps/mobile` 已接入新版多人传输群，采用蓝白会话界面。支持多群切换、扫码或「地址 + 6 位码」申请加入、成员审批、手机身份及群凭据安全保存、旧单收件箱迁移、前后台重连、分群文字草稿与文件待发区。手机通过系统分享保存/打开收到的文件，不使用桌面悬浮球。

文件选择和外部分享先暂存为草稿，用户确认发送；传输锁定目标群，提供真实字节进度、取消和重试。收到的文件按群隔离缓存，校验大小和 SHA-256 后才能分享。暂存文件成功发送后清理；未发送文件可在重启后恢复。后台长时间传输、断点续传不作保证；失败时可回到前台重试。服务端尚无幂等上传，若提交成功但回包丢失，重试前应检查群记录，避免重复发送。

手机目前不使用 UDP 自动发现；电脑地址变化后，重新扫描该群的新邀请并审批可更新连接。已保存的地址在发送凭据前进行 HMAC 主机校验。群由电脑托管，手机不能单独创建或托管群。

## 运行与验证

环境：Node.js 24、pnpm 11。

```sh
pnpm install
pnpm start
pnpm check
pnpm test
pnpm desktop:smoke
pnpm desktop:motion
pnpm desktop:visual
```

若依赖安装脚本被关闭，执行 `node node_modules/electron/install.js` 安装 Electron 运行时。

后端测试覆盖文件内容与群隔离、邀请码审批/拒绝/过期/限流、持久化、地址更新和旧数据迁移。桌面 smoke 使用两个真实 Electron 进程及临时数据目录，验证独立群窗口、6 位码配对、文字与文件传输、接收缓存、原生拖出 IPC、贴边与重启重连。IPC 测试不等于真实系统鼠标拖放。`desktop:motion` 使用真实 Electron 窗口与渲染器指针事件、受控屏幕坐标，检查按住不吸附、松手贴边、边签直接拖出、点击展开及减少动态效果；窗口控制器单元测试还覆盖取消和过渡中断。

验证已打包的 Mac 应用：

```sh
PICKDROP_TEST_EXECUTABLE="$PWD/dist/mac-arm64/PickDrop.app/Contents/MacOS/PickDrop" pnpm desktop:smoke
```

## 构建

```sh
pnpm desktop:package
pnpm desktop:package:windows
```

Mac 命令同时生成应用与 ZIP；Windows 输出可单独分发的 EXE。构建先生成 `.build/desktop` 生产依赖目录，再封装 Electron。两个构建命令应依次执行。正式发布需要签名和 macOS 公证。

手机开发与原生工程生成：

```sh
pnpm mobile:start
pnpm mobile:check
pnpm mobile:export
pnpm mobile:web
pnpm --dir apps/mobile native:generate
pnpm --dir apps/mobile ios
pnpm --dir apps/mobile android
```

iOS 原生构建需要完整 Xcode，真机安装需要签名；安卓需要 JDK 与 Android SDK。`mobile:export` 仅验证 JavaScript/Hermes bundle，不代表原生构建或真机验证。`apps/mobile/eas.json` 提供 EAS 内测构建配置（需要自行登录 EAS 并配置项目/签名），尚未交付此轮 APK/IPA。

手机体验步骤：电脑运行 `pnpm start`，打开群菜单的「邀请设备加入」。手机运行客户端后选「扫描邀请二维码」，在电脑批准申请即可进入群；无法扫码时填写邀请页显示的电脑地址和六位码。两台设备须在同一可互通的网络，电脑保持运行。使用 SDK 57 兼容的 Expo Go 可以调试基础流程；完整系统分享入口需要自定义原生构建，Expo Go 不会注册本项目的分享扩展。

`pnpm mobile:web` 提供同一份 React Native 界面的浏览器预览，连接凭据仅保留在页面内存。网页预览可测试群连接和文字消息；文件、相机权限和系统分享须在手机原生客户端验收。启动 `pnpm --dir apps/mobile exec expo start --web --port 8082` 后运行 `pnpm mobile:smoke`，验证真实后端配对、成员审批、两群隔离、草稿保留和 320px 小屏布局。结果截图在 `artifacts/mobile-*.png`，不应当作真机截图。

Android 已配置单/多文件分享 Intent，iOS 已配置 App Group 和 Share Extension。iOS 的外部分享接收使用 [Expo Sharing 实验性入口](https://docs.expo.dev/versions/v57.0.0/sdk/sharing/)，其打开主 App 的实现需要逐版本真机验证；正式发布前仍需验证 iOS/Android 权限、键盘、文件提供商、大文件、锁屏和分享回流。当前开发机仅有 Xcode Command Line Tools，缺少完整 Xcode、JDK 与 Android SDK，因此本轮只完成原生工程生成与 JS 构建，没有执行原生编译或真机验收。

## 已选视觉方案

当前源码实施 [多人传输会话与小半球方案](docs/ui-concepts/2026-10-04/D-group-transfer-halfball.png)。顶部小半球位于系统菜单栏下方的可用工作区，左右半球避开顶部角落。透明窗口使用自定义右下角缩放。手机沿用蓝白多人会话，采用全屏群列表和聊天页面、底部待发区与系统分享。现有 `dist` 安装包不会随源码自动更新。

`desktop:motion` 检查三边吸附、半球真实尺寸及透明像素、拖出和自定义缩放。`desktop:visual` 使用隔离测试数据与实际后端生成多人会话截图，并检查最小窗口与发送操作。这些测试使用受控屏幕指针，不代表已经完成 Windows 或混合 DPI 多屏物理鼠标实测。

## 设计与参考

[完整 Mini 群聊设计方案](docs/mini-group-design.html) 记录窗口形态、贴边交互、配对流程及多群行为，现已补充 2026-10-04 的竞品调研、自由拖动改进与手机端示意；其中标注的后续设计不代表全部已实现。

- [Yoink](https://eternalstorms.at/yoink/mac/)：拖拽临时架与屏幕边缘交互参考。
- [Dropover](https://dropoverapp.com/)：紧凑文件架与贴边收纳参考。
- [PairDrop](https://github.com/schlagmichdoch/PairDrop)：短码配对与记住设备的流程参考。
- [LocalSend 协议](https://github.com/localsend/protocol)：局域网发现和直接传输参考。
- [Electron 原生拖拽](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop/)：桌面系统拖出的 API。

界面和实现独立编写，未使用 Flix 源码或素材，也不宣称兼容上述项目协议。第三方依赖遵守各自许可证；项目尚未发布到应用商店。
