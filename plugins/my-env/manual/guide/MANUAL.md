# My Env 使用指南

My Env 是一个跨平台的环境变量与密钥安全中枢：在设置页统一维护管理各种环境变量与 Token，支持在沙箱、容器及本地任务中无明文安全调用与穿透注入。

## 核心设计与存储边界

- **双层存储架构**：
  - 核心存储由随包 Node 进程管理（本地磁盘独立 JSON 持久化），突破纯前端 `/kv` 的 60KB 限制，支持存放海量变量、大型私钥与多套环境配置；
  - 兼容 `/kv` 轻量镜像同步，保证设置页在全平台（macOS、Windows、Linux）秒开与离线展示。
- **对话流零明文原则**：
  - 工具卡片与 Agent 对话流是公开可见的，因此 Agent **严禁作为明文密钥的搬运工**；
  - 敏感项在 `env_list` 列表中恒为全掩码；
  - 推荐优先使用 `env_write_file` 或 `env_exec` 进行“管道直注”，回执仅包含键名与元数据，密钥明文绝不进入会话历史。

## Agent 工具清单

1. `env_list`：列出已存键名、脱敏掩码、备注、敏感标记与更新时间；支持关键词搜索。
2. `env_write_file`：**【推荐注入方式】**将指定密钥集合直接渲染并落盘到目标文件（支持 `.env`、`shell` 环境变量脚本、`json` 配置）。文件权限在 POSIX 系统默认自动设为 `0600`，对话回执仅包含写入的键名列表与字节数，无任何明文。
3. `env_exec`：**【本地安全执行】**在子进程中执行指定命令（如 `git push`、`npm test`），并在进程级别直接注入所选环境变量。stdout/stderr 会被**全量**脱敏（覆盖全部已存敏感项，不只是本次注入的 keys），回执附带 `redacted_hits` 与 `redacted_warning`，便于判断命令是否在回显凭据。需要 `$VAR` / `%VAR%` 展开时传 `shell: true`。
4. `env_get`：单键读取。**敏感项默认拒绝返回明文**，回执为 `{ denied: "SENSITIVE_PLAINTEXT_BLOCKED", maskedValue, hint }`——因为返回值会整条落进 Agent 的对话上下文并被持久化。只有显式传 `allow_plaintext: true` 才放行，仅限第三方接口硬性要求原文的兼容场景。
5. `env_probe`：**【凭据自检】**不取明文地验证密钥是否仍然有效。`kind: "github"` 返回账号、scope 与（传了 `repo` 时）仓库 push 权限；`kind: "http"` 返回状态码。响应体原文永不回传，因此「这枚 Key 还能不能用」不再需要把值取出来看。
6. `env_set`：新增或更新单个变量。
7. `env_delete`：删除单个变量。

## 向云沙箱与外部环境安全注入凭据

在与云端沙箱（如 CubeSandbox、Aiod、Docker 或远程 SSH）协同作业时，推荐标准三步工作流：

### 模式 A：文件注入模式（最通用）
1. Agent 调用 `env_write_file` 生成目标文件，例如：
   ```json
   { "target_path": ".env", "keys": ["OPENAI_API_KEY", "GITHUB_TOKEN"], "format": "dotenv" }
   ```
   *回执仅展示 `{ ok: true, written_keys: ["OPENAI_API_KEY", "GITHUB_TOKEN"], count: 2 }`，对话零明文。*
2. 使用对应的传输工具将该文件推入沙箱或容器：
   - CubeSandbox / Aiod：调用 `aiod_run({ cmd: "files", args: ["put", ".env", "/var/minis/workspace/.env"] })`
   - Docker：`docker cp .env <container>:/app/.env`
   - SSH / 远程主机：`scp .env user@host:/path/.env`
3. 沙箱内程序自动从 `.env` 加载环境变量，整个生命周期无明文泄露。

### 模式 B：进程直注模式（适用于本地或挂载 CLI）
1. Agent 调用 `env_exec` 执行命令：
   ```json
   { "command": "npm", "args": ["run", "deploy"], "keys": ["DEPLOY_TOKEN"] }
   ```
2. 进程内通过 `process.env.DEPLOY_TOKEN` 直接获取，命令行参数与对话中不包含明文，输出若报错也会自动掩码脱敏。

## 凭据自检（env_probe，v0.2.3 新增）

