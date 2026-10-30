# My Env 使用指南（v0.3.0）

My Env 是一个跨平台的环境变量与密钥中枢：在设置页统一维护，Agent 可以通过工具把凭据**注入进程环境或落成本地文件**，再交给沙箱、容器或远程主机使用，对话里不出现明文。

## 核心设计与存储边界

- **唯一数据源：随包 Node 进程**
  - 变量保存在本机 `…/CindyGlobal/data/my-env/variables.json`；目录权限 `0700`、文件 `0600`（POSIX），每次写入前保留一份 `variables.json.bak`。
  - 写操作带锁（跨进程），设置页与 Agent 同时改也不会互相覆盖。
  - v0.3.0 起**不再镜像到宿主 `/kv`**：旧版本会把全部明文复制一份进 KV，且删除/改备注永远同步不回 Node。设置页现在通过插件后台通道直接读写同一份数据。
- **明文存储，不是加密保险库**
  - 文件是明文 JSON，只是被文件权限保护。能读你本机账号文件的程序（包括本插件的 Node 进程）都能读到值。
  - 因此：不要把生产级主密钥放在这里；GitHub / 云厂商等支持官方登录的，优先用对应插件的托管登录。
- **对话流零明文原则**
  - 工具卡片与对话历史是公开可见的，Agent 不应做明文密钥的搬运工；
  - `env_list` 里敏感项恒为全掩码；
  - 存值优先 `value_from`，用值优先 `env_write_file` / `env_exec`，回执只有键名与元数据。

## Agent 工具清单

1. `env_list`：列出键名、掩码、备注、敏感标记与更新时间。支持 `query` 搜索、`keys` 精确批量查看（缺失键在 `missing`），以及 `limit` / `offset` 分页（默认 100，返回 `hasMore`）。
2. `env_get`：单键读取。**敏感项默认拒绝返回明文**，回执为 `{ denied: "SENSITIVE_PLAINTEXT_BLOCKED", maskedValue, hint }`——返回值会整条落进会话上下文并被持久化。只有显式传 `allow_plaintext: true` 才放行，仅限第三方接口硬性要求原文的兼容场景。
3. `env_set`：新增或更新变量。
   - **推荐**：`value_from: { file: "/abs/path" }`（读本机文件，末尾换行会被裁掉）或 `value_from: { env: "NAME" }`（复制 worker 进程里已有的环境变量）——密钥不经过工具参数。
   - 直接传 `value` 仍可用，但明文会留在会话记录里，回执会带 `warning` 与 `value_source: "inline"`。
4. `env_delete`：删除单个变量。
5. `env_write_file`：把**显式列出**的变量渲染进文件（`dotenv` / `shell` / `json`），是往沙箱、容器、远程主机注入凭据的主入口。
   - `keys` 必填，不会隐式写入全部凭据；
   - 文件以 `file_mode`（默认 `0600`）在**创建时**就设好权限；
   - 默认**不覆盖**已存在文件（`overwrite: true` 才覆盖）；
   - 拒绝符号链接目标；默认只允许写当前工作目录内（`allow_outside_cwd: true` 才放行）；
   - 回执只有键名、字节数与目标路径，无明文。
6. `env_exec`：在子进程里执行命令，并把所选变量注入进程环境。
   - stdout/stderr 全量脱敏（覆盖**全部**敏感项，不只是本次注入的 keys），回执带 `redacted_hits` / `redacted_keys`；
   - 超时会**杀掉整个进程树**，并以 `{ ok: false, timedOut: true }` 返回已产生的部分输出；
   - 支持 `stdin` 喂文本（如 `git commit -F -`）。
7. `env_probe`：无明文自检凭据。
   - `keys` 必填（最多 20 个），不存在"默认探测全部敏感项"的模式——探测会把凭据发往目标地址；
   - `github` 返回账号、scope 与（给 `repo` 时）push 权限；
   - `http` 只回状态码，响应体永不回传；
   - 目标解析到回环/内网/链路本地地址时默认拒绝（`allow_private: true` 才放行），可用 `allowed_hosts` 限定主机白名单。

## 把凭据送进沙箱使用

沙箱里的程序只能看到"沙箱内存在的文件或环境变量"，所以流程是：**本地落盘 → 上传 → 沙箱内 source**。全程明文不出现在对话里。

### 模式 A：CubeSandbox / aiod（推荐）

