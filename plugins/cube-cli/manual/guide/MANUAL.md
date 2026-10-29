# Cube CLI（CubeSandbox 控制面）使用手册

`cube-cli` 是 **CubeSandbox 云端沙箱的控制面遥控器**：建/查/销毁沙箱、暂停恢复、模板选择、快照回滚、持久卷，以及在沙箱内执行命令、读写文件。

- 上游仓库：[`otaku-say/cube-cli`](https://github.com/otaku-say/cube-cli)（命令手册 `docs/cube-cli.md`，命令表 `src/help.zig`）
- 沙箱内的 PTY、浏览器、桌面、MCP 等深度操作交给 `aiod-cli`。

---

## 什么时候用

1. **隔离执行**：跑不受信任的脚本/命令，或本机缺依赖时，建沙箱跑完即毁；
2. **沙箱生命周期**：`cube_new` / `cube_ls` / `cube_rm`，高级操作走 `cube_run`（info、pause、resume、timeout、refresh）；
3. **长任务**：镜像拉取、大构建用 `cube_submit` + `cube_log`，不阻塞会话；
4. **模板/快照/卷**：`cube_run` 的 `tpl-*` / `snap` / `rollback` / `vol-*`；
5. **排障**：`cube_ping`（桥）→ `cube_health`（控制面）→ `cube_run logs/raw`。

---

## 配置

密钥由 Cindy 凭证系统管理（`node.secretBindings` → 宿主 safeStorage → 仅调用时注入子进程环境）：

| 变量 | 说明 |
|---|---|
| `CUBESANDBOX_API_KEY` | 控制面 API Key（安装时配置，存于 safeStorage） |
| `CUBESANDBOX_API_URL` | 控制面地址，默认 `https://cubesandbox-api.4a8a.com` |
| `CUBESANDBOX_PROXY_URL` | 数据面网关，默认 `https://cubesandbox-proxy.4a8a.com`，exec/文件/ports 需要 |

仓库内不含任何凭据；地址可在插件设置页覆盖。

---

## 工具

优先用这些专用工具，不要拼 `cube_run`。

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `cube_new` | 建沙箱，自动写元数据，返回 `sandboxId`/`gatewayUrl`/`aiodBase` | `purpose`、`agent`、`dialogue`、`need`、`timeoutSeconds` |
| `cube_ls` | 列沙箱 | `metadata?`（`task=<ID>`）、`state?`、`limit?`、`v2?` |
| `cube_rm` | 销毁沙箱（不可恢复） | `sandboxId` |
| `cube_exec` | 执行一条 shell 命令 | `sandboxId`、`command`、`cwd?`、`timeoutSeconds?` |
| `cube_code` | 跑一段代码（python/js/bash） | `sandboxId`、`code`、`language?` |
| `cube_write_file` | 写文件（字节精确） | `sandboxId`、`path`、`content` |
| `cube_read_file` | 读文件文本（默认上限 256 KiB） | `sandboxId`、`path`、`maxBytes?` |
| `cube_ping` | 零依赖桥探针（pid/方法表/运行时长） | 无 |
| `cube_health` | 控制面健康 + CLI 版本 | 无 |
| `cube_run` | 其余子命令兜底（info/ports/logs/pause/snap/tpl-*/raw…） | `cmd`、`args[]` |
| `cube_submit` | 异步派发任务，立即返回 `taskId` | `cmd`、`args[]`；`cmd=new` 时用 `purpose`/`agent`/`dialogue` |
| `cube_log` | 读异步任务输出（按行偏移增量读） | `taskId`、`offset` |
| `cube_kill` | 终止异步任务 | `taskId` |

**超时约定**

- `cube_exec` / `cube_code` 单次同步上限 **100 秒**（宿主单次调用上限 120 秒；到点退出码 124）。
- `cube_new` 的模板解析 + 创建共享 **110 秒**预算。
- worker 空闲 **300 秒**回收；`cube_submit` 后每 60–90 秒 `cube_log` 一次。
- 更长的沙箱内命令用 `cube_run` 的 `exec-async` + `exec-logs`，或 `cube_submit`。

---

## 【铁律】创建沙箱的三项元数据

创建**只能**走 `cube_new`（`cube_run cmd=new` 会被拒绝；异步用 `cube_submit cmd=new`），三项必填：

| 参数 | 填写内容 | 平台元数据 |
|---|---|---|
| `purpose` | 一句简短中文用途（≤60 字），只写用途，不要写 Agent 名或会话 ID | `metadata.note`（列表「备注」列） |
| `agent` | 当前平台 Agent 身份，如 `Cindy(主)`、`worker-2(子)` | `metadata.agent` |
| `dialogue` | 当前对话 ID（会话 ID） | `metadata.task` |

```json
{ "purpose": "修复 my-env 转义 bug 并跑单测", "agent": "Cindy(主)", "dialogue": "bb5c7920-31b6-4ba7-9cf5-96bb2a29d4b1", "need": "code", "timeoutSeconds": 1800 }
```

返回：

```json
{ "sandboxId": "cd1e093c8f1f403a9b829d3c995103c2",
  "templateId": "tpl-9af58e6e48694a2d8bd7bbbf",
  "gatewayUrl": "/sandbox/cd1e093c8f1f403a9b829d3c995103c2/8080/",
  "aiodBase": "https://cubesandbox-proxy.4a8a.com/sandbox/cd1e093c8f1f403a9b829d3c995103c2/8080/",
  "metadata": { "agent": "Cindy(主)", "note": "修复 my-env 转义 bug 并跑单测", "task": "bb5c7920-31b6-4ba7-9cf5-96bb2a29d4b1" } }
```

`aiodBase` 就是 `aiod-cli` 的 `SANDBOX_BASE`。

- **超时恢复**：`cube_ls { "metadata": "task=<对话ID>" }` 核对沙箱是否已建，再决定 `cube_rm` 还是重试；不要盲目重复创建。
- **用完即毁**：任务结束（含失败）立即 `cube_rm`。

---

## 常用调用

```json
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

异步建沙箱（模板冷启动慢时）：

```json
{ "cmd": "new", "purpose": "构建大镜像", "agent": "Cindy(主)", "dialogue": "<当前对话ID>", "need": "code" }
```

完成后 `cube_log` 会返回 `sandboxId`/`templateId`。

---

## 高级子命令（走 `cube_run`）

```json
{ "cmd": "resume",  "args": ["<sid>"] }
{ "cmd": "timeout", "args": ["<sid>", "3600"] }
{ "cmd": "refresh", "args": ["<sid>", "600"] }
{ "cmd": "net",     "args": ["<sid>", "--no-internet"] }
{ "cmd": "snap",     "args": ["<sid>", "--name=before-refactor"] }
{ "cmd": "snap-ls",  "args": ["--sandbox=<sid>"] }
{ "cmd": "rollback", "args": ["<sid>", "<snapshotID>"] }
{ "cmd": "vol-new",  "args": ["data"] }
{ "cmd": "vol-ls",   "args": [] }
{ "cmd": "tpl-ls",   "args": [] }
{ "cmd": "tpl-pick", "args": ["--need=browser"] }
{ "cmd": "tpl-caps", "args": ["<templateID>"] }
{ "cmd": "exec-async", "args": ["<sid>", "make -j4"] }
{ "cmd": "exec-logs",  "args": ["<sid>", "<pid>", "--offset=0"] }
{ "cmd": "exec-kill",  "args": ["<sid>", "<pid>"] }
```

文件/目录操作还有 `ls-file`、`stat`、`mkdir`、`mv`、`rm-file`、`exists`，按 `cube_run` 的 `cmd` + `args` 传。PTY、浏览器、桌面、MCP 请用 `aiod-cli`。

---

## 写代码与脚本：避免转义陷阱

1. **执行代码片段用 `cube_code`**：代码作为 JSON 载荷直达沙箱解释器，不经过宿主 shell；多行缩进、嵌套引号、反斜杠、`$VAR`、Emoji 原样保留。
2. **写文件用 `cube_write_file`**：字节精确，单次 ≤8 MiB；不要用 `echo "..." > app.py`。
3. **非要用 heredoc 时必须 `cat << 'EOF'`**（EOF 加单引号），否则 `$VAR`、反引号、反斜杠会被提前展开。

---

## 退出码

| 情况 | 退出码 |
|---|---|
| 远端命令成功 | `0` |
| 远端命令失败 | 真实退出码（1–255） |
| 到点未结束（`deadline_exceeded`） | `124`（同 `timeout(1)`） |
| `exit_code<0`（被信号杀死） | `1` |
| 参数/配置/传输错误 | 非 0，`stderr` 给可读原因 |

`（exit N）` 走 **stderr**，不污染 `OUT=$(...)` 管道。

---

## 常见错误与恢复

- **任何 cube 工具超时或 `INTERNAL`**：先 `cube_ping`。秒回 `pid/bootAt` 说明桥正常、问题在下游命令；同样超时说明宿主没把请求送到 worker（重启/重装插件）。
- **`purpose 必须使用中文填写` / `agent 必填` / `dialogue 必填`**：补齐元数据三项后再建。
- **`创建沙箱请用 cube_new`**：`cube_run cmd=new` 已禁用；异步用 `cube_submit cmd=new`。
- **`HTTP 401/403`**：API Key 不对或未注入，检查插件设置页。
- **`没有可用的 READY 模板：...`**：先 `tpl-ls`，或 `tpl-pick --need=...`。
- **`sandbox not found`**：实例已被回收，`cube_ls` 确认后重建。
- **`exitCode 124`**：同步命令超过 100 秒，改用 `cube_submit`、`exec-async` 或调大 `timeoutSeconds`（最大 100）。
- **创建超时**：沙箱可能已创建，`cube_ls metadata=task=<ID>` 核对后再 `cube_rm`。
- **`--env=NAME` 被拒**：裸 `--env=NAME` 会从宿主环境读变量；改用 `env` 参数或 `--env=NAME=VALUE`。
- **`cube_read_file` 返回 `truncated: true`**：调大 `maxBytes`（最大 1 MiB），或分页读取。
- **`cube_write_file` 报 content 过大**：上限 8 MiB，分片多次写入。
