# Aiod CLI（沙箱内部系统能力）完整使用手册

`aiod-cli` 是深入 **CubeSandbox 云端沙箱容器内部**的遥控器：通过沙箱内 aiod 的 **v2 REST / WebSocket API** 操作文件系统、进程、PTY、代码解释器、浏览器、文件监听与 MCP Hub。

- 上游仓库：[`otaku-say/aiod-cli`](https://github.com/otaku-say/aiod-cli)（命令手册 `docs/aiod-cli.md`，命令表 `src/help.zig`）
- 每个平台只带自己那一个**静态单文件**二进制（无运行时依赖）；Windows 也是原生单文件，不是包装脚本。
- 建沙箱、模板、快照、卷是另一个工具 `cube-cli`。

---

## 什么时候主动使用本插件？

1. **在沙箱内执行命令**：构建、跑测试、装包——尤其是本地缺依赖或不想污染本机的场景；
2. **沙箱内文件操作**：读写、上传下载、批量拷贝、按正则搜内容、整棵目录树打包传输；
3. **交互式终端**：需要常驻 shell、改窗口大小、发信号，或要 WebSocket 附着一个 PTY 会话；
4. **代码解释器**：用带状态的 Python/JS 内核跑片段（变量跨次保留）；
5. **无头浏览器**：导航、截图、执行 JS、点填、抓可访问性快照与网络请求（需浏览器镜像）；
6. **桌面 computer-use**：截图、鼠标键盘、无障碍树（需 computer 镜像）；
7. **文件监听**：等某目录出现变更，或长轮询/SSE 收事件；
8. **把沙箱内能力包成 MCP**：以 stdio MCP Server 形式接入上层协议。

---

## 配置与准备

| 变量 | 必填 | 说明 |
|---|---|---|
| `SANDBOX_BASE` | 是（`help` 除外） | aiod 网关地址。`cube-cli new` 打印的 `[sandbox] AIO 网关:` 那行就是它 |
| `SANDBOX_KEY` | 否 | 鉴权 Key。非空时以 `X-API-KEY` 头发送 |

`SANDBOX_BASE` 两种写法（末尾 `/` 可有可无）：

```bash
export SANDBOX_BASE="https://<网关>/sandbox/<sandboxID>/8080"   # 从本机/任意地方遥控
export SANDBOX_BASE="http://127.0.0.1:8080"                     # 在沙箱内部自测
```

插件侧：设置页或 `/kv` 保存的是默认值，单次调用可用工具的 `base` 参数覆盖（**不会**改动已保存的值）。

---

## 插件暴露的工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `aiod_version` | 版本 + 本机平台 | 无 |
| `aiod_health` | 网关健康检查与 aiod 版本 | `base` |
| `aiod_run` | 同步执行任意子命令，返回 `{stdout, stderr, exitCode}` | `cmd`、`args[]`、`base` |
| `aiod_submit` | 异步派发长任务，立即返回 `taskId` | `cmd`、`args[]`、`base` |
| `aiod_log` | 取异步任务输出（可按行偏移增量读） | `taskId`、`offset` |
| `aiod_kill` | 终止异步任务 | `taskId` |

> `aiod_run` 单次最长 15 分钟且「有输出即续期」。真正的长任务（大构建、镜像拉取）请走 `aiod_submit` + `aiod_log`，不要阻塞会话。

---

## 常用命令速查（按 `aiod-cli help all` 分组）

**执行**
```json
{ "cmd": "exec",   "args": ["python3 -c 'import sys; print(sys.version)'", "--cwd=/root"] }
{ "cmd": "async",  "args": ["npm ci && npm run build"] }
{ "cmd": "log",    "args": ["<command_id>", "--follow"] }
{ "cmd": "kill",   "args": ["<command_id>"] }
{ "cmd": "stdin",  "args": ["<command_id>", "y"] }
{ "cmd": "sess-new", "args": ["build", "--cwd=/root/repo"] }
{ "cmd": "sess",   "args": ["build", "make -j4"] }
```

**文件**
```json
{ "cmd": "cat",  "args": ["/root/app.log"] }
{ "cmd": "put",  "args": ["./a.md", "/root/a.md"] }
{ "cmd": "get",  "args": ["/root/out.tar", "./out.tar"] }
{ "cmd": "fs-tree-put", "args": ["./repo.tar.gz", "/root/repo"] }
{ "cmd": "ls",   "args": ["/root", "--recursive"] }
{ "cmd": "grep", "args": ["/root/src", "TODO", "--include=*.zig"] }
{ "cmd": "edit", "args": ["/root/a.txt", "--old=v1", "--new=v2"] }
{ "cmd": "rm",   "args": ["/root/tmp", "--recursive"] }
```
`put` 大文件自动分块（8 MiB/段，沙箱内拼接）；上传用独立暂存名，**不会动你的源文件**。

**终端 PTY / WebSocket**
```json
{ "cmd": "pty-new",  "args": ["t1", "--cwd=/root"] }
{ "cmd": "pty",      "args": ["t1", "vim app.py"] }
{ "cmd": "pty-screen", "args": ["t1"] }
{ "cmd": "pty-input","args": ["t1", ":wq", "--enter"] }
{ "cmd": "pty-ws",   "args": ["t1", "--send=echo hi", "--max=6"] }
{ "cmd": "pty-ws-anon", "args": ["--max=6"] }
```
`SANDBOX_BASE` 是 `https://` 时自动走 `wss://`。

**代码 / 浏览器 / 监听**
```json
{ "cmd": "code",     "args": ["print(1+1)", "--lang=python"] }
{ "cmd": "br-go",    "args": ["https://example.com"] }
{ "cmd": "br-shot",  "args": ["page.png", "--full"] }
{ "cmd": "br-eval",  "args": ["document.title"] }
{ "cmd": "br-tabs",  "args": [] }
{ "cmd": "watch",    "args": ["/root/repo", "--recursive"] }
{ "cmd": "watch-poll", "args": ["<watch_id>"] }
```

**MCP**
```json
{ "cmd": "mcp-server", "args": [] }
```
以 stdio MCP Server 运行，暴露 65 个工具（`exec_*` / `file_*` / `pty_*` / `browser_*` / `desktop_*` / `code_*` / `watch_*` / `mcp_hub`）。完整清单以 `tools/list` 为准。

---

## 沙箱写代码与脚本执行正确姿势（避免转义陷阱）

`aiod-cli` 经网关直接对接沙箱 REST API，全流程支持代码与文件的**无损传递**（实测无转义 Bug）。但不同操作形态有其各自的转义边界，推荐以下最佳实践：

1. **执行代码片段：首选 `code` 命令（零转义干扰）**
   - 推荐：`{ "cmd": "code", "args": ["<code>", "--lang=python"] }`（支持 `python` / `js` / `bash`）
   - **原理**：代码作为 JSON payload 直接送入沙箱内核解释器，**不经过宿主或远端 Shell 解释**。
   - 无论是多行代码、缩进、嵌套单双引号 `\"` / `\'`、连续反斜杠 `\\\\`、正则原始字符串 `r"..."`，还是 `$VAR`、反引号、Emoji，均会 100% 原样保留执行。

2. **写代码文件到沙箱：首选 `put` 本地直传（100% 字节无损）**
   - 推荐：本地生成/编辑文件后，调用 `{ "cmd": "put", "args": ["./app.py", "/root/app.py", "--overwrite"] }`
   - **实测保证**：两端 SHA256 完全一致，大文件自动分块拼接，没有任何编码、换行转换或转义失真。

3. **修改沙箱已有代码：首选 `edit` 精确替换**
   - 推荐：`{ "cmd": "edit", "args": ["/root/app.py", "--old=...", "--new=..."] }`
   - **实测保证**：支持包含 `=`、换行、双引号的多行代码块原子替换，避免重新上传整文件。

4. **在终端 / `exec` 中生成文件：严禁使用裸 `cat << EOF`，必须加单引号 `cat << 'EOF'`**
   - ❌ **错误做法**：`cat << EOF > app.py` 或 `echo "..." > app.py`
     - Linux Bash 会在写入文件前**提前求值展开** `$VAR`、反引号 `` `cmd` `` 与 `\` 转义字符，导致代码中的变量被清空、模板字符串损坏、反斜杠被吃掉（常被误以为是 CLI 转义 bug）。
   - ✅ **正确做法**：始终使用 **`cat << 'EOF' > app.py`**（`EOF` 加上单引号），告知 Bash 保持纯粹的原始文本流（raw heredoc），不对内联变量和反斜杠做任何求值。

---

## 退出码约定（与上游一致）

沙箱内命令的退出码通过 `{stdout, stderr, exitCode}` 原样回给 Agent：

| 情况 | `exitCode` |
|---|---|
| 命令成功 | `0` |
| 命令失败 | 真实退出码（1–255） |
| 硬超时（`status=timed_out`） | `124`（同 `timeout(1)`） |
| 被信号杀死（`exit_code<0`） | `1` |
| 网关/参数/配置错误 | 非 0，且 `stderr` 给出可读原因 |

判断成败请看 `exitCode`，不要靠输出文本猜。

---

## 常见错误与恢复

- **`缺少环境变量 SANDBOX_BASE`**：还没配网关。先用 `cube-cli new` 建沙箱，把打印的 `AIO 网关` 地址填进设置页或用 `base` 参数传入。
- **`Connection Refused` / `HTTP 404`**：沙箱可能已暂停或已销毁。先 `cube_health` / `cube_run { cmd: "ls" }` 确认实例还在。
- **`HTTP 401`**：部署启用了鉴权但 `SANDBOX_KEY` 没配（或为空）。注意空字符串等于未设置。
- **`HTTP 409 destination already exists`**：`put`/`write` 目标已存在，需要覆盖就加 `--overwrite`。
- **`exitCode 124`**：命令超时被强杀。改用 `aiod_submit` 异步跑，或调大 `--hard-timeout`。
- **`pty-ws` 握手失败**：`wss://` 只校验证书主机名、**不验证 CA 证书链**（自签也能连），不可信网络下请改用 `ws://` 隧道或在受信网络内使用。