1. 本地落盘，只写需要的键：
   ```json
   { "target_path": "<工作目录>/.env.myenv", "keys": ["OPENAI_API_KEY", "GITHUB_TOKEN"], "format": "dotenv" }
   ```
   回执给出绝对路径 `target_path`，例如 `{ "ok": true, "count": 2, "target_path": "…\\.env.myenv" }`。
2. 上传到沙箱（`aiod-cli` 的 `aiod_upload`，二进制安全且校验双端 SHA256）：
   ```json
   { "localPath": "<上一步的 target_path>", "remotePath": "/root/.env.myenv" }
   ```
   确认回执 `verified: true` 再继续；`verified: false` 说明内容不一致，不要接着执行。
3. 在沙箱内加载并执行：
   ```
   set -a; . /root/.env.myenv; set +a; <你的命令>
   ```
   直接用 `aiod_exec` 跑这一整行（`command` 传整条命令字符串）。
4. 用完删掉：`rm -f /root/.env.myenv`，减少沙箱内明文停留时间。

> 不要用 `cube_write_file` / `aiod_write_file` 传密钥：它们的 `content` 参数是明文，会直接进对话记录。文件传输请用 `aiod_upload`。

### 模式 B：Docker / SSH / 远程主机

```json
{ "target_path": ".env", "keys": ["DEPLOY_TOKEN"], "format": "dotenv" }
```

然后 `docker cp .env <container>:/app/.env`，或 `env_exec` 里跑 `scp .env user@host:/path/.env`（`scp` 不需要读取明文，值一直只在文件里）。

### 模式 C：本机进程直注

```json
{ "command": "npm", "args": ["run", "deploy"], "keys": ["DEPLOY_TOKEN"] }
```

进程里 `process.env.DEPLOY_TOKEN` 直接可用；命令行参数与会话记录中都没有明文，报错输出也会被掩码。

## shell 语义与引号（v0.3.0）

- `shell: false`（默认）：`command` 按 PATH 解析，`args` 原样传入，不做任何转义。`$VAR` 不会展开（这是预期行为）。
- `shell: true` / `command_line`：显式包装成 `'/bin/sh -c <line>'` 或 `'cmd.exe /d /s /c <line>'`，**不使用** Node 的 `shell: true`（它会把 cmd+args 直接拼给 shell，留下注入面并触发 DEP0190）。
- `shell: true` 时含空白或引号的参数会自动加引号，含 `$VAR` 的参数保持原样以保留展开语义。
- **`command_line` 优先，且不做二次转义**：引号由你负责。需要完全掌控引号（Windows 的 `cmd` 尤其如此）时用它：
  ```json
  { "command_line": "git push https://x-access-token:$GITHUB_TOKEN@github.com/owner/repo.git", "keys": ["GITHUB_TOKEN"] }
  ```
- Windows 上 `$VAR` 不展开，用 `%VAR%`。

## 超时与长任务

- `timeout_ms` 允许 1000–110000，默认 30000。宿主单次 node 请求硬上限是 120000 ms，所以 110000 是可用上限；插件内部把 RPC 预算钳制在 118000 以内。
- 超时后返回 `{ ok: false, timedOut: true, stdout, stderr }`，进程树（含孙进程）一并终止，不用自己收尾。
- 需要跑几分钟的活儿，请重定向到文件再轮询，或使用沙箱侧的 `aiod_submit` / `aiod_log`。

## 常见报错与恢复

- **`keys 必填：请显式列出要写入的变量`**
  `env_write_file` 不再支持"省略 keys 就写全部"。这是防止一次手滑把全部凭据倒进仓库。
- **`目标文件已存在且 overwrite 为 false`**
  默认不覆盖。确认要覆盖时传 `overwrite: true`。
- **`目标路径在工作目录之外`**
  确认要写别处时传 `allow_outside_cwd: true`。
- **`目标文件是符号链接，拒绝写入`**
  防止通过软链接覆盖他人文件。请直接写真实路径。
- **`目标解析到内网/本机地址`**
  `env_probe` 的默认防护。本地开发服务请显式传 `allow_private: true`（或用 `allowed_hosts` 收窄）。
- **`keys 必填：探测会把凭据发送到目标地址`**
  `env_probe` 必须显式指定键，避免一次调用把全部敏感项发出去。
- **`存储正被另一个进程写入，请稍后重试`**
  设置页与 Agent 恰好同时写。等一两秒重试即可。
