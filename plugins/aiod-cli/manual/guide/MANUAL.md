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
| `aiod_exec` | **首选**执行一条命令 | `command`、`cwd`、`env`、`shell`、`timeoutSec`、`maxOutputBytes` |
| `aiod_run` | 通用兜底：任意子命令 | `cmd`、`args[]`、`maxOutputBytes`、`base` |
| `aiod_write_file` | **首选**写文本文件（自动分片 + 校验） | `path`、`content`、`append` |
| `aiod_read_file` | **首选**按行分页读文件 | `path`、`startLine`、`maxLines`、`maxBytes` |
| `aiod_edit_file` | 原位替换 / 按行插入 | `path`、`old`、`new`、`mode`、`insertLine`、`text` |
| `aiod_upload` | 本机文件上传（双端 SHA256） | `localPath`、`remotePath`、`overwrite` |
| `aiod_download` | 沙箱文件下载到本机（本机同名文件会先被删除） | `remotePath`、`localPath` |
| `aiod_submit` | 在沙箱后台真异步执行（服务端缓冲输出，commandId 可跨 worker 复用） | `command`、`cwd`、`env`、`timeoutSec`、`base` |
| `aiod_log` | 按 commandId 增量读输出（续读 / tail / wait） | `taskId`、`offset`、`tail`、`wait` |
| `aiod_kill` | 真正终止沙箱后台命令（`aiod-cli kill`） | `taskId` |
| `aiod_write_stream` | 原子式大文件写入（本地缓存，final 时一次性 put） | `path`、`content`、`begin`、`uploadId`、`final` |
| `aiod_stat` | 路径元信息（存在/目录/大小/行数/行尾/哈希一次拿全） | `path` |

> 同步调用单次最长 15 分钟且「有输出即续期」。真正的长任务（大构建、镜像拉取）请走 `aiod_submit` + `aiod_log`，不要阻塞会话。
>
> `aiod_submit` 现在走沙箱侧真异步（`aiod-cli async`）：输出由沙箱服务端缓冲，`commandId` 写在本机临时映射文件里，**插件 Node worker 空闲回收后仍能继续 `aiod_log` / `aiod_kill`**；`aiod_kill` 会真的终止沙箱里的命令。
>
> `aiod_run` 是兜底口：日常执行用 `aiod_exec`，读写文件用 `aiod_write_file` / `aiod_read_file` / `aiod_edit_file`，本地往返用 `aiod_upload` / `aiod_download`。

### 硬数字（越界必然出错，先看这张表）

| 限制 | 数值 | 越界表现 |
|---|---|---|
| 命令行 argv 总长（Windows） | 32767 字符 | 直接报「命令行参数过长」，不会再悄悄截断 |
| `aiod_exec` 输出上限 | `maxOutputBytes`，缺省 262144 字节（可调至 819200 = 800KB） | 上游保留头尾、丢掉中段，在 stderr 打 truncated warning，并置 `stdoutTruncated=true` |
| `aiod_write_file` 单次 content | 200000 字节 | 报错并提示分段追加（`append:true`） |
| `aiod_read_file` 单页 | 行模式 2000 行；两种模式单页最多 200000 字节 | `hasMore=true` + `nextStartLine` / `nextByteStart` |
| 异步任务日志 | 沙箱服务端完整保留 | `droppedLines` 恒为 0；`gap:true` 表示服务端已丢弃一段 |
| `write` 命令单文件 | 8 MiB（stdin 4 MiB） | 报错，改用 `aiod_upload` |
| `put` 分块阈值 | >32 MiB 自动 8 MiB/段 | 无感 |

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
以 stdio MCP Server 运行，工具族包括 `exec_*` / `file_*` / `pty_*` / `browser_*` / `desktop_*` / `code_*` / `watch_*` / `mcp_hub`；具体数量与清单以 `tools/list` 为准，不要按固定数字做判断。

---

## 沙箱写代码与脚本执行正确姿势（避免截断与转义陷阱）

