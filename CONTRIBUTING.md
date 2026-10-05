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

1. 在同一个提交中更新根目录 package.json、apps/mobile/package.json 和 apps/mobile/app.json 版本；添加 `docs/releases/v<版本>.md` 发布说明。
2. 完成检查并合并至 main，再在该提交创建附注标签：

```sh
git tag -a v0.2.1 -m 'Release v0.2.1'
git push origin v0.2.1
```

3. Release 工作流校验标签与源码版本一致、执行检查，在 macOS/Windows 分别构建，然后发布 Mac Apple Silicon ZIP、Windows x64 便携 EXE 和 SHA256SUMS.txt。安装包上传 GitHub Release，不写进 Git 历史。

当前桌面工作流统一标记为预发布：桌面包未进行正式开发者签名或 macOS 公证，Windows 与手机真机检查仍需单独完成。不上传应用商店。未来正式发布前须补齐签名和实机验收。

如果工作流失败，在 Actions 中查看错误；源码有修复时应递增版本并创建新标签。重跑同一标签只可补齐失败流程，已经存在的 Release 资产不会被覆盖。仓库管理员可在 GitHub Rulesets 中为 main 启用 PR 审查和 `checks` 必须通过；本次没有擅自调整管理员权限设置。

## Android 内测 APK

`Android APK` 工作流可在 Actions 手动运行；修改工作流本身并推送 main 也会触发构建。它使用 JDK 17、Android SDK 36 和 Expo 生成原生工程，执行 `assembleRelease`，校验 APK 后发布至 `android-v<手机版本>`，不覆盖现有版本。

此流程只构建 ARM64 内测版。`PICKDROP_ANDROID_PREVIEW=1` 启用独立应用名称和包名 `app.pickdrop.mobile.preview`；release 构建内置 Hermes 资源，但使用 Expo 公开测试证书，不能作为正式发布者身份保证。正式版保留 `app.pickdrop.mobile`，必须另行配置私有签名。每次发布需要递增手机版本以及 `apps/mobile/app.config.js` 中的 Android versionCode；不要用同一版本标签发布不同内容。IPA 不在此工作流范围内。