- **`无法启动命令 "bash"：该命令不在 PATH 中`**
  `command` 用 PATH 解析，不经过 shell。Windows 上通常没有 `bash` / `grep`；改用 `node`、`cmd`、`powershell` 或写完整路径。
- **`环境变量不存在: X`**
  先 `env_list` 确认键名，或 `env_set` 写入。
- **输出里看不到密钥**
  设计行为：敏感值在 stdout/stderr 中被替换为 `[REDACTED_SECRET]`。短于 4 字符的值不参与替换（替换会破坏正常文本），因此不要把极短字符串当密钥。
- **设置页提示"插件后台无响应"**
  设置页只通过插件后台（Node worker）读写数据。确认插件处于启用状态；停用/更新后重新打开设置页即可。

## 备份与迁移（设置页手动操作）

- **导出全部**：生成整包 JSON（含明文值），可下载 `.json` 或点按钮复制。面板打开时**不再自动**写入系统剪贴板。
- **导入**：支持整包格式与轻量键值格式，支持"只新增"与"覆盖同名"；非法键名与 `__proto__` / `constructor` / `prototype` 会被过滤。
- **回滚**：写入前的上一版保存在同目录 `variables.json.bak`，误删可手工恢复。

## 从 v0.2.x 升级

- 数据文件位置不变，升级后原有变量仍在。
- 设置页改为直连插件后台：旧版"在设置页删掉的键会复活"的问题已消失；升级后如果看到某个曾被删除的键，删一次即可（旧版从未把删除同步到 Node）。
- `/kv` 不再存放变量；KV 里的旧副本不会被读取，可忽略。

---

## 变更记录

### v0.3.1

- 手册补齐「把凭据送进沙箱使用」的完整三步流程（`env_write_file` → `aiod_upload` → 沙箱内 `set -a; . <file>; set +a`），并说明为什么不能用 `*_write_file` 的 `content` 传密钥。
- 手册补充存储边界（明文 + 0600，非加密保险库）、`env_set` 的 `value_from` 用法、分页与超时语义。代码行为与 v0.3.0 一致。

### v0.3.0

- **移除 `/kv` 镜像**：Node 存储成为唯一数据源。旧实现每次工具调用都把 KV upsert 回 Node 且只在值变化时更新，导致"设置页删除的键复活、只改备注的编辑永不生效"，KV 里还多一份明文。设置页改走插件后台通道。
- **存储加固**：目录 `0700`、文件 `0600`（创建时即生效）、跨进程写锁、写入前保留 `.bak`、拒绝符号链接存储文件。
- **`env_set` 新增 `value_from`**：可用文件或既有环境变量作为值来源，密钥不必经过工具参数；仍接受 `value` 但回执带 `warning`。
- **`env_write_file` 收紧**：`keys` 必填、默认不覆盖、拒绝符号链接与工作目录外路径、权限在创建时设定。
- **`env_exec` 加固**：超时杀整棵进程树并回传部分输出（`timedOut`）；输出按字节截断；shell 模式按平台给参数加引号；新增 `stdin`；`timeout_ms` 上限对齐宿主（110000）。
- **`env_probe` 收紧**：`keys` 必填（最多 20），默认拒绝回环/内网/链路本地目标，支持 `allow_private` 与 `allowed_hosts`。
- **脱敏改进**：按值长度降序替换，避免长短值互相截断；回执新增 `redacted_keys`。
- **`env_list` 支持分页**：`limit` / `offset`，回执带 `hasMore`。
- **设置页**：导出面板不再自动复制明文到剪贴板；新增同名键需确认；显示存储路径、条目数、体积与权限。

### v0.2.4

- `shell: true` 的 DEP0190 根治：改为显式 `/bin/sh -c` / `cmd.exe /d /s /c` 包装 + `shell:false`。
- 新增 `env_exec.command_line`。
- `env_list` 新增 `keys` 参数（缺失键通过 `missing` 报告）。
- 保留 `env_get` 作为读非敏感配置的快捷方式，敏感项仍默认拒明文。

### v0.2.3

- `env_get` 敏感项默认拒接明文（`SENSITIVE_PLAINTEXT_BLOCKED`）。
- `env_exec` 脱敏清单改为覆盖全部敏感项，回执新增 `redacted_hits` / `redacted_warning`。
- 打通 `shell` 参数的三层透传。
- 新增 `env_probe`。
