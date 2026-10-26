# Cindy Plugins Market（Cindy 自定义插件市场）

[![Market Version](https://img.shields.io/badge/market-v0.1.2-blue.svg)](https://github.com/otaku-say/cindy-plugins)
[![Platform Matrix](https://img.shields.io/badge/platforms-6%20architectures-green.svg)](https://github.com/otaku-say/cindy-plugins)
[![Security Audited](https://img.shields.io/badge/security-safeStorage%20isolated-orange.svg)](https://github.com/otaku-say/cindy-plugins)

公开、高标准的 Cindy 扩展能力插件市场。严格遵循 **操作系统全称 (`macos` / `windows` / `linux`)** 与 **芯片架构标准名称 (`arm64` / `amd64`)** 规范，提供 **全架构自动识别适配**、**平台原生专属轻量订阅** 与 **企业级凭证安全隔离**。

---

## 快速开始：添加插件市场

进入 Cindy 应用中的 **「设置 (Settings)」→「插件 (Plugins)」→「市场来源 (Marketplaces)」**，点击 **「添加市场源 (Add Marketplace)」**。

你可以根据自身设备需求，选择以下两种添加方式之一：

### 推荐方式：按你的系统与芯片架构添加专属商店地址（极致瘦身，零异构文件）

直接订阅与当前设备硬件 100% 匹配的架构专属分支，从源头**仅拉取当前芯片架构的原生程序（包体仅约 600KB ~ 850KB）**，完全不下载任何其他操作系统的冗余文件：

| 操作系统 (`os`) | 芯片架构 (`arch`) | 适用设备说明 | 架构专属商店添加地址（直接复制） |
| :--- | :--- | :--- | :--- |
| **`macos`** | **`arm64`** | **Apple Silicon (M1 / M2 / M3 / M4 芯片全系列 Mac)** | `https://github.com/otaku-say/cindy-plugins#plat/macos-arm64` |
| **`macos`** | **`amd64`** | **Intel 处理器系列 Mac** | `https://github.com/otaku-say/cindy-plugins#plat/macos-amd64` |
| **`windows`** | **`amd64`** | **Windows 64位（Intel / AMD 处理器 PC / 笔记本）** | `https://github.com/otaku-say/cindy-plugins#plat/windows-amd64` |
| **`windows`** | **`arm64`** | **Windows on ARM（骁龙 X Elite / Surface Pro 等）** | `https://github.com/otaku-say/cindy-plugins#plat/windows-arm64` |
| **`linux`** | **`amd64`** | **Linux 64位（x86_64 架构服务器 / 工作站）** | `https://github.com/otaku-say/cindy-plugins#plat/linux-amd64` |
| **`linux`** | **`arm64`** | **Linux ARM64（aarch64 架构云主机 / 边缘设备）** | `https://github.com/otaku-say/cindy-plugins#plat/linux-arm64` |

---

### 通用方式：添加全架构主仓库地址（全平台通用）

如果你经常在多台不同系统的设备间同步配置，可直接添加通用主仓库：
```text
https://github.com/otaku-say/cindy-plugins
```
*注：通用主仓库内嵌了全套架构矩阵，插件运行时会根据当前硬件自动加载对应的架构二进制，并立即自动物理清理所有异构平台目录。*

---

## 当前已收录插件

| 插件 ID | 展示名称 | 指令前缀 | 架构覆盖 | 一句话说明 |
| :--- | :--- | :--- | :--- | :--- |
| **`cube-cli`** | **Cube CLI** | `$cube` | 6 架构全覆盖 | CubeSandbox 控制面遥控器：创建沙箱、生命周期启停、端口探测与元数据管理 |
| **`aiod-cli`** | **Aiod CLI** | `$aiod` | 6 架构全覆盖 | 沙箱内部遥控器：文件读写传输、进程交互、浏览器遥控与 MCP Server |

---

## 核心架构与工程规范

### 1. 全平台全架构标准矩阵

所有包含原生工具链或二进制的插件，均覆盖 6 种标准系统与芯片架构：

| 平台标识 (`platform`) | 系统全称 (`os`) | 架构名称 (`arch`) | 编译 Target | 产物命名范式 |
| :--- | :--- | :--- | :--- | :--- |
| `macos-arm64` | `macos` | `arm64` | `aarch64-macos` | `<id>-<version>-macos-arm64.cindy` |
| `macos-amd64` | `macos` | `amd64` | `x86_64-macos` | `<id>-<version>-macos-amd64.cindy` |
| `windows-amd64` | `windows` | `amd64` | `x86_64-windows-gnu` | `<id>-<version>-windows-amd64.cindy` |
| `windows-arm64` | `windows` | `arm64` | `aarch64-windows-gnu` | `<id>-<version>-windows-arm64.cindy` |
| `linux-amd64` | `linux` | `amd64` | `x86_64-linux-musl` | `<id>-<version>-linux-amd64.cindy` |
| `linux-arm64` | `linux` | `arm64` | `aarch64-linux-musl` | `<id>-<version>-linux-arm64.cindy` |

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
  - 均提供独立的 `settings.html` + `settings.js`（严格满足 CSP 策略），自动适配系统亮/暗色主题，提供安全状态脱敏回显与实时连通性探测。

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
   - 必须提供 `settings.html` 与外挂 `settings.js`（自适应暗黑模式，接入 `/secrets` 与 `/kv`）；
   - 必须提供 128x128 像素 PNG 高清图标。
2. **多架构覆盖与命名统一**：
   - 必须在 `scripts/manifest.json` 中配置全平台构建矩阵映射，严格遵循 `macos`, `windows`, `linux` 与 `arm64`, `amd64` 命名；
   - 由自动化工作流统一拉取上游发布资产、做 SHA256SUMS 强校验后生成单平台轻量包与平台孤立分支。
3. **安全与幂等**：
   - 严格落实密钥安全隔离，所有操作与初始化流程必须具备幂等性（重复调用零副作用）。

详细入驻指南请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md)。
