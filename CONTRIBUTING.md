# Cindy Plugins 入驻与开发规范（高标准准则）

为确保 `cindy-plugins` 市场内所有插件的长期稳定性、跨架构通用性与最高安全等级，任何新增插件必须严格遵守以下工程规范：

---

## 插件入驻 Checklist

### 1. 清单与身份规范 (`ghost.json`)
- [ ] `schemaVersion` 必须为 `3`；
- [ ] `minCindyVersion` 必须如实填写插件依赖的首个 Cindy 正式版本（如 `3.0.0`）；
- [ ] `id` 格式：小写字母、数字与连字符，1–32 位，仓库内全局唯一；
- [ ] `command`：为用户提供显式调用点名的指令（如 `cube` / `aiod`）；
- [ ] `whenToUse`：**严格仅枚举意图场景**（<=300 字符），禁止包含调用规则或强制约束；
- [ ] `icon`：必须提供 `assets/icon.png`（推荐 128x128 像素 PNG，严禁使用 SVG）。

### 2. 凭证隔离与安全模型
- [ ] 敏感凭证（Token / Secret Key）**严禁**明文存储于配置文件或源码；
- [ ] 必须声明在 `node.secretBindings`（上限 4 条），存入主机 `safeStorage`；
- [ ] 必须配套提供高质量的 `settings.html`，通过 `PUT /secrets/<key>` 写入，通过 `GET /secrets` 读取保存状态（不得在页面中明文回显已存 Key）；
- [ ] 非敏感连接地址存放在 `setup.kv` 中，通过 `/kv` 接口存取。

### 3. 多平台全架构矩阵分发（杜绝臃肿脂肪包）
- [ ] 凡包含编译型二进制或原生 CLI 的插件，**必须支持主流 6 大平台**：
  - `macos-arm64` (`aarch64-macos`)
  - `macos-x64` (`x86_64-macos`)
  - `win-x64` (`x86_64-windows-gnu`)
  - `win-arm64` (`aarch64-windows-gnu`)
  - `linux-x64` (`x86_64-linux-musl`)
  - `linux-arm64` (`aarch64-linux-musl`)
- [ ] 在 `scripts/manifest.json` 的 `plugins` 节点中注册该插件的 upstream 发布资产模板与产物名称；
- [ ] 由 `scripts/build-market.py` 自动化组装单平台目录并打出单平台独立 `.cindy`，包体控制在 1MB 左右。

### 4. 进程与长任务控制
- [ ] 随包 Node Worker（`node/worker.cjs`）必须使用标准的逐行 JSON-RPC 2.0 协议；
- [ ] `process.stdout` **严禁**输出除 JSON-RPC 协议消息外的任何调试日志，所有排障日志一律输出到 `process.stderr`；
- [ ] 针对耗时操作（沙箱创建、镜像拉取、代码运行），必须提供三件套工具：
  - `*_submit`：异步提交并返回 `taskId`
  - `*_log`：流式/分页获取日志（Worker 必须实现环形日志缓冲，防止内存膨胀）
  - `*_kill`：优雅终止任务
- [ ] 请求配置必须声明 `maxTotalMs: 900000`（最长 15 分钟），启用“有输出即续期”机制。

---

## 插件添加步骤

1. 在 `plugins/<plugin-id>/` 目录下搭建源码骨架：
   ```text
   plugins/<plugin-id>/
   ├── ghost.json
   ├── main.js
   ├── settings.html
   ├── assets/
   │   └── icon.png
   └── node/
       └── worker.cjs
   ```
2. 在 `scripts/manifest.json` 中追加插件定义：
   ```json
   "plugins": {
     "your-plugin": {
       "id": "your-plugin",
       "name": "展示名",
       "description": "说明",
       "version": "0.1.0",
       "command": "cmd",
       "upstream": {
         "repo": "owner/repo",
         "tag": "latest",
         "artifact_template": "tool-{target}{ext}",
         "binary_name": "tool{ext}"
       }
     }
   }
   ```
3. 在本地运行测试构建：
   ```bash
   python3 scripts/build-market.py
   ```
4. 验证生成的 `.agents/plugins/marketplace.json` 与 `dist/packages/` 中的各架构 `.cindy` 文件；
5. 提交 PR 到 `main` 分支，由 GitHub Actions 自动化触发全架构 Release 发布与平台分支推送。