长内容**永远不要内联进 argv**（`exec` / `code` / `write` 的参数）。Windows 命令行上限 32767 字符，越界会直接失败；就算没越界，模型一次性生成的超长 tool 参数本身也可能被截断。走文件通道才是稳的：

**1. 写文件 → `aiod_write_file`（首选）**
```json
{ "path": "/root/repo/app.py", "content": "<完整文件内容>" }
```
- 内容经 JSON payload 进入沙箱，零 shell 解释、零转义；内部按 48KB 自动分片，写完校验总字节数，覆盖写还比对 SHA256。
- 单次 ≤200000 字节。更大的文件用 `aiod_write_stream`：首段 `{path, content, begin:true}` 拿 `uploadId`，中间段 `{uploadId, content}`，最后 `{uploadId, content, final:true}`；内容先缓存在插件本地，final 时一次性 put，**沙箱里不会出现半截文件**。
- 手动用 `append:true` 分段也可以，但中途失败会留下半截文件；而 `write_stream` 的 `uploadId` 只活在工作进程内存里（worker 空闲 120 秒回收后会话和本地缓存一起丢失，必须重新 begin）。
- `path` 必须是绝对路径（以 `/` 开头），相对路径会被拒绝；父目录不存在会自动创建。
- `content` 传空字符串 = 创建/清空为空文件（`.` `__init__.py`、`.gitkeep` 这类占位文件不用再找别的工具）。
- 返回 `verified:true` 才算写成功；`sha256Match:false` 或抛错时不要继续编译/运行。覆盖了一个非空文件时会回 `overwrote:true` + `previousBytes`，可用来确认没误删内容。

**2. 本机已有文件 → `aiod_upload`（二进制安全）**
```json
{ "localPath": "D:/work/app.tar.gz", "remotePath": "/root/app.tar.gz" }
```
- 大文件自动 8 MiB 分块，返回双端 SHA256（`verified:true` 才可信）。缺省覆盖同名目标，`overwrite:false` 可拒绝覆盖。

**3. 改已有文件 → `aiod_edit_file`（不重传整文件）**
```json
{ "path": "/root/app.py", "old": "def main():", "new": "def entry():", "mode": "first" }
```
- 替换范围用 `mode` 表达：**缺省 `first`（只改第一处，防误伤全文）**，需要全改显式传 `all`，或 `last`。
- `old` 不存在时报错会提示你取更长、更唯一的片段；行号越界/负数、插入缺 `text` 会在插件侧先拦下。
- 按行插入：`{ "path": "...", "insertLine": 0, "text": "import os" }`（`insertLine` 必须 ≥ 0，0 表示插在首行前）。

**4. 读回 → `aiod_read_file`（必须分页）**

参数：`startLine`（0 基）/ `startByte`（超长单行，优先于 startLine 与 tail）/ `tail`（末尾 N 行）/ `allowPartial`（长行前缀+偏移）/ `exact`（强制整文件读+本地切片，≤6MB）。
```json
{ "path": "/root/build.log", "startLine": 0, "maxLines": 200 }
```
- **不要用 `cat` 读可能很大的文件**：`cat` 的输出仍受 256KB 采集上限影响，越界会截断。
- 行模式返回 `nextStartLine` / `hasMore` / `totalLines` / `totalBytes`；**逐页拼接与原文逐字节一致**（含文件末尾换行），可以直接拼回或校验 SHA256。
- **混合行尾**的文件（部分 CRLF、部分 LF）插件会自动切换 `cat --exact`（整文件读+本地切片）保证逐字节精确；也可用 `exact:true` 强制（文件需 ≤6MB，每页成本为整文件大小；超过 6MB 时会直接报错）。
- **超长单行**（minified js、单行 JSON、一行几十万字的日志）：行模式会直接报错并指路，改用字节模式：
  ```json
  { "path": "/root/min.js", "startByte": 0, "maxBytes": 200000 }
  ```
  返回 `nextByteStart`，`hasMore=false` 才是真读完。
