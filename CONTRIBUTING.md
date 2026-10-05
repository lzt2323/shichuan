# 开发与版本管理

`main` 保存可构建版本。每项改动使用独立分支（例如 `codex/mobile-share-fix`），通过 Pull Request 合并；避免直接修改发布标签，不使用强制推送覆盖共享历史。

## 本地检查

使用 Node.js 24 与 package.json 指定的 pnpm 版本：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm mobile:check
pnpm mobile:export
```

修改桌面交互后，在桌面环境运行对应的 `desktop:smoke`、`desktop:motion`、`desktop:visual`。手机浏览器 UI 检查及原生真机检查见 README。CI 的 JS 构建成功不等于原生安装包或真机验收成功。

源码、配置、锁文件、测试和设计文档纳入 Git；`node_modules`、构建目录、安装包、用户收件箱、密钥与签名文件不纳入 Git。更新依赖时同时提交 `pnpm-lock.yaml`。每次提交描述具体行为，例如 `feat: add mobile group pairing`、`fix: preserve drafts when switching groups`。

## 发布安装包

1. 在同一个提交中更新根目录 package.json、apps/tui/package.json、apps/mobile/package.json 和 apps/mobile/app.json 版本；添加 `docs/releases/v<版本>.md` 发布说明。
2. 完成检查并合并至 main，再在该提交创建附注标签：

```sh
git tag -a v0.3.0 -m 'Release v0.3.0'
git push origin v0.3.0
```

3. Release 工作流校验标签与源码版本一致、执行检查，在 macOS/Windows/Linux 分别构建桌面、终端和 Android 安装包，全部成功后统一发布到同一个 `v<版本>` Release。包含 Mac Apple Silicon ZIP、Windows x64 便携 EXE、Android ARM64 APK、Linux x64/ARM64 TUI tar.gz、ANDROID-BUILD.txt 和 SHA256SUMS.txt。安装包上传 GitHub Release，不写进 Git 历史。

当前全平台工作流统一标记为预发布：桌面包未进行正式开发者签名或 macOS 公证，Windows 与手机真机检查仍需单独完成。不上传应用商店。未来正式发布前须补齐签名和实机验收。

如果工作流失败，在 Actions 中查看错误；源码有修复时应递增版本并创建新标签。重跑同一标签只可补齐失败流程，已经存在的 Release 资产不会被覆盖。仓库管理员可在 GitHub Rulesets 中为 main 启用 PR 审查和 `checks` 必须通过；本次没有擅自调整管理员权限设置。

## Android 内测 APK

`Android APK` 是可复用构建工作流；可手动运行，或由统一 Release 工作流在 codex 分支预检。它使用 JDK 17、Android SDK 36 和 Expo 生成原生工程，执行 `assembleRelease`，校验 APK 后上传 Actions artifact。它不再单独创建 Android Release；发布标签触发的统一工作流收集该 APK，与其他平台放在同一 Release。

此流程只构建 ARM64 内测版。`PICKDROP_ANDROID_PREVIEW=1` 启用独立应用名称和包名 `app.pickdrop.mobile.preview`；release 构建内置 Hermes 资源，但使用 Expo 公开测试证书，不能作为正式发布者身份保证。正式版保留 `app.pickdrop.mobile`，必须另行配置私有签名。每次发布需要递增手机版本以及 `apps/mobile/app.config.js` 中的 Android versionCode；不要用同一版本标签发布不同内容。IPA 不在此工作流范围内。

## Linux 终端发行包

`pnpm linux:package --arch=x64` 或 `--arch=arm64` 生成携带 Node.js 运行时的 Linux 包。CI 在对应架构 Ubuntu 24.04 上构建并验证；不依赖 Electron 或图形桌面。具体命令和后台运行方式见 `docs/linux.md`。Linux 安装包与其他平台必须来自同一发布标签，不能混入旧版本资产。
