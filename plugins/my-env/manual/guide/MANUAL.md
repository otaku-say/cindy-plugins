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
3. `env_exec`：**【本地安全执行】**在子进程中执行指定命令（如 `git push`、`npm test`），并在进程级别直接注入所选环境变量。命令的 stdout/stderr 输出会自动扫描并脱敏敏感密钥。
4. `env_get`：单键明文读取。仅当第三方插件或特定接口必须由调用方传入单个非敏感配置时作为兼容兜底，使用时严禁 Agent 将值打印在回复文本中。
5. `env_set`：新增或更新单个变量。
6. `env_delete`：删除单个变量。

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

## 常见报错与恢复

- **`timeoutMs 必须是 1000–120000 的整数`**
  这不是 `timeout_ms` 参数非法，而是**宿主的 node 请求硬上限**（单次 `timeoutMs ≤ 120000`）。
  旧版本把 `timeout_ms + 5000` 直接丢给宿主，因此 `timeout_ms > 115000` 会整条调用被拒收。
  0.2.2 起插件内部已把 RPC 预算钳制到上限内，并把 `timeout_ms` 放宽到 300000（配合 `maxTotalMs` 用满 15 分钟）。
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