- 只想知道大小/行数/行尾/校验值：直接用 `aiod_stat`（一次拿全，缺文件返回 exists:false）；按内容找位置用 `aiod_run { "cmd": "grep" }`。

**5. 必须用 shell 生成文件时的底线**
- 禁止裸 `cat << EOF`：`$VAR`、反引号、反斜杠会被 Bash 提前求值。
- 只用 `cat << 'EOF' >> app.py`（`EOF` 加单引号），单片 <8KB，追加必须 `>>`，不要用 `>`。

**6. 执行代码片段 → `aiod_run { "cmd": "code" }`**
- `{ "cmd": "code", "args": ["<代码>", "--lang=python"] }` 走解释器 JSON payload，不经 shell，多行/引号/反斜杠/Emoji 原样保留。
- 代码长度同样受 argv 32767 限制，超了就先 `aiod_write_file` 落盘再 `aiod_exec` 运行。

**7. 输出很大时（构建日志、`pip list`、大 JSON）**
- `aiod_exec` 的输出上限是 `maxOutputBytes`（缺省 256KB，同时下发给上游 `--max-output`，插件侧封顶 819200 字节）；超过时上游会**保留头尾、丢掉中段**，在 stderr 打 `aiod-cli: warning: output truncated original_bytes=... returned_bytes=...`，插件同时置 `stdoutTruncated=true`——看到这个标志就不要再当完整结果用。
- 子进程 stderr 由上游 CLI 原样写到 stderr（`stderrMerged:false`），两路真正分离；`separateStderr` 已退化为兼容参数（传了也不会多包一层）。
- 要完整输出：让命令自己写文件 `cmd > /root/out.log 2>&1`，再用 `aiod_read_file` 分页读；或把 `maxOutputBytes` 调到需要的字节数（上限 819200 字节；stdout+stderr 合计超过约 900KB 会整包换成错误，此时请重定向到文件）。
- `stdout` 原样返回，不裁剪尾随空白；需要干净文本请自己做 `trim`。

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

- **`沙箱网关无效（SANDBOX_BASE=…）`**：插件层的前置校验，说明当前没有可用的网关。先用 cube-cli 的 `cube_health` / `cube_run {cmd:"new"}` 建沙箱，把打印的 `AIO 网关` 地址填进设置页，或在每次调用里传 `base` 参数（推荐，多沙箱并存时不会串）。
- **`Connection Refused` / `HTTP 404`**：沙箱可能已暂停或已销毁。先用 `aiod_health` 或 `aiod_exec { command: "ls /root" }` 确认实例还在；若要看沙箱生命周期，用 cube-cli 插件的 `cube_health`。
- **`HTTP 401`**：部署启用了鉴权但 `SANDBOX_KEY` 没配（或为空）。注意空字符串等于未设置。
- **`HTTP 409 destination already exists`**：只有 `put` 会冲突（不加 `--overwrite`）。用 `aiod_upload`（缺省覆盖）或 `aiod_upload { overwrite:false }` 明确拒绝。`aiod_write_file` 本身就是覆盖语义，不会 409。
- **`命令行参数过长` / `ENAMETOOLONG`**：内容被塞进了 argv。改用 `aiod_write_file`（文本）或 `aiod_upload`（本机文件）；命令本身超过 32000 字符也要拆成「先落盘再执行」。
- **`写入校验失败` / `sha256Match:false`**：写入过程不完整。重跑同一次写入（`aiod_write_file` 幂等覆盖）后再校验，不要拿残缺文件去编译。
- **`gap:true`**：沙箱侧已丢弃过一段输出（服务端上限）。让命令自己 `> /root/build.log 2>&1`，再用 `aiod_read_file` 分页读。
- **`exitCode 124`**：命令超时被强杀。改用 `aiod_submit` 异步跑，或调大 `aiod_exec` 的 `timeoutSec`（对应上游 `--hard-timeout=<秒>`）。
- **`pty-ws` 握手失败**：`wss://` 只校验证书主机名、**不验证 CA 证书链**（自签也能连），不可信网络下请改用 `ws://` 隧道或在受信网络内使用。
