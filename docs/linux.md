# 拾传 Linux 终端版

Linux TUI 与 Mac、Windows、Android 使用同一群协议。终端主界面保留多人消息流，文字与文件一起显示，不按文件类型拆分。适用于 Linux 桌面、服务器、小主机和 SSH。此安装包是终端版，不包含 Linux 图形窗口。

## 下载与启动

在同一个 GitHub Release 中选择：

- `PickDrop-0.3.2-Linux-x64-TUI.tar.gz`：常见 Intel / AMD 64 位 Linux。
- `PickDrop-0.3.2-Linux-arm64-TUI.tar.gz`：64 位 ARM Linux。

解压后进入目录运行 `./pickdrop`。包内已包含 Node.js 24，无需安装 Node、npm、pnpm 或管理员权限。面向 glibc 系统，发布流水线使用 Ubuntu 24.04 对应架构验证；不支持 Alpine/musl，也不是 32 位 ARM 包。若下载后执行位丢失，运行 `chmod +x pickdrop runtime/bin/node`。保留完整目录；不要单独移动启动脚本。

```sh
tar -xzf PickDrop-0.3.2-Linux-x64-TUI.tar.gz
cd PickDrop-0.3.2-Linux-x64-TUI
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

终端界面采用青绿工作台，随窗口尺寸即时调整。尺寸按终端的字符列和行计算，中文通常占两列：

| 终端尺寸 | 布局 |
| --- | --- |
| 宽度至少 140 列、高度至少 26 行 | 左侧传输群、中间会话、右侧设备与当前群传输任务 |
| 宽度 100–139 列、空间充足 | 左侧群与设备，右侧会话；传输摘要靠近输入区 |
| 宽度不足 100 列，或高度较小 | 优先显示单栏会话、任务摘要与输入区；群和设备通过菜单进入 |

所有布局保留文字与文件的共同时间线。侧栏收起不影响切群、发文件、下载、审批和任务操作。改变窗口尺寸不应丢失当前输入；较小终端会缩短提示，完整操作说明在 `Ctrl+P → 帮助与快捷键` 中。

- `Ctrl+P`：菜单（创建群、附近的群、链接加入、邀请、网络、下载、审批、任务）。
- `Ctrl+G`：切换群。`Enter`：发送文字。`PageUp / PageDown`：历史。
- `Ctrl+O`：文件选择器。上下键选择，Enter 进入目录，空格多选，Ctrl+S 发送。Ctrl+L 输入路径后 Tab 补全；可输入 `../` 返回父目录。
- 下载从菜单选择文件，再填写保存目录；同名自动另存，SHA-256 校验不通过会删除临时文件。
- 任务菜单用 `C` 取消，`R` 重试。重试从头开始。
- `Esc` 返回，`Ctrl+U` 清空输入，`Ctrl+C` 退出界面。

SSH 中文件选择器读写远端 Linux，界面显示当前机器名称。自动发现也发生在远端服务器的局域网；不能跨 SSH 自动发现你本地笔记本的网络。

保存目录默认沿用**本机上一次成功加入下载队列时选择的目录**，在各个群之间共用，重启应用后仍保留；首次为 `~/Downloads/拾传`。选择失败、目录不可写或文件已失效时不会覆盖旧设置。命令行 `receive` 省略 `--dir` 也使用这个目录；显式指定 `--dir` 会在成功入队后更新默认值。

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

上面的邀请链接只展示格式；请使用应用生成的真实链接。`--wait` 等待完成并在失败/取消时返回非零退出码。不带 `--wait` 返回任务 ID，后台继续处理。`receive --all` 下载当前历史的全部文件，重复执行会另存，不是同步目录或自动订阅。上传完成仅表示群主机已保存，不代表所有成员都已下载。

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

`tui:visual` 用隔离的演示数据捕获实际 Ink 输出，检查 160×40、120×30、80×24 和 60×18 四档尺寸；ANSI、纯文本和 PNG 预览保存在 `artifacts/tui/`。PNG 由 Chromium 展示字符输出生成，不替代真实 Linux 终端、字体与 SSH 的验收。

打包根据锁定安装依赖复制生产依赖闭包，保留包许可证，下载 Node 官方运行时并校验官方 SHA-256。每个架构在对应 Linux runner 中执行安装包 help/status/后台创建群与消息收发 smoke；生成的 `BUILD-INFO.json` 记录版本和 Node 校验值。许可证保留在 `runtime/LICENSE` 和各 `app/node_modules` 包内。
