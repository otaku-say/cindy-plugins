# Cube CLI（CubeSandbox 控制面）完整使用手册

`cube-cli` 是 **CubeSandbox 云端安全沙箱的控制面遥控器**：建/查/销毁沙箱、暂停恢复、模板画像与选择、快照回滚、持久卷，以及在沙箱内执行命令、读写文件（envd 数据面通道）。

- 上游仓库：[`otaku-say/cube-cli`](https://github.com/otaku-say/cube-cli)（命令手册 `docs/cube-cli.md`，命令表 `src/help.zig`）
- 版本号跟随 CubeSandbox Python SDK（`TencentCloud/CubeSandbox`）。
- 每个平台只带自己那一个**静态单文件**二进制；Windows 为原生单文件。
- 沙箱内的深度操作（PTY、浏览器、代码解释器、监听）交给 `aiod-cli`。

---

## 什么时候主动使用本插件？

1. **安全隔离执行**：要跑不受信任的脚本/命令，或本机缺依赖时，建沙箱跑完再销毁；
2. **沙箱全生命周期**：`cube_new` / `cube_ls` / `cube_rm`（高级操作走 `cube_run`：info、pause、resume、timeout、refresh、connect）；
3. **长时间任务**：镜像拉取、大构建不宜阻塞会话，用 `cube_submit` + `cube_log`；
4. **模板与画像**：`cube_run` 的 `tpl-ls` / `tpl-pick` / `tpl-caps` / `tpl-logs`；
5. **快照**：`cube_run` 的 `snap` / `rollback`（克隆请用快照 + `cube_new --template`，`clone` 被禁用）；
6. **持久卷**：`cube_run` 的 `vol-new` / `vol-ls` / `vol-info`；
7. **排障**：`cube_health`（连通性 + 版本）、`cube_run` 的 `logs`、`raw` 透传任何未封装的 API。

---

## 配置与准备

插件按 Cindy 凭证规范管理密钥（`node.secretBindings` → 主机 `safeStorage` → 仅在调用时注入子进程环境变量）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `CUBESANDBOX_API_URL` | 是 | 控制面地址 |
| `CUBESANDBOX_API_KEY` | 是 | 控制面 API Key（插件安装时要求配置，存于宿主 safeStorage，仅在调用时注入子进程环境） |
| `CUBESANDBOX_PROXY_URL` | exec / 文件 / ports 必填 | 数据面网关，拼沙箱访问 URL 用 |

仓库与插件内**不含任何凭据**；默认控制面/网关地址是公开的 `*.4a8a.com` 部署地址（见 `main.js`），可在设置页覆盖。

---

## 插件暴露的工具（优先用这些，别拼 `cube_run`）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `cube_new` | 建沙箱，**自动写入元数据**，返回 `sandboxId` / `gatewayUrl` / `aiodBase` | `purpose`、`agent`、`dialogue`、`need`、`timeoutSeconds` |
| `cube_ls` | 列沙箱（ID/模板/状态/备注） | `metadata?`（`dialogue=<ID>`）、`state?`、`limit?`、`v2?` |
| `cube_rm` | 销毁沙箱（不可恢复） | `sandboxId` |
| `cube_exec` | 沙箱内执行一条 shell 命令 | `sandboxId`、`command`、`cwd?`、`timeoutSeconds?` |
| `cube_code` | 沙箱内跑一段代码（python/js/bash） | `sandboxId`、`code`、`language?` |
| `cube_write_file` | 把字符串写成沙箱内文件（字节精确） | `sandboxId`、`path`、`content` |
| `cube_read_file` | 读沙箱内文件文本（默认上限 256 KiB） | `sandboxId`、`path`、`maxBytes?` |
| `cube_health` | 控制面健康 + CLI 版本（一次调用） | 无 |
| `cube_run` | 其余子命令兜底（info/ports/logs/pause/snap/tpl-*/raw…） | `cmd`、`args[]` |
| `cube_submit` | 异步派发控制面任务（含 `cmd=new`），立即返回 `taskId` | `cmd`、`args[]`；`cmd=new` 时用 `purpose`/`agent`/`dialogue`；完成后 `cube_log` 返回 `sandboxId`/`templateId` |
| `cube_log` | 取异步任务输出（按行偏移增量读） | `taskId`、`offset` |
| `cube_kill` | 终止异步任务 | `taskId` |

> `cube_exec` / `cube_code` 单次同步上限 **100 秒**（宿主单次调用 timeoutMs 上限 120 秒，留出余量；到点退出码 124）。更长的构建/安装请用 `cube_submit` + `cube_log`，并每 60-90 秒轮询一次（worker 空闲 120 秒会被回收）。

---

## 【沙箱创建铁律】必须填写三项元数据

创建沙箱**只能**走 `cube_new`（`cube_run cmd=new` 会被拒绝；异步用 `cube_submit cmd=new`），三项必填、缺一即报错：

| 参数 | 填写内容 | 落到平台元数据 |
|---|---|---|
| `purpose` | **一句简短中文用途**（≤60 字），如「修复 my-env 转义 bug 并跑单测」；不要写 Agent 名或会话 ID | `metadata.note`（列表「备注」列）与 `metadata.task` |
| `agent` | 当前平台 Agent 身份（主/子），如 `Cindy(主)`、`worker-2(子)` | `metadata.agent` |
| `dialogue` | 当前对话 ID（会话 ID） | `metadata.dialogue`（独立键），并随创建请求发送 `X-Caller: <ID>` 头 |

> 为什么不是 `cube-cli new`？上游 0.7.3 的 `new` 只写 `agent/note/task/cli` 四个键，没有 dialogue 参数；
> 而控制面在创建时**接受并保留任意 metadata 键**（实测 `dialogue` 原样落库），也没有更新元数据的接口。
> 因此插件先用 `tpl-pick`/`tpl-resolve` 解析模板、`tpl-info` 取网关端口，再用 `raw POST /sandboxes` 带完整元数据创建。

示例：

```json
{ "purpose": "修复 my-env 转义 bug 并跑单测", "agent": "Cindy(主)", "dialogue": "bb5c7920-31b6-4ba7-9cf5-96bb2a29d4b1", "need": "code", "timeoutSeconds": 1800 }
```

单次 `cube_new` 的模板解析 + 创建共享 **110 秒**预算（宿主单次调用上限 120 秒）。**若超时报错，沙箱可能已经建好**：先用 `cube_ls { "metadata": "dialogue=<对话ID>" }` 核对，再决定 `cube_rm` 还是重试，避免重复拉起。

返回样例：

```json
{ "sandboxId": "cd1e093c8f1f403a9b829d3c995103c2",
  "templateId": "tpl-f8457cc2a17f0907c92d17fe",
  "gatewayUrl": "/sandbox/cd1e093c8f1f403a9b829d3c995103c2/8080/",
  "aiodBase": "https://cubesandbox-proxy.4a8a.com/sandbox/cd1e093c8f1f403a9b829d3c995103c2/8080/",
  "metadata": { "agent": "Cindy(主)", "note": "修复 my-env 转义 bug 并跑单测", "task": "修复 my-env 转义 bug 并跑单测", "dialogue": "bb5c7920-31b6-4ba7-9cf5-96bb2a29d4b1" } }
```

`aiodBase` 就是 `aiod-cli` 的 `SANDBOX_BASE`。

**按会话查沙箱**：`cube_ls { "metadata": "dialogue=<对话ID>" }`（等价 `cube_run` 的 `ls --metadata=...`；v1 服务端最多返回 200 条），或 `cube_run info <sid>` 看归属块（`dialogue` 是独立 metadata 键）。

**用完即毁**：任务结束（含失败）立即 `cube_rm`，不要留悬挂沙箱。

---

## 常用调用速查

```json
{ "purpose": "验证构建脚本", "agent": "Cindy(主)", "dialogue": "<当前对话ID>", "need": "code" }
{ "sandboxId": "<sid>", "command": "uname -a && lscpu" }
{ "sandboxId": "<sid>", "command": "cd /root/app && npm test", "cwd": "/root/app", "timeoutSeconds": 100 }
{ "sandboxId": "<sid>", "code": "print(1+1)", "language": "python" }
{ "sandboxId": "<sid>", "path": "/root/app/main.py", "content": "print('hello')\n" }
{ "sandboxId": "<sid>", "path": "/root/app/out.log" }
{ "sandboxId": "<sid>" }
{ "cmd": "ports", "args": ["<sid>"] }
{ "cmd": "info", "args": ["<sid>"] }
{ "cmd": "logs", "args": ["<sid>", "--tail=200"] }
{ "cmd": "pause", "args": ["<sid>"] }
{ "cmd": "raw", "args": ["GET", "/health"] }
```

异步建沙箱（模板预热慢时）：

```json
{ "cmd": "new", "purpose": "构建大镜像", "agent": "Cindy(主)", "dialogue": "<当前对话ID>", "need": "code" }
```

然后每 60-90 秒 `cube_log` 一次（避免 worker 空闲回收），日志里会出现 `sandboxID`。超时可 `cube_ls metadata=dialogue=<ID>` 核对是否已创建。

---

## 剩余子命令速查（走 `cube_run`，按 `cube-cli help all` 分组）

**生命周期**
```json
{ "cmd": "resume",  "args": ["<sid>"] }
{ "cmd": "connect", "args": ["<sid>"] }
{ "cmd": "timeout", "args": ["<sid>", "3600"] }              # 空闲回收超时（秒）
{ "cmd": "refresh", "args": ["<sid>", "600"] }               # 续期
{ "cmd": "net",     "args": ["<sid>", "--no-internet"] }
```

**快照 / 卷 / 克隆**
```json
{ "cmd": "snap",     "args": ["<sid>", "--name=before-refactor"] }
{ "cmd": "snap-ls",  "args": ["--sandbox=<sid>"] }
{ "cmd": "rollback", "args": ["<sid>", "<snapshotID>"] }
{ "cmd": "vol-new",  "args": ["data"] }
{ "cmd": "vol-ls",   "args": [] }
```

**模板**
```json
{ "cmd": "tpl-ls",   "args": [] }
{ "cmd": "tpl-pick", "args": ["--need=browser"] }
{ "cmd": "tpl-caps", "args": ["<templateID>"] }
{ "cmd": "tpl-logs", "args": ["<templateID>", "<buildID>"] }
```

**文件 / 目录（简单读写用 cube_read_file / cube_write_file）**
```json
{ "cmd": "ls-file", "args": ["<sid>", "/root"] }
{ "cmd": "stat",    "args": ["<sid>", "/root/app"] }
{ "cmd": "mkdir",   "args": ["<sid>", "/root/app/tmp"] }
{ "cmd": "mv",      "args": ["<sid>", "/root/a", "/root/b"] }
{ "cmd": "rm-file", "args": ["<sid>", "/root/a"] }
{ "cmd": "exists",  "args": ["<sid>", "/root/a"] }
```

**异步进程 / PTY / 诊断**
```json
{ "cmd": "exec-async", "args": ["<sid>", "make -j4"] }
{ "cmd": "exec-logs",  "args": ["<sid>", "<pid>", "--offset=0"] }
{ "cmd": "exec-kill",  "args": ["<sid>", "<pid>"] }
{ "cmd": "exec-stdin", "args": ["<sid>", "<pid>", "y"] }
{ "cmd": "pty-open",   "args": ["<sid>", "--cols=120", "--rows=36"] }
{ "cmd": "pty-write",  "args": ["<sid>", "<pid>", "ls\n"] }
{ "cmd": "pty-read",   "args": ["<sid>", "<pid>", "--offset=0"] }
{ "cmd": "pty-close",  "args": ["<sid>", "<pid>"] }
```

> `mcp-server` 是交互式 stdio 服务，插件不是常驻进程，无法通过 `cube_run` 使用；需要 MCP 请在沙箱内直接运行 `aiod-cli`。

---

## 沙箱写代码与脚本执行正确姿势（避免转义陷阱）

1. **执行代码片段：用 `cube_code`**（零转义干扰，支持 python / js / bash；同步上限 100 秒）
   - 代码作为 JSON 数据载荷直达沙箱执行内核，不经过外层 Shell 解释；多行缩进、嵌套引号、反斜杠、`$VAR`、Emoji 全部原样保留。
2. **写代码文件：用 `cube_write_file`**（100% 字节无损；单次 ≤8 MiB，超过请分片）
   - 不要用 `echo "..." > app.py`，也不要在 `exec` 里裸 `cat << EOF`（Bash 会提前展开 `$VAR`、反引号与反斜杠）。
3. 非要用 heredoc 时必须写 `cat << 'EOF'`（EOF 加单引号，保持 raw 文本流）。

---

## 退出码约定（与上游一致）

| 情况 | 退出码 |
|---|---|
| 远端命令成功 | `0` |
| 远端命令失败 | 真实退出码（1–255） |
| `--timeout` 到点未结束（`deadline_exceeded`） | `124`（同 `timeout(1)`） |
| `exit_code<0`（被信号杀死） | `1` |
| 参数/配置/传输错误 | 非 0，`stderr` 给可读原因 |

`（exit N）` 提示走 **stderr**，不污染 `OUT=$(cube-cli exec …)` 这类管道。

---

## 常见错误与恢复

- **`purpose 必须使用中文填写` / `agent 必填` / `dialogue 必填`**：`cube_new` 的元数据铁律，补齐后再建。
- **`创建沙箱请用 cube_new`**：`cube_run cmd=new` 已禁用，改用 `cube_new`（异步用 `cube_submit cmd=new`）。
- **`HTTP 401/403`**：Key 不对或未注入。确认插件设置页的 CubeSandbox API Key 已保存且非空。
- **`没有可用的 READY 模板：...`**：先 `tpl-ls` 看现有模板，或 `tpl-pick --need=...`。
- **`sandbox not found`**：实例已被回收（`timeout` 到点）。用 `cube_ls` 确认，必要时重建。
- **命令超时 / `exitCode 124`**：同步 `cube_exec`/`cube_code` 最长 100 秒，长任务改走 `cube_submit` + `cube_log`。
- **创建超时/无响应**：沙箱可能已创建，`cube_ls metadata=dialogue=<ID>` 找回后 `cube_rm`；不要盲目重试导致重复沙箱。
- **`--env=NAME` 被拒**：插件禁止裸 `--env=NAME`（会从宿主环境读变量，可能把 API Key 送进沙箱），请用 `env` 参数或 `--env=NAME=VALUE`。
- **`cube_read_file` 返回 `truncated: true`**：文件超过读取上限，调大 `maxBytes`（最大 1 MiB）；更大的文件请用 `cube_run` 的 `get`（下载到插件沙箱）或分段读取。
- **`cube_write_file` 报 content 过大**：上限 8 MiB，请分片多次调用 `cube_write_file` 追加写入。
