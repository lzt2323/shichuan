# 拾传 Linux 终端版

Linux TUI 与 Mac、Windows、Android 使用同一群协议。终端主界面保留多人消息流，文字与文件一起显示，不按文件类型拆分。适用于 Linux 桌面、服务器、小主机和 SSH。此安装包是终端版，不包含 Linux 图形窗口。

## v0.5.1 多端群

Linux TUI 的创建、加入和后台服务已接入与桌面、Android 相同的签名副本协议。创建者退出后，在线 Linux 成员继续文字和文件传输。缺少在线文件副本时，任务进入等待并每 10 秒重试，可以取消；重启 TUI 服务后需重新发起任务。请各端同步升级至 v0.5.1。

群管理支持 `pickdrop rename "新名称" --group ID`、`leave`、`forget`、`delete`、`upgrade`；`delete` 为创建者解散群，`forget` 只移除本机列表，旧群只能在原托管设备 `upgrade`。升级保留旧文件，其他设备需要重新申请。跨子网发现失败时可使用完整邀请链接，或 `join --address 172.29.5.94 --code 123456`；已加入群可用 `reconnect --group ID --address IP[:PORT]` 修复地址。IP 可达仍取决于路由、防火墙和网络隔离。

Linux 当前发行物仍为 TUI。源码运行 Electron 时，X11 提供完整自定义窗口；原生 Wayland 的窗口位置能力有限，详见 [多端群说明](peer-groups.md)。

## 下载与启动

在同一个 GitHub Release 中选择：

- `PickDrop-0.5.1-Linux-x64-TUI.tar.gz`：常见 Intel / AMD 64 位 Linux。
- `PickDrop-0.5.1-Linux-arm64-TUI.tar.gz`：64 位 ARM Linux。

解压后进入目录运行 `./pickdrop`。包内已包含 Node.js 24，无需安装 Node、npm、pnpm 或管理员权限。面向 glibc 系统，发布流水线使用 Ubuntu 24.04 对应架构验证；不支持 Alpine/musl，也不是 32 位 ARM 包。若下载后执行位丢失，运行 `chmod +x pickdrop runtime/bin/node`。保留完整目录；不要单独移动启动脚本。

```sh
tar -xzf PickDrop-0.5.1-Linux-x64-TUI.tar.gz
cd PickDrop-0.5.1-Linux-x64-TUI
./pickdrop
```

默认打开 TUI 时运行本次会话服务，退出会停止本次服务。`./pickdrop --background` 明确启用退出界面后继续运行；若后台已由 `start` 或 systemd 启动，退出 TUI 不会停止它。`status` 从不自动启动服务。

```sh
./pickdrop start
./pickdrop status
./pickdrop stop
```

### 在任意目录快速打开和关闭

先将解压后的完整应用目录放在固定位置，在该目录执行一次：

```sh
./pickdrop install
```

这会把快捷命令安装到 `~/.local/bin/pickdrop`，不需要 sudo，也不会覆盖其他同名程序。如果安装器提示该目录不在 `PATH`，按提示运行 `export PATH="$HOME/.local/bin:$PATH"`，并将该行加入 `~/.bashrc` 或 `~/.zshrc` 以便新终端继续生效。

之后在任意目录都可以使用：

```sh
pickdrop open          # 打开终端界面；直接输入 pickdrop 也可以
pickdrop start         # 仅启动后台服务
pickdrop --background  # 打开界面，退出后继续后台传输
pickdrop stop          # 停止服务及未完成传输，已打开的界面随后退出
```

`Ctrl+C` 是退出当前界面的快捷键。默认直接启动时，会同时停止本次服务；连接已有后台服务时只退出界面。要明确停止后台，使用 `pickdrop stop`，重复执行也安全。

应用目录移动或升级到新目录后，在新目录重新执行 `./pickdrop install` 更新快捷命令。`pickdrop uninstall` 仅移除快捷命令，不删除数据或安装目录；高级用法可通过 `--bin-dir /你的/bin` 指定快捷命令目录。

## 交互

以下方向键交互自 v0.3.3 起提供；旧版用户请按正常升级流程替换安装目录。

应用启动后默认**浏览消息**，不会直接把键盘输入作为待发送文字。文字和文件共用一条时间线；选中的消息采用指示符与高亮显示，长链接只显示摘要，进入完整内容后可滚动阅读。

