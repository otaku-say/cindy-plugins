# Cindy Plugins Market（Cindy 自定义插件市场）

[![Market Version](https://img.shields.io/badge/market-v0.3.0-blue.svg)](https://github.com/otaku-say/cindy-plugins)
[![Platform Matrix](https://img.shields.io/badge/platforms-6%20architectures-green.svg)](https://github.com/otaku-say/cindy-plugins)
[![Security Audited](https://img.shields.io/badge/security-safeStorage%20isolated-orange.svg)](https://github.com/otaku-say/cindy-plugins)

公开、高标准的 Cindy 扩展能力插件市场。严格遵循 **操作系统全称 (`macos` / `windows` / `linux`)** 与 **芯片架构标准名称 (`arm64` / `amd64`)** 规范，提供 **全架构自动识别适配**、**按平台裁剪的轻量安装包** 与 **企业级凭证安全隔离**。

---

## 快速开始：添加插件市场

进入 Cindy 应用中的 **「设置 (Settings)」→「插件 (Plugins)」→「市场来源 (Marketplaces)」**，点击 **「添加市场源 (Add Marketplace)」**，填入下面这一个地址即可（**只有一个地址，不需要按架构选择**）：

```text
https://github.com/otaku-say/cindy-plugins
```

添加后，市场清单会按当前设备的 `os` + `arch` **自动挑选对应的平台包**下载安装——你只会拿到与自己硬件匹配的那一份，不会下载其他操作系统的二进制。

### 平台包是怎么来的

本仓库的 `main` 分支**同时存放全部 6 个架构的二进制**，因此任何设备一次 `clone` 就能直接运行，不依赖额外的分支或子模块。适合分发的是按平台裁剪的 `.cindy` 包，它们由 CI 生成并挂在 [Releases](https://github.com/otaku-say/cindy-plugins/releases/latest) 上：

| 操作系统 (`os`) | 芯片架构 (`arch`) | 适用设备 | 平台包 |
| :--- | :--- | :--- | :--- |
| **`macos`** | **`arm64`** | Apple Silicon（M 系列全系 Mac） | `<id>-<version>-macos-arm64.cindy` |
| **`macos`** | **`amd64`** | Intel 处理器 Mac | `<id>-<version>-macos-amd64.cindy` |
| **`windows`** | **`amd64`** | Windows 64 位（Intel / AMD） | `<id>-<version>-windows-amd64.cindy` |
| **`windows`** | **`arm64`** | Windows on ARM（骁龙 X 系列等） | `<id>-<version>-windows-arm64.cindy` |
| **`linux`** | **`amd64`** | Linux x86 服务器 / 工作站 | `<id>-<version>-linux-amd64.cindy` |
| **`linux`** | **`arm64`** | Linux arm64 云主机 / 边缘设备 | `<id>-<version>-linux-arm64.cindy` |

> 早期曾按架构拆出 `plat/<os>-<arch>` 轻量分支，现已废弃：二进制全部回归 `main`，分支已删除。

---

## 如何发版（客户端才会出现「更新」按钮）

Cindy 的自定义 git 市场里，卡片是显示 **「更新到 vX.Y.Z」** 还是 **「替换」**，由「市场清单里的版本 ≠ 本地台账里的版本」且「已装包 `ghost.json` 指纹与台账一致」共同决定。因此每次发版**必须**同步四处版本，且**禁止手改已安装目录**：

1. `plugins/<id>/ghost.json` → `version`
2. `scripts/manifest.json` → `plugins.<id>.version`（必须与上面完全相等）
3. `.agents/plugins/marketplace.json` → `version`（**客户端真正读这份**，CI 构建后会自动提交）
4. `README.md` 本表格

完整判定逻辑、标准发版流程、「只看到替换」的 5 步排查，见 **[CONTRIBUTING.md §5.1 版本与「更新」按钮链路](CONTRIBUTING.md)**。

> 一句话记法：**只改仓库、不碰安装目录；清单不提交，就永远只有「替换」。**

---

## 当前已收录插件

| 插件 ID | 展示名称 | 指令前缀 | 上游仓库 | 架构覆盖 | 一句话说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`cube-cli`** | **Cube CLI** | `$cube` | [`otaku-say/cube-cli`](https://github.com/otaku-say/cube-cli) | 6 架构全覆盖 | CubeSandbox 控制面遥控器：创建沙箱、生命周期启停、端口探测与元数据管理 |
| **`aiod-cli`** | **Aiod CLI** | `$aiod` | [`otaku-say/aiod-cli`](https://github.com/otaku-say/aiod-cli) | 6 架构全覆盖 | 沙箱内部遥控器：命令与文件、PTY、代码解释器、浏览器、桌面 computer-use 与 MCP Server |
| **`my-env`** | **My Env** | `$env` | 本仓库（纯 JS，无上游二进制） | 全平台（纯 JS） | 全局环境变量中枢：本机 0600 存储、按项目注入、零明文落盘导出，超时杀进程树 |
| **`subagent-router`** | **Subagent Router** | `$router` | 本仓库（纯 JS，无上游二进制） | 全平台（纯 JS） | 给 Cindy 子代理配模型链：按分组挑选与拖动排序模型，失败自动换下一个；一键注入/卸载随包 Pi 扩展 |

---

## 核心架构与工程规范

### 1. 全平台全架构标准矩阵

所有包含原生工具链或二进制的插件，均覆盖 6 种标准系统与芯片架构：

| 平台标识 (`platform`) | 系统全称 (`os`) | 架构名称 (`arch`) | 上游编译 Target | 上游发布资产 | 本仓库产物 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `macos-arm64` | `macos` | `arm64` | `aarch64-macos` | `<tool>-macos-arm64` | `<id>-<version>-macos-arm64.cindy` |
| `macos-amd64` | `macos` | `amd64` | `x86_64-macos` | `<tool>-macos-amd64` | `<id>-<version>-macos-amd64.cindy` |
| `windows-amd64` | `windows` | `amd64` | `x86_64-windows-gnu` | `<tool>-windows-amd64.exe` | `<id>-<version>-windows-amd64.cindy` |
| `windows-arm64` | `windows` | `arm64` | `aarch64-windows-gnu` | `<tool>-windows-arm64.exe` | `<id>-<version>-windows-arm64.cindy` |
| `linux-amd64` | `linux` | `amd64` | `x86_64-linux-musl` | `<tool>-linux-amd64` | `<id>-<version>-linux-amd64.cindy` |
| `linux-arm64` | `linux` | `arm64` | `aarch64-linux-musl` | `<tool>-linux-arm64` | `<id>-<version>-linux-arm64.cindy` |

`zig` 的 `-Dtarget` 三元组只是编译器内部叫法；对外一律使用 `macos` / `windows` / `linux` 与 `arm64` / `amd64`。

---

### 2. 上游版本同步

带二进制的插件**不在这里手改代码**，二进制一律来自各自的上游独立仓库的 Release：

| 插件 | 上游仓库 | 跟随对象 | 上游校验 |
| :--- | :--- | :--- | :--- |
| `cube-cli` | [otaku-say/cube-cli](https://github.com/otaku-say/cube-cli) | CubeSandbox 控制面 Python SDK（`TencentCloud/CubeSandbox`） | `scripts/sdk-coverage.json` 的 `synced_version` |
| `aiod-cli` | [otaku-say/aiod-cli](https://github.com/otaku-say/aiod-cli) | 沙箱内 aiod 的 `/v2` API | `scripts/v2-coverage.json` 的 `spec.source` |

同步链路（CI 全自动，见 `.github/workflows/build-market.yml`）：

1. `build-market.py --fetch` 按 `scripts/manifest.json` 的 `upstream` 配置，从上游 `latest` Release 拉取 6 个平台资产；
2. 用上游 `SHA256SUMS` 逐个校验，**校验不通过直接失败**，不会把坏二进制发出去；
3. `embed-binaries.py` 把它们内嵌进 `plugins/<id>/bin/<os>-<arch>/`（`main` 分支自带全套架构）；
4. `build-market.py` 生成单平台 `.cindy` 包与 `.agents/plugins/marketplace.json`，随 Release 发布。

上游发版后，手动指定版本时需同时改 `plugins/<id>/ghost.json` 与 `scripts/manifest.json` 的 `version`（两者必须相等）并 push；否则交给 CI 的 `embed-binaries.py --bump` 自动递增。CI 会完成拉取、校验、内嵌、打包、发布。

---

### 3. 企业级凭证安全隔离模型

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

### 4. 长任务异步控制体系（三件套）

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
   - 由自动化工作流统一拉取上游发布资产、做 SHA256SUMS 强校验后生成单平台轻量包；二进制统一存放在 `main` 分支的 `plugins/<id>/bin/<os>-<arch>/`，不再使用架构专属分支。
3. **安全与幂等**：
   - 严格落实密钥安全隔离，所有操作与初始化流程必须具备幂等性（重复调用零副作用）。

详细入驻指南请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md)。
