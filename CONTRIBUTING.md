# Cindy Plugins 入驻与开发规范

`cindy-plugins` 是一个公开的 Cindy 插件市场源。本文件是**入驻与改动的验收标准**——PR 只要违反其中任何一条硬规则就不会被合并。

---

## 0. 先搞清楚这个仓库里有什么

| 类别 | 例子 | 特征 |
|---|---|---|
| **纯 JS 插件** | `my-env` | 只有 `main.js` + `node/worker.cjs`，没有原生二进制 |
| **带原生二进制的插件** | `cube-cli`、`aiod-cli` | `bin/<os>-<arch>/` 下带按平台预编译的单文件可执行程序 |

**带二进制的插件不在这里写业务代码。** 代码与二进制都来自各自的上游独立仓库，本仓库只做三件事：**拉取、校验、打包分发**。

| 插件 | 上游仓库 | 跟随对象 |
|---|---|---|
| `cube-cli` | [otaku-say/cube-cli](https://github.com/otaku-say/cube-cli) | CubeSandbox 控制面 Python SDK（`TencentCloud/CubeSandbox`） |
| `aiod-cli` | [otaku-say/aiod-cli](https://github.com/otaku-say/aiod-cli) | 沙箱内 aiod 的 `/v2` API |

---

## 1. 命名硬规则

对外一律使用**系统全称**与**芯片架构标准名**，任何目录、产物、清单字段、文档都不得例外：

| 平台标识 | `os` | `arch` | 二进制目录 |
|---|---|---|---|
| `macos-arm64` | `macos` | `arm64` | `bin/macos-arm64/` |
| `macos-amd64` | `macos` | `amd64` | `bin/macos-amd64/` |
| `windows-amd64` | `windows` | `amd64` | `bin/windows-amd64/` |
| `windows-arm64` | `windows` | `arm64` | `bin/windows-arm64/` |
| `linux-amd64` | `linux` | `amd64` | `bin/linux-amd64/` |
| `linux-arm64` | `linux` | `arm64` | `bin/linux-arm64/` |

> - 禁止出现 `darwin` / `win32` / `x64` / `x86_64` / `aarch64` 作为**对外名称**。
> - `zig -Dtarget` 的三元组（`aarch64-linux-musl` 等）只是编译器内部叫法，可以出现在构建配置里，但产物名与文档一律用上表的写法。
> - 二进制**统一内嵌在 `main` 分支**的 `plugins/<id>/bin/<os>-<arch>/`，**不再使用 `plat/*` 架构专属分支**（历史分支已删除）。

---

## 2. 目录结构

```text
plugins/<plugin-id>/
├── ghost.json          # 插件身份与工具声明
├── main.js             # 宿主侧（浏览器沙箱）工具分发
├── settings.html       # 设置面板（外链脚本，禁内联）
├── settings.js
├── locales/
│   ├── zh-CN.json
│   └── en.json
├── assets/icon.png     # 128x128 PNG，禁 SVG
├── manual/guide/MANUAL.md   # 给 Agent 读的渐进披露手册
├── node/worker.cjs     # 随包 Node 工作进程（JSON-RPC 2.0 / stdio）
└── bin/<os>-<arch>/    # 仅带二进制的插件需要
```

---

## 3. `ghost.json` 规范

- `schemaVersion` 必须为 `3`；`minCindyVersion` 必须如实填写。
- `id`：小写字母、数字、连字符，1–32 位，仓库内唯一。
- `command`：给用户显式点名的指令前缀（如 `cube` / `aiod` / `env`）。
- `whenToUse`：**只枚举意图场景**（≤300 字符），不要写调用规则或限制。
- `tools[]` 必须与 `main.js` 的 `TOOL_DISPATCH` 一一对应（`tests/test_plugins.js` 会校验）。
- `version` 必须与 `scripts/manifest.json` 中同一条目完全一致。

---

## 4. 凭证隔离（安全红线）

- Token / Key **严禁**出现在源码、文档、日志、聊天上下文里。
- 敏感项声明在 `node.secretBindings`（≤4 条），由宿主存入操作系统级 `safeStorage`，仅在对应方法被调用时注入子进程环境变量。
- 非敏感配置（base URL、网关地址）走 `setup.kv` 与 `/kv`。
- 设置面板必须外链 `settings.js`，严格满足 CSP；密码框只回显「已保存」或尾号，绝不回显明文。

---

## 5. 二进制分发：只从上游拉，不手改

二进制来自上游仓库的 `latest` Release，命名固定为 `<tool>-<os>-<arch>[.exe]`：

```text
aiod-cli-macos-arm64     aiod-cli-windows-amd64.exe
aiod-cli-macos-amd64     aiod-cli-windows-arm64.exe
aiod-cli-linux-arm64     aiod-cli-linux-amd64
```

本仓库的同步链路（`.github/workflows/build-market.yml`，全部自动）：

| 步骤 | 做什么 |
|---|---|
| 1. `build-market.py --fetch` | 按 `scripts/manifest.json` 的 `upstream` 配置，从上游 `latest` Release 拉 6 个平台资产到 `.cache/upstream/<id>/` |
| 2. SHA256 校验 | 用上游 `SHA256SUMS` 逐个比对；**任一不符即整条流水线失败**，绝不发布坏二进制 |
| 3. `embed-binaries.py --bump` | 把资产内嵌到 `plugins/<id>/bin/<os>-<arch>/`；内容有变化就 patch 版本 +1，并清理非标准目录 |
| 4. `build-market.py` | 生成单平台 `.cindy` 包 + `.agents/plugins/marketplace.json` |
| 5. Release | 把平台包挂到 `v<max(version)>` |

**上游发版后怎么跟：** 不需要手改版本号——CI 发现某个插件的二进制内容变化时，会自动把它的 patch 版本 +1（`0.2.0` → `0.2.1`），并把 `bin/`、`scripts/manifest.json`、`plugins/<id>/ghost.json` 放在同一笔提交里，本地 Cindy 因此能识别出「有新版本」。只想手动指定版本时，才改 `scripts/manifest.json` 里的 `version`（同时改 `ghost.json` 的 `version`，两者必须相等），push 即可。**不要**手工往 `bin/` 里拷文件，也不要在本仓库编译二进制。

`scripts/manifest.json` 的 upstream 段：

```json
"upstream": {
  "repo": "otaku-say/aiod-cli",
  "tag": "latest",
  "artifact_template": "aiod-cli-{os}-{arch}{ext}",
  "binary_name": "aiod-cli{ext}"
}
```

`artifact_template` 支持 `{target}`（zig 三元组）、`{os}`、`{arch}`、`{ext}` 四个占位符。

---

## 6. 手册（`manual/guide/MANUAL.md`）规范

手册是 Agent 唯一会读到的用法说明，因此**必须与上游真实命令面对齐**：

- 命令名、参数名、flag 写法必须能在上游 `help all` / `docs/` 里查到，**不许凭印象写**；
- 必须写清：什么时候用、需要哪些环境变量、插件暴露的工具、常用命令示例、**退出码约定**、常见错误与恢复；
- 上游命令改名、删除或新增能力时，手册与 `ghost.json` 的 `whenToUse` 同步更新；
- 建议附一行上游仓库链接，方便读者核对最新命令表。

> 自查：手册里出现的每个 `cmd` 都应能在上游 `docs/<tool>.md` 的 `用法:` 行里找到同名命令。

---

## 7. 长任务与 Worker 规范

- `node/worker.cjs` 走**逐行 JSON-RPC 2.0**（stdio）；`stdout` 只允许协议消息，排障日志一律走 `stderr`。
- 耗时操作（建沙箱、拉镜像、跑代码）必须提供三件套：
  - `*_submit`：异步提交，返回 `taskId` 并立即结清；
  - `*_log`：增量/分页取日志（Worker 侧要有环形缓冲，防内存膨胀）；
  - `*_kill`：终止任务。
- 单次请求配置 `maxTotalMs: 900000`（15 分钟），支持「有输出即续期」。

---

## 8. 新增一个插件的步骤

1. 建 `plugins/<plugin-id>/` 骨架（结构见第 2 节），写好 `ghost.json` / `main.js` / `settings.html` / `settings.js` / `locales` / `assets/icon.png` / `manual/guide/MANUAL.md`。
2. 在 `scripts/manifest.json` 的 `plugins` 节点登记：`id`、`name`、`description`、`version`、`command`、`author`、`tags`；带二进制的再加 `upstream`（见第 5 节）。
3. 本地验证：
   ```bash
   node --test tests/test_plugins.js      # 清单/工具/版本一致性
   python3 scripts/build-market.py        # 生成平台包与 marketplace.json
   ```
4. 检查 `dist/packages/` 与 `.agents/plugins/marketplace.json` 内容是否正确。
5. 提交 PR 到 `main`，CI 会完成：上游拉取 → SHA256 校验 → 内嵌二进制 → 打包 → 发布 Release。

---

## 9. 合并前自查清单

- [ ] 命名全部符合第 1 节（含文档、产物名、目录名）
- [ ] `ghost.json` 与 `scripts/manifest.json` 的 `version` 一致
- [ ] `ghost.json` 的 `tools[]` 与 `main.js` 的 `TOOL_DISPATCH` 一致
- [ ] 无任何明文密钥/主机名/IP 进入仓库
- [ ] 二进制未手改，全部来自上游 Release 且通过 SHA256SUMS 校验
- [ ] `manual/guide/MANUAL.md` 的命令/参数与上游一致
- [ ] `node --test tests/test_plugins.js` 通过
- [ ] `python3 scripts/build-market.py` 可跑通并生成 6 个平台的包