| 所在区域 | ↑ / ↓ | ← | → | Enter |
| --- | --- | --- | --- | --- |
| 工作空间 | 选群或功能，右侧立即联动 | 保持当前区域 | 进入对应内容区 | 同右键，可选用 |
| 消息列表 | 选择消息 | 工作空间 | 消息操作 | 打开消息操作，可选用 |
| 消息操作 | 选择操作 | 返回原消息 | 进入详情或目录编辑；不会启动下载 | 确认下载、重试或执行所选操作 |
| 完整内容 | 逐行滚动 | 返回消息操作 | 保持当前区域 | 保持当前区域 |
| 文字输入 | 保持输入区 | 移动光标；行首返回工作空间 | 移动光标 | 发送文字 |

**工作空间选中某个群就立即切群，不需要再按 Enter。** 后续“发送消息”“发送文件”和“传输任务”均对应当前群；发送前核对顶部群名。离开消息列表再返回时保留该群选中的消息。功能项也会立即切换预览，选中“保存位置”时右侧显示默认目录，不再停留在消息内容。

### 下载收到的文件

1. 在消息列表按 ↑ / ↓ 选中文件。
2. 按 → 移到操作区，查看文件和默认保存目录。
3. 选中“下载文件”后按 Enter 确认。方向键本身不会启动下载。
4. 下载进行中显示“正在下载”；失败后可以选择“重试下载”；完成后选择“查看保存位置”。

需要临时换目录时，在操作区选择“更改保存位置”，按 → 进入编辑，Enter 使用该目录并下载；Esc 取消。下载同名文件会自动另存，SHA-256 校验不通过会删除临时文件。

### 发送文字和文件

发送文字：按 ← 进入工作空间，用 ↑ / ↓ 选“发送消息”，按 → 移入输入区，再输入文字并按 Enter 发送。左右键在输入区移动光标，Esc 返回并保留草稿；行首再按 ← 也可回到工作空间。

发送文件：在工作空间选“发送文件”，按 → 打开本机文件选择器。↑ / ↓ 浏览，→ 或 Enter 进入目录，选中文件后按 Enter 或空格切换勾选；最后移到列表末尾的**“发送已选文件”**并按 Enter。无需记忆发送快捷键。列表末尾还有“输入其他路径”，可编辑目录并使用 Tab 补全；Ctrl+S、Ctrl+L 仍供熟悉的用户快速操作。

SSH 中文件选择器读写远端 Linux，界面显示当前机器名称。自动发现也发生在远端服务器的局域网；不能跨 SSH 自动发现你本地笔记本的网络。

### 工作空间和保存位置

工作空间提供群、发送消息、发送文件、传输任务、保存位置和更多功能。更多功能包含创建群、发现附近群、加入、邀请、审批、设备、网络与帮助。任务菜单仍支持 C 取消、R 重试，重试从头开始。

保存目录默认沿用**本机上一次成功保存的目录设置，或成功加入下载队列时选择的目录**，在各个群之间共用，重启应用后仍保留；首次为 `~/Downloads/拾传`。在工作空间选“保存位置”，按 → 编辑，再按 Enter 保存，不必先下载文件。目录不可写等校验失败不会覆盖旧设置。命令行 `receive` 省略 `--dir` 也使用这个目录；显式指定 `--dir` 会在成功入队后更新默认值。

Esc 按当前层级返回；Ctrl+U 清空输入，Ctrl+C 退出界面。原有 Ctrl+P 菜单、Ctrl+G 切群、Ctrl+O 文件选择器仍可使用；它们不是日常浏览、下载和发送的必要步骤。PageUp / PageDown 可快速移动消息或滚动长内容。

### 窗口大小和颜色

界面随窗口尺寸即时调整，字符列按终端计算，中文通常占两列：

| 终端宽度 | 布局 |
| --- | --- |
| 至少 140 列 | 工作空间、消息、消息操作并排显示 |
| 100–139 列 | 工作空间和内容两栏；进入消息操作后替换内容区 |
| 不足 100 列 | 消息或操作单栏；移到工作空间时临时显示导航和内容预览 |

已针对 160×40、120×30、80×24、60×18 检查主要页面。高度较小时压缩菜单行距，列表随焦点滚动，详情分层进入；建议至少 60×18，40×12 只保留有限内容。调整尺寸不应丢失选中消息或输入。

背景优先使用终端支持的明确深黑色：真彩色为深黑 RGB、256 色为索引 232、基础终端退回 ANSI 黑色；只给当前操作区域的选中项加高亮。终端自身的透明度、主题调色板和字体会影响最终观感，应用无法覆盖所有宿主终端设置。

