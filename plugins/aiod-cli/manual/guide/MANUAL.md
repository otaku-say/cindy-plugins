# Aiod CLI（沙箱内部系统能力）完整使用手册

`aiod-cli` 是深入 **CubeSandbox 云端沙箱容器内部的底层控制遥控器**。它通过 aiod v2 REST/WebSocket API 与容器内部守护进程通信，提供对沙箱内文件系统、多进程管道、无头浏览器与 MCP Server 的深度操作。

---

## 什么时候主动使用本插件？

当遇到以下任意场景时，Agent 应主动调用 `aiod-cli`：
1. **沙箱内文件系统深度管理**：
   - 需要在沙箱内部读取、写入、删除大文件（`cat`, `write`, `rm`）；
   - 需要向沙箱上传本地项目、或将沙箱内的计算成果打包下载（`upload`, `download`）；
2. **沙箱内无头浏览器遥控**：
   - 沙箱内预装了 Chromium 运行时，需要自动化打开网页、提取 DOM、抓取截图或执行页面爬虫时（`browser` 子命令族）；
3. **沙箱内进程守护与交互终端**：
   - 需要在沙箱内启动后台守护服务，或者通过 PTY 原语进行实时交互式终端调试；
4. **启动沙箱内 MCP Server**：
   - 需要把沙箱内运行的工具包装为 stdio MCP 供上层协议调用（`mcp-server` 模式）。

---

## 配置与准备（网关与鉴权）

- **`SANDBOX_BASE`**：沙箱内部 aiod 服务网关地址（例如通过 `cube new` 输出的 `https://<proxy>/sandbox/<sid>/8080`，可保存在设置页 `/kv`，也可在每次工具调用中通过 `base` 参数覆盖）；
- **`SANDBOX_KEY`**：沙箱鉴权 Key（可选，若容器配置了安全访问 Token，保存在 safeStorage 中）。

---

## 核心工具与调用指引

本插件在 Cindy 中向 Agent 暴露以下标准化工具：

### 1. `aiod_health`
检查目标沙箱网关的连接健康状态与 aiod 版本。
- **参数**：
  - `base` (string, 可选)：指定特定沙箱的网关地址，缺省使用设置页默认值。

### 2. `aiod_version`
返回当前 CLI 的版本号与编译目标架构（如 `aarch64-macos`）。
- **参数**：无

### 3. `aiod_run`
同步执行 aiod-cli 容器操作命令。
- **参数**：
  - `cmd` (string, 必填)：要执行的子命令名称；
  - `args` (array of string, 可选)：参数列表；
  - `base` (string, 可选)：指定沙箱实例网关。

#### 常用命令速查：
- **容器内执行命令**：
  ```json
  { "cmd": "exec", "args": ["python3", "-c", "import sys; print(sys.version)"] }
  ```
- **读取容器内文件**：
  ```json
  { "cmd": "cat", "args": ["/workspace/output.txt"] }
  ```
- **向容器内写入文件**：
  ```json
  { "cmd": "write", "args": ["/workspace/script.py", "print('hello world')"] }
  ```
- **列出容器内指定目录**：
  ```json
  { "cmd": "ls", "args": ["/workspace"] }
  ```
- **遥控浏览器截图**：
  ```json
  { "cmd": "browser", "args": ["screenshot", "--url=https://example.com", "--out=/workspace/page.png"] }
  ```

### 4. 异步长任务三件套（`aiod_submit` / `aiod_log` / `aiod_kill`）
- `aiod_submit({ cmd: "exec", args: ["npm", "run", "build"] })` 启动长时间编译任务；
- `aiod_log({ taskId: "..." })` 实时跟进控制台日志；
- `aiod_kill({ taskId: "..." })` 中止失控或死循环进程。

---

## 常见错误与恢复策略

- `缺少环境变量 SANDBOX_BASE`：说明尚未配置沙箱网关地址。请先通过 `cube-cli new` 获取新建沙箱的网关地址，并在 `aiod_run` 的 `base` 参数中传入，或在设置页保存；
- `Connection Refused`：说明沙箱可能已被暂停（paused）或正在启动中。请先通过 `cube_run` 确认沙箱处于运行状态。