过去要确认「这枚 Token 还有效吗」，只能把明文取出来再用它发一次请求——明文因此进入对话记录。
`env_probe` 把这件事收敛成一次无明文的探测：

```json
{ "kind": "github", "keys": ["GITHUB_TOKEN"], "repo": "owner/repo" }
```

回执形如：

```json
{
  "ok": true,
  "kind": "github",
  "checks": [{
    "key": "GITHUB_TOKEN", "status": 200, "login": "octocat",
    "scopes": "repo, workflow",
    "repo": { "name": "owner/repo", "status": 200, "push": true, "admin": false, "default_branch": "main" }
  }]
}
```

通用 HTTP 端点：

```json
{ "kind": "http", "keys": ["MY_API_KEY"], "url": "https://api.example.com/me",
  "header": "Authorization", "header_template": "Bearer {token}", "ok_status": [200] }
```

只返回状态码与白名单字段，**响应体原文永不回传**，因此响应里即使回显了密钥也不会泄漏。

## 常见报错与恢复

- **`timeoutMs 必须是 1000–120000 的整数`**
  这不是 `timeout_ms` 参数非法，而是**宿主的 node 请求硬上限**（单次 `timeoutMs ≤ 120000`）。
  旧版本把 `timeout_ms + 5000` 直接丢给宿主，因此 `timeout_ms > 115000` 会整条调用被拒收。
  0.2.2 起插件内部已把 RPC 请求超时钳制到宿主上限内。
  **注意**：`timeout_ms` 参数虽然接受最大 300000，但宿主单次 node 请求的硬上限是 120000 ms——
  超过约 115 秒且没有任何输出的命令仍会被中断。真正的长任务请放后台（重定向到文件 + 轮询）。
  若仍看到该报错，说明跑的是旧版插件，更新即可。

- **`无法启动命令 "bash"：该命令不在 PATH 中`（原始形态 `spawn bash ENOENT`）**
  `command` 是**直接用 PATH 解析的可执行文件名**，不经过任何 shell。Windows 上通常没有 `bash` / `grep` / `sed`。
  可行做法：改用 `node`、`cmd`、`powershell`，或写完整路径
  （如 `C:/Program Files/Git/bin/bash.exe`，参数里再用 `-c "..."`）。
  需要 shell 语义时可显式传 `"shell": true`（`.cmd` / `.bat` 会自动启用）。

- **`环境变量不存在: X`**
  `env_exec` / `env_get` 只认设置页里已保存的键。先 `env_list` 确认键名，或 `env_set` 写入。

- **输出里看不到密钥**
  这是设计行为：注入的敏感值会在 stdout/stderr 中被替换为掩码，输出里出现明文即视为缺陷。

- **静默超长命令被中断**
  单次请求 120s 上限内没有任何输出会被判超时。长时间静默任务请放后台（重定向到文件 + 轮询），或拆成多次短调用。

## 备份与迁移（设置页手动操作）

- **导出全部**：设置页一键生成整包 JSON（包含明文值）并复制到剪贴板，支持下载 `.json` 文件。
- **导入**：支持整包格式与轻量键值格式导入；支持「只新增」与「覆盖同名」两种策略，内置非法键名与原型污染防护（过滤 `__proto__` / `constructor` / `prototype`）。

---

## 变更记录

### v0.2.3

- **`env_get` 敏感项默认拒接明文**：回执改为 `{ denied: "SENSITIVE_PLAINTEXT_BLOCKED", maskedValue, hint }`，需显式 `allow_plaintext: true` 才放行。根因是返回值会整条落进对话上下文并被持久化，历史上两次 PAT 泄漏皆源于此。
- **`env_exec` 脱敏清单改为覆盖全部敏感项**：原先只脱敏本次注入的 keys，`keys: ["A"]` 时命令若回显 B 的值会原样漏出。同时回执新增 `redacted_hits` / `redacted_warning`。
- **`env_exec` 打通 `shell` 参数**：worker 层早已实现 shell 语义，但 main.js 未透传、ghost.json 未声明，导致手册承诺的能力永远无法触达。现三层对齐。
- **新增 `env_probe`**：不取明文即可验证凭据有效性（GitHub 账号/scope/仓库 push 权限，或任意 HTTP 状态码）。
- 修正手册中关于 `timeout_ms` / `maxTotalMs` 可「用满 15 分钟」的误导描述——宿主单次 RPC 硬上限仍是 120000 ms。
