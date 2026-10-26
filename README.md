# Cindy Plugins Market（Cindy 自定义插件市场）

[![Market Version](https://img.shields.io/badge/market-v0.1.0-blue.svg)](https://github.com/otaku-say/cindy-plugins)
[![Platform Support](https://img.shields.io/badge/platforms-6%20architectures-green.svg)](https://github.com/otaku-say/cindy-plugins)
[![Security Audited](https://img.shields.io/badge/security-safeStorage%20isolated-orange.svg)](https://github.com/otaku-say/cindy-plugins)

公开、高标准的 Cindy 扩展能力插件市场。支持 **多操作系统与多芯片架构自动匹配**、**轻量瘦身包分发** 与 **企业级凭证安全隔离**。

---

## 快速开始：在 Cindy 中添加本市场

在 Cindy 应用中，进入 **「设置 (Settings)」→「插件 (Plugins)」→「市场来源 (Marketplaces)」**：
1. 点击 **「添加市场源 (Add Marketplace)」**
2. 填入本仓库地址：
   ```text
   https://github.com/otaku-say/cindy-plugins
   ```
3. 保存后，Cindy 将自动根据你当前的操作系统与芯片架构拉取对应的轻量插件列表，开箱即用。

---

## 当前已收录插件

| 插件 ID | 插件展示名 | 指令前缀 | 架构覆盖 | 一句话说明 |
| :--- | :--- | :--- | :--- | :--- |
| **`cube-cli`** | **Cube CLI** | `$cube` | 6 平台全支持 | 控制面遥控器：创建沙箱、生命周期启停、端口探测与元数据管理 |
| **`aiod-cli`** | **Aiod CLI** | `$aiod` | macOS / Linux | 沙箱内部遥控器：文件读写传输、进程交互、浏览器遥控与 MCP Server |

---

## 核心架构设计

### 1. 全平台与芯片架构自动适配矩阵（零冗余瘦身分发）

每个包含原生工具链或二进制的插件，均覆盖 6 种主流系统与架构：

| 平台标识 (`platform`) | 系统 (`os`) | 芯片架构 (`arch`) | 编译 Target | 产物形态 |
| :--- | :--- | :--- | :--- | :--- |
| `macos-arm64` | `darwin` | `arm64` | `aarch64-macos` | 单平台轻量包（临时 codesign） |
| `macos-x64` | `darwin` | `x64` | `x86_64-macos` | 单平台轻量包（临时 codesign） |
| `win-x64` | `win32` | `x64` | `x86_64-windows-gnu` | 单平台轻量包 (`.exe`) |
| `win-arm64` | `win32` | `arm64` | `aarch64-windows-gnu` | 单平台轻量包 (`.exe`) |
| `linux-x64` | `linux` | `x64` | `x86_64-linux-musl` | 静态 musl 纯净二进制 |
| `linux-arm64` | `linux` | `arm64` | `aarch64-linux-musl` | 静态 musl 纯净二进制 |

**自动适配机制**：
- **市场清单双重索引**：`.agents/plugins/marketplace.json` 在插件条目中直接包含 `platforms` 架构映射表，Cindy 客户端在检测到当前环境（如 `darwin-arm64`）后，仅精准下载该架构的专属包（大小仅 ~700KB，较混合大包瘦身 80% 以上）。
- **分支镜像（Orphan Branches）**：仓库同步维护 `plat/macos-arm64`、`plat/win-x64` 等轻量孤立分支，各分支仅存放本平台的单套二进制。

---

### 2. 企业级凭证安全隔离模型

所有插件严格遵守 Cindy 安全红线，绝不在聊天上下文、模型输入或本地源码中明文传递密钥：
- **敏感凭证（API Key）**：
  - 声明于 `node.secretBindings`，由用户在详情页或设置页自绘界面（`settings.html`）填入；
  - 存储于主机操作系统级别的受保护安全保险库（`safeStorage`）；
  - 仅在发起特定 Node 工作进程方法时，由主机在底层临时注入子进程环境变量，绝不进入标准输出或日志流。
- **配置项（API URL / 网关地址）**：
  - 存放于 `setup.kv` 与 `/kv` 接口，支持灵活配置与测试。
- **设置面板**：
  - 均提供独立的 `settings.html`，自动适配系统亮/暗色主题，提供安全状态脱敏回显与实时连通性探测。

---

### 3. 长任务异步控制体系（三件套）

凡涉及沙箱镜像拉取、代码执行或长耗时任务，均提供非阻塞的异步执行规范：
- `*_submit`：异步提交，返回唯一 `taskId` 并立即结清；
- `*_log`：流式或增量获取最新标准输出与错误日志（支持环形日志缓冲，防内存泄漏）；
- `*_kill`：主动向执行中进程发送 `SIGTERM` / `SIGKILL` 信号实现可控中止；
- 单次 Node 请求配置 `maxTotalMs: 900000`（最长 15 分钟），支持“有输出即续期”，避免超时异常。

---

## 未来新插件入驻高标准规范

本仓库未来将持续收录新的优质工具链插件。所有拟入驻插件均须符合以下标准工程范式：

1. **结构完备性**：
   - 必须包含规范的 `ghost.json`（`schemaVersion: 3`，必填 `minCindyVersion`）；
   - `whenToUse` 必须为纯场景枚举，禁止塞入调用规则；
   - 必须提供 `settings.html`（自适应暗黑模式，接入 `/secrets` 与 `/kv`）；
   - 必须提供 128x128 像素 PNG 图标。
2. **多架构覆盖**：
   - 包含原生代码或 CLI 的插件，必须在 `scripts/manifest.json` 中配置全平台构建矩阵映射；
   - 由自动化工作流统一拉取上游发布资产、做 SHA256SUMS 强校验后生成单平台轻量包。
3. **安全与幂等**：
   - 严格落实密钥安全隔离，所有操作与初始化流程必须具备幂等性（重复调用零副作用）。

详细入驻指南请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md)。