首次加入可选择附近群再输入邀请码，或者粘贴完整邀请链接，随后由已有成员批准。创建群后“邀请”显示可达的局域网地址、短邀请码；终端足够大时显示二维码。网络菜单可选自动或具体接口。主动切换网络时正在传输会提示先完成或取消；自动发现被路由器阻止时尝试邀请链接，网络隔离和防火墙仍需解除。

## 脚本调用

先启动后台。群可以用名称或完整 ID 指定；名称重复时必须使用 ID。

```sh
./pickdrop create '工作群'
./pickdrop nearby
./pickdrop invite --group '工作群'
./pickdrop join --link 'http://192.168.1.23:50000/#invite=123456&group=示例群ID'
./pickdrop requests --group '工作群'
./pickdrop approve 请求ID --group '工作群'
./pickdrop message '服务器构建完成' --group '工作群'
./pickdrop send ./build.tar.gz --group '工作群' --wait
./pickdrop messages --group '工作群'
./pickdrop receive 文件消息ID --group '工作群' --dir ~/Downloads/拾传 --wait
./pickdrop receive --all --group '工作群' --dir ~/Downloads/拾传 --wait
```

上面的邀请链接只展示格式；请使用应用生成的真实链接。`--wait` 等待完成并在失败/取消时返回非零退出码。不带 `--wait` 返回任务 ID，后台继续处理。`messages` 默认返回最新一页，可用 `--before <sequence>` 读取更早消息；终端在历史顶部按 ↑ / PgUp 加载上一页。`receive --all` 按页串行下载历史中仍可用的全部文件，重复执行会另存，不是同步目录或自动订阅。新多端群上传完成表示本机已保存副本，不代表所有成员都已下载；旧群仍表示托管主机已保存。

## 可选常驻服务

安装包放到固定位置后：

```sh
./pickdrop service install
./pickdrop stop
systemctl --user daemon-reload
systemctl --user enable --now pickdrop
```

安装命令只写入用户服务，不自动启用。无人登录也需常驻的机器，由管理员按需配置用户 linger。不要同时启动两个相同用户数据目录的实例。更新前先停止服务，保留用户数据，再替换安装目录并重启。systemd 的 ExecStart 使用安装目录绝对路径；移动后重新运行 `service install`。

## 数据与边界

保存目录偏好写入 `$XDG_CONFIG_HOME/pickdrop/preferences.json`（默认 `~/.config/pickdrop/preferences.json`），使用原子替换，文件权限为 0600。

数据在 `$XDG_DATA_HOME/pickdrop`（默认 `~/.local/share/pickdrop`），日志在 `$XDG_STATE_HOME/pickdrop`，本机 Unix socket 优先使用 `$XDG_RUNTIME_DIR/pickdrop`，否则使用私有 state/run。目录权限 0700、socket/密钥文件 0600。命令输出不会包含群密钥或审批轮询密钥；邀请命令会按操作目的显示临时邀请码。远端消息会移除终端控制字符，避免把文件名/消息当终端指令执行。

传输任务与等待批准的加入申请暂存在服务内存；关闭/重启服务会中断，需重新发起。没有分块续传、目录同步、终端图片预览或公网中继。文件传输沿用当前 HTTP 局域网协议，并非端到端加密；只在可信局域网使用。当前不支持拖拽文件到 SSH 终端自动上传。

## 源码开发与打包

```sh
pnpm install --frozen-lockfile
pnpm tui
pnpm test
pnpm tui:visual
pnpm linux:package --arch=x64
pnpm linux:package --arch=arm64
```

`tui:visual` 用隔离的演示数据捕获实际 Ink 输出，检查 160×40、120×30、80×24 和 60×18 四档尺寸；ANSI、纯文本和 PNG 预览保存在 `artifacts/tui/`。PNG 由 Chromium 展示字符输出生成，不替代真实 Linux 终端、字体与 SSH 的验收。完整步骤见 [Linux TUI 方向键交互验收](tui-arrow-acceptance.md)。

打包根据锁定安装依赖复制生产依赖闭包，保留包许可证，下载 Node 官方运行时并校验官方 SHA-256。每个架构在对应 Linux runner 中执行安装包 help/status/后台创建群与消息收发 smoke；生成的 `BUILD-INFO.json` 记录版本和 Node 校验值。许可证保留在 `runtime/LICENSE` 和各 `app/node_modules` 包内。
