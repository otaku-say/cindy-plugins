# Cube CLI（CubeSandbox 控制面）完整使用手册

`cube-cli` 是 **CubeSandbox 云端安全沙箱的控制面遥控器**：建/查/销毁沙箱、暂停恢复、模板画像与选择、快照回滚、持久卷，以及在沙箱内执行命令、读写文件（envd 数据面通道）。

- 上游仓库：[`otaku-say/cube-cli`](https://github.com/otaku-say/cube-cli)（命令手册 `docs/cube-cli.md`，命令表 `src/help.zig`）
- 版本号跟随 CubeSandbox Python SDK（`TencentCloud/CubeSandbox`）。
- 每个平台只带自己那一个**静态单文件**二进制；Windows 为原生单文件。
- 沙箱内的深度操作（PTY、浏览器、代码解释器、监听）交给 `aiod-cli`。

---

## 什么时候主动使用本插件？

1. **安全隔离执行**：要跑不受信任的脚本/命令，或本机缺依赖时，建沙箱跑完再销毁；
2. **沙箱全生命周期**：`new` / `ls` / `info` / `pause` / `resume` / `timeout` / `refresh` / `rm`；
3. **长时间任务**：镜像拉取、大构建不宜阻塞会话，用三件套异步跑；
4. **模板与画像**：列模板、按能力挑模板（`--need=code|browser|desktop`）、看构建日志与能力画像；
5. **快照与克隆**：打快照、回滚、以快照为模板批量克隆；
6. **持久卷**：建卷、挂载到沙箱、跨沙箱保留数据；
7. **排障**：`health` 看控制面连通性、`logs` 看沙箱启动/运行日志、`raw` 透传任何未封装的 API。

---

## 配置与准备

插件按 Cindy 凭证规范管理密钥（`node.secretBindings` → 主机 `safeStorage` → 仅在调用时注入子进程环境变量）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `CUBESANDBOX_API_URL` | 是 | 控制面地址 |
| `CUBESANDBOX_API_KEY` | 否 | 控制面 API Key（部署未启用鉴权时可省略），以 `X-API-KEY` 头发送 |
| `CUBESANDBOX_PROXY_URL` | exec / 文件 / ports 必填 | 数据面网关，拼沙箱访问 URL 用 |
| `CUBESANDBOX_AGENT_NAME` | 否 | `new` 写入 `metadata.agent` 的默认名字 |

仓库与插件内**不含任何主机名、IP 或凭据**；旧命名（`CUBE_API_URL` / `CUBE_API_KEY` / `CBS_PROXY_BASE`）已彻底移除。

---

## 插件暴露的工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `cube_version` | 版本 + 本机平台 | 无 |
| `cube_health` | 控制面连通性与沙箱数 | 无 |
| `cube_run` | 同步执行任意子命令，返回 `{stdout, stderr, exitCode}` | `cmd`、`args[]` |
| `cube_submit` | 异步派发长任务，立即返回 `taskId` | `cmd`、`args[]` |
| `cube_log` | 取异步任务输出（可按行偏移增量读） | `taskId`、`offset` |
| `cube_kill` | 终止异步任务 | `taskId` |

> `cube_run` 单次最长 15 分钟（有输出即续期）。超 60 秒的任务（大镜像、长构建）请用 `cube_submit` + `cube_log`。

---

## 常用命令速查（按 `cube-cli help all` 分组）

**沙箱**
```json
{ "cmd": "new",  "args": ["--need=code", "--timeout=1800", "--note=demo"] }
{ "cmd": "ls",   "args": [] }
{ "cmd": "info", "args": ["<sandboxID>"] }
{ "cmd": "exec", "args": ["<sandboxID>", "uname -a && lscpu"] }
{ "cmd": "code", "args": ["<sandboxID>", "print(1+1)", "--lang=python"] }
{ "cmd": "ports","args": ["<sandboxID>"] }
{ "cmd": "rm",   "args": ["<sandboxID>"] }
```

`new` 输出里的 `[sandbox] AIO 网关:` 那行**就是** `aiod-cli` 的 `SANDBOX_BASE`：

```bash
SID=$(cube-cli new --need=code)
export SANDBOX_BASE="https://<网关>/sandbox/$SID/8080"
```

**生命周期**
```json
{ "cmd": "pause",   "args": ["<sid>"] }
{ "cmd": "resume",  "args": ["<sid>"] }
{ "cmd": "connect", "args": ["<sid>"] }
{ "cmd": "timeout", "args": ["<sid>", "3600"] }              # 空闲回收超时（秒）
{ "cmd": "refresh", "args": ["<sid>", "600"] }               # 续期：新增一个时间窗
{ "cmd": "net",     "args": ["<sid>", "--no-internet"] }
```

**快照 / 卷 / 克隆**
```json
{ "cmd": "snap",     "args": ["<sid>", "--name=before-refactor"] }
{ "cmd": "snap-ls",  "args": ["--sandbox=<sid>"] }
{ "cmd": "rollback", "args": ["<sid>", "<snapshotID>"] }
{ "cmd": "clone",    "args": ["<sid>", "--n=3"] }
{ "cmd": "vol-new",  "args": ["data"] }
{ "cmd": "vol-ls",   "args": [] }
```

**模板**
```json
{ "cmd": "tpl-ls",     "args": [] }
{ "cmd": "tpl-pick",   "args": ["--need=browser"] }
{ "cmd": "tpl-caps",   "args": ["<templateID>"] }
{ "cmd": "tpl-logs",   "args": ["<templateID>", "<buildID>"] }
```

**文件（envd 通道）**
```json
{ "cmd": "cat",         "args": ["<sid>", "/root/app.log"] }
{ "cmd": "write",       "args": ["<sid>", "./a.md", "/root/a.md"] }   # 本地 → 远端
{ "cmd": "get",         "args": ["<sid>", "/root/out.tar", "./out.tar"] }
{ "cmd": "ls-file",     "args": ["<sid>", "/root"] }
{ "cmd": "write-files", "args": ["<sid>", "--files=/root/a.md:./a.md,/root/b.md:./b.md"] }
```

**异步进程 / PTY / 诊断**
```json
{ "cmd": "exec-async", "args": ["<sid>", "make -j4"] }        # 立即返回 pid，进程继续跑
{ "cmd": "exec-logs",  "args": ["<sid>", "<pid>", "--offset=0"] }
{ "cmd": "exec-kill",  "args": ["<sid>", "<pid>"] }
{ "cmd": "exec-stdin", "args": ["<sid>", "<pid>", "y"] }
{ "cmd": "pty-open",   "args": ["<sid>", "--cols=120", "--rows=36"] }  # 返回 pid
{ "cmd": "pty-write",  "args": ["<sid>", "<pid>", "ls\n"] }
{ "cmd": "pty-read",   "args": ["<sid>", "<pid>", "--offset=0"] }
{ "cmd": "pty-close",  "args": ["<sid>", "<pid>"] }
{ "cmd": "logs",       "args": ["<sid>", "--tail=200"] }
{ "cmd": "raw",        "args": ["GET", "/sandboxes"] }                 # 任意控制面 API 兜底
{ "cmd": "health",     "args": [] }
```

`mcp-server` 子命令把 37 个控制面能力以 stdio MCP 暴露（`sandbox_*` / `file_*` / `snapshot_*` / `volume_*` / `template_*` / `api_call`），完整清单以 `tools/list` 为准。

---

## 退出码约定（与上游一致）

上游 `CommandResult` 直接给 `exit_code`，所以 shell 里拿到同一个数字：

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

- **`错误：缺少环境变量 CUBESANDBOX_API_URL`**：控参地址未配。打开插件设置页填 URL（以及 API Key、数据面网关）。
- **`HTTP 401/403`**：Key 不对或未注入。确认 `CUBESANDBOX_API_KEY` 已保存且非空。
- **`Template Not Found`**：`--template` / `--need` 找不到可用模板。先 `tpl-ls` 看现有模板，`tpl-pick` 按能力挑。
- **`sandbox not found`**：实例已被回收（`timeout` 到点）。用 `ls` 确认，必要时 `new` 重建。
- **命令超时 / `exitCode 124`**：改走 `cube_submit` 异步，或调大 `--timeout`。
- **同步调用被网关 524**：单次 HTTP 窗口约 2 分钟。长任务一律用 `cube_submit` + `cube_log`。
