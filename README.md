# 拾传 · PickDrop

<img src="assets/brand/app-icon.png" width="96" height="96" alt="拾传 · 拾点 Logo">

局域网文件群聊。把文件拖进小窗，群内设备共享文字与文件；电脑接收完成后，可把文件卡片拖到桌面或文件夹。项目采用 MIT 许可证。

## 下载与版本管理

源码仓库：[lzt2323/shichuan](https://github.com/lzt2323/shichuan)。安装包统一从 [GitHub Releases](https://github.com/lzt2323/shichuan/releases) 下载；源码历史不包含安装包和用户数据。开发分支、检查和标签发布约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 0.5.0 全平台内测版

新建群由各设备保存独立副本，创建者退出后其他在线成员继续文字与文件传输。历史文件按需从持有者获取，暂无在线副本时等待重试；Linux TUI 和 Android 原生客户端同步支持。旧群需在原托管设备显式升级，其他成员重新加入。另修复群管理、手动连接、圆角、动画及授权问题。完整说明见 [v0.5.0 发布说明](docs/releases/v0.5.0.md) 和 [协议与迁移](docs/peer-groups.md)。

安装包集中在 [v0.5.0 Release](https://github.com/lzt2323/shichuan/releases/tag/v0.5.0)：

| 系统 | 文件 |
| --- | --- |
| Windows x64 | `PickDrop-0.5.0-Windows.exe` |
| Mac Apple 芯片 | `PickDrop-0.5.0-Mac-AppleSilicon.zip` |
| Android ARM64 | `PickDrop-0.5.0-Android-arm64-preview.apk` |
| Linux x64 | `PickDrop-0.5.0-Linux-x64-TUI.tar.gz` |
| Linux ARM64 | `PickDrop-0.5.0-Linux-arm64-TUI.tar.gz` |

安装包自带运行资源，不需要 Node.js、Expo Go 或开发服务器。Linux 提供终端界面及命令行，可在 SSH 中使用；解压后运行包内 `pickdrop`，详细说明见 [Linux 使用指南](docs/linux.md)。暂不提供 Linux 图形窗口版、Intel Mac 包或 iOS IPA。

Mac 未签名、公证；Android 为使用公开测试证书的「拾传内测」，采用独立包名 `app.pickdrop.mobile.preview`，正式版须另配私有签名。所有文件附统一 SHA256SUMS.txt。自动化构建不替代手机真机与各平台实际网络验证。

桌面有加群申请时，窗口顶部固定显示设备名与「允许加入 / 拒绝」按钮；多条申请可点「查看全部」集中处理，不需要滚动聊天历史。成员页面也保留处理入口。

### 使用方法

1. 各台电脑运行应用，接入同一个可信局域网。
2. 点击顶部群名，创建群或打开已有群；每个群对应一个独立窗口，可以同时打开多个群。
3. 群内选择「邀请设备」，在另一台电脑选择「加入群」并输入 6 位邀请码，已有成员确认后加入。
4. 拖入文件直接发送，输入文字按 Enter 发送。剪贴板中的截图或图片可用 macOS 的 ⌘V、Windows 的 Ctrl+V 粘贴，先在输入框上方预览，再按 Enter 或发送按钮发送；点 × 可移除，发送失败的图片会保留供重试。一次最多 10 张，单张最多 32 MiB，待发送图片合计最多 64 MiB。文件显示可拖出后，可拖往桌面、Finder 或资源管理器。
5. 拖动标题栏自由移动，靠近左、右或顶部边缘 24px 内出现提示，松手后吸附；按住时不会自动吸附。贴边小猫可直接拖回桌面。点击贴边按钮也能收起到最近边缘：侧边 40×48、顶部 64×34；文件拖入时小猫伸爪、展开收件区，离开后自动收起。拖到边缘后快速切换到其他应用，也会完成收起。图钉保持展开；180ms 过渡遵循系统减少动态效果设置。

邀请码有效期 5 分钟、单次使用；现有可信成员均可邀请和确认新成员。邀请码只用于首次入群，设备身份、成员关系与群连接持久保存。重启后通过局域网发现更新地址，无需再次输入。多端群由在线成员各自提供服务，不要求创建者持续运行；旧托管群保持原行为，升级后才获得多端能力。

默认窗口 340×470，右下角拖动可调整大小（最小 280×340）。界面采用奶油白与松绿色的多人传输会话，文件与文字按时间排列，图片操作放在更多菜单中，普通文件使用紧凑卡片。多个群的聊天记录、文件缓存、窗口位置、尺寸与贴边状态分别保存。关闭窗口会隐藏窗口，服务继续运行；从托盘菜单可以恢复，退出应用才关闭服务。

### 数据与升级

数据保存在 Electron `userData` 目录，Mac 通常为 `~/Library/Application Support/PickDrop`，Windows 为 `%APPDATA%/PickDrop`（开发运行名称可能不同）。

- `groups.json`：设备身份、群与连接凭据。
- `groups/<群 ID>/peer.json`：多端群的签名事件、成员关系和连接线索；设备私钥不得分享。
- `preferences.json`：窗口与偏好设置。
- `groups/<群 ID>/history.sqlite`：本机托管群的分页历史；`history.json` 仅保存设备与授权元数据，`files/` 保存托管原件。旧 JSON 历史首次迁移会保留 `history.pre-sqlite.json`。
- `received/`：按群隔离的接收缓存，默认最多 7 天、合计 512 MiB，保护使用中的文件。大小及完整性检查在后台完成，界面只显示接收与保存进度。

「存储空间」可查看并清理缓存。缓存清理不删除已另存的文件；托管原件需群主在文件列表中主动删除，删除后群内保留已清理的消息记录。聊天历史按页读取，打开群不会重新下载全部旧附件。元数据写入使用原子替换并保留上一版备份；授权文件损坏时停止加载对应数据，不能自动回滚旧凭据。迁移后请勿直接用旧版覆盖运行同一数据目录，回退前应退出应用并恢复完整升级前备份。

图片文件使用预览卡片，点击图片查看大图，卡片的更多菜单提供保存与分享等操作；普通文件使用紧凑卡片。预览支持不超过 8 MiB 的 PNG、JPEG、WebP，先校验文件内容，再显示本地图片。未加载的历史图片可按需加载，其他格式或较大图片仍可保存原文件后查看。桌面保留接收后拖出文件的操作。手机网页模式仅用于界面预览，图片接收与系统保存需使用原生客户端；新增图标使用原生 SVG 支持，更新手机时需要重新构建安装包。

旧版本机收件箱会非破坏性迁移成「我的传输群」，保留原始数据。旧版远程连接缺少新群标识，升级后需用新邀请码重新加入一次。不要公开含密钥的配置文件。

## 连接与授权

自动网络模式跟随物理网卡地址变化，手动模式保持所选网卡。桌面仍提供附近群列表；手机没有陌生群搜索页面，也不再遍历网段。已加入群在前台使用 Android NSD/UDP 或 iOS Bonjour 获取地址线索，并验证主机身份后重连；解析失败按退避策略重试。打开应用不代表所有群同时建立实时连接，当前群才保持消息连接。

手机优先扫码加入，也可输入邀请链接或电脑地址。已有群重新扫码时，只有主机身份与保存的授权验证通过才更新地址。已撤销的设备需重新申请；二维码无法绕过网络隔离。电脑地址改变且组播不可达时，仍可能需要重新扫码。

新多端群使用设备签名身份，创建者可移除设备并撤销其后续访问。普通成员可以在线退出，或仅在本机忘记群。旧共享授权群升级设备授权时，原成员须重新批准加入，历史与文件保留。此前版本说明见 [v0.3.5](docs/releases/v0.3.5.md)。

## 当前边界

当前是可信局域网原型，通过 HTTP/WebSocket 传输，**尚无 TLS 或端到端加密**，不应开放公网。局域网发现使用 DNS-SD/mDNS `_pickdrop._tcp`，并兼容原桌面 UDP 组播 `239.255.47.32:47320`；各群服务使用动态 TCP 端口。传输网络可选择具体已连接网卡，邀请地址使用该接口的可达 IPv4，防火墙需允许当前专用网络访问。已配对设备的候选新地址经过身份挑战校验后才能接收凭据。

尚未实现：公网中继、所有设备均离线时的投递、自动凭据轮换、文件夹发送、断点续传、已读回执。物理多屏热拔插及真实系统鼠标拖放仍需实机验证。

`apps/mobile` 已接入新版多人传输群，采用奶油白与松绿色会话界面。支持多群切换、扫码或高级手动地址申请加入、成员审批、手机身份及群凭据安全保存、旧单收件箱迁移、前后台重连、分群文字草稿与文件待发区。手机收到图片后默认保存到系统相册，普通文件选择保存位置；分享是独立操作。取消保存不会提示成功，失败后可重试，不使用桌面悬浮球。

Android 剪贴板图片（v0.3.4 起）：复制图片后，在聊天输入框长按「粘贴」，图片直接加入同一个输入框，可继续输入文字或点 × 移除，点击发送才上传。没有独立预览区或额外的粘贴按钮；普通文字沿用系统编辑菜单。外接键盘支持 Ctrl+V 和 Shift+Insert。读取期间离开当前群会取消导入；单张最多 32 MiB，最多 10 张待发图片，添加剪贴板图片时待发文件合计不得超过 64 MiB。截图工具若只保存到相册而没有复制图片，请使用「＋」选文件或系统分享。请安装 v0.3.4 或更新的 Android 安装包，不能仅更新 JS；暂未接入输入法的图片候选插入。

文件选择和外部分享先暂存为草稿，用户确认发送；传输锁定目标群，提供真实字节进度、取消和重试。收到的文件按群隔离缓存，后台检查完成后保存或分享；界面不增加校验步骤。暂存文件成功发送后清理；未发送文件可在重启后恢复。后台长时间传输、断点续传不作保证；失败时可回到前台重试。服务端尚无幂等上传，若提交成功但回包丢失，重试前应检查群记录，避免重复发送。

Android 原生客户端可创建多端群，并在应用前台时提供群同步和文件副本服务；后台或系统杀进程时不保证服务在线。iOS、网页和 Expo Go 尚未接入新的副本服务，只保留旧托管群能力。旧群地址使用 HMAC 身份校验，新多端群使用签名校验。

## 运行与验证

环境：Node.js 24、pnpm 11。

```sh
pnpm install
pnpm start
pnpm check
pnpm test
pnpm desktop:smoke
pnpm desktop:peer
pnpm desktop:lifecycle
pnpm desktop:motion
pnpm desktop:visual
pnpm desktop:requests
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
pnpm linux:package --arch=x64
pnpm linux:package --arch=arm64
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

iOS 原生构建需要完整 Xcode，真机安装需要签名；安卓需要 JDK 与 Android SDK。`mobile:export` 仅验证 JavaScript/Hermes bundle，不代表原生构建或真机验证。Android 内测 APK 通过 GitHub Actions 编译，详见 CONTRIBUTING.md。`apps/mobile/eas.json` 也提供 EAS 构建配置（需要自行登录并配置项目/签名）。暂不提供 IPA。

手机体验步骤：电脑运行 `pnpm start`，打开群菜单的「邀请设备加入」。手机运行客户端后点击「扫码加入」，扫描电脑邀请二维码，电脑批准后加入；邀请链接和手动地址放在次级入口。两台设备须在同一可互通的网络，电脑保持运行。使用 SDK 57 兼容的 Expo Go 可以调试基础流程；已配对设备发现、图片相册保存与完整系统分享入口需要自定义原生构建，Expo Go 不会注册本项目的原生发现模块和分享扩展。

`pnpm mobile:web` 提供同一份 React Native 界面的浏览器预览，连接凭据仅保留在页面内存。网页预览可测试群连接和文字消息；文件、相机权限和系统分享须在手机原生客户端验收。启动 `pnpm --dir apps/mobile exec expo start --web --port 8082` 后运行 `pnpm mobile:smoke`，验证真实后端配对、成员审批、两群隔离、草稿保留和 320px 小屏布局。结果截图在 `artifacts/mobile-*.png`，不应当作真机截图。

Android 已配置单/多文件分享 Intent，iOS 已配置 App Group 和 Share Extension。iOS 的外部分享接收使用 [Expo Sharing 实验性入口](https://docs.expo.dev/versions/v57.0.0/sdk/sharing/)，其打开主 App 的实现需要逐版本真机验证；正式发布前仍需验证 iOS/Android 权限、键盘、文件提供商、大文件、锁屏和分享回流。Android 原生编译交由 GitHub 托管运行器完成；当前本机环境未安装完整原生工具链，尚未完成手机真机验收。

## 已选视觉方案

Linux TUI 采用 [A 青绿工作台](docs/ui-concepts/2026-10-05-tui/A-teal-workbench.png)：宽屏显示群、会话、设备与任务三栏，中等宽度双栏，窄屏聚焦会话，随终端尺寸即时切换。支持安装 `pickdrop open` / `pickdrop stop` 快捷命令，并记住上次下载目录。操作与安装方式见 [Linux 使用指南](docs/linux.md)。

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
