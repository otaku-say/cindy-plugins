# Cube CLI（CubeSandbox 控制面）完整使用手册

`cube-cli` 是专为 Cindy 设计的 **CubeSandbox 云端安全沙箱控制面遥控器**。它允许 Agent 在完全隔离的云端容器沙箱中安全执行不受信任的代码、执行长时间自动化任务、进行多端口网络映射及文件管理。

---

## 什么时候主动使用本插件？

当遇到以下任意场景时，Agent 应主动调用 `cube-cli`：
1. **代码安全隔离执行**：用户希望执行复杂的 Python 脚本、Node.js 项目、Bash 命令，但当前本地机器缺少依赖、或者代码存在潜在系统破坏风险时；
2. **云端沙箱全生命周期管理**：需要动态创建沙箱（`new`）、查询存活实例（`ls`）、获取沙箱元数据与详情（`info`）、暂停挂起（`pause`）、恢复（`resume`）或销毁沙箱（`rm`）时；
3. **长时间异步构建与计算**：需要运行大型包安装、数据模型训练或复杂任务，不能阻塞当前会话超时（使用 `cube_submit` 异步挂载并在后台运行）；
4. **沙箱模板与镜像操作**：查询当前云端已有的容器模板（`template ls`）或根据需求动态挑选模板（`--need=code` / `--need=browser`）。

---

## 配置与准备（安全凭证）

插件严格遵守 Cindy 凭证隔离规范，密钥存放于主机安全保险库：
- **`CUBESANDBOX_API_KEY`**：控制面 API 访问密钥（在插件设置页面填入，由 safeStorage 安全托管，自动在子进程启动时注入环境变量）；
- **`CUBESANDBOX_API_URL`**：控制面地址（如 `https://api.cubesandbox.com`，在插件设置页或 `/kv` 保存）；
- **`CUBESANDBOX_PROXY_URL`**：数据面代理网关（用于沙箱内部 `exec`、`code`、`PTY` 实时数据通道）。

---

## 核心工具与调用指引

本插件在 Cindy 中向 Agent 暴露以下标准化工具：

### 1. `cube_health`
检查控制面连通性。在初次使用沙箱功能或排查报错时优先调用。
- **参数**：无

### 2. `cube_version`
返回当前 CLI 的版本号与编译目标平台（如 `aarch64-macos`）。
- **参数**：无

### 3. `cube_run`
同步执行 cube-cli 子命令。单次执行最长支持 15 分钟（通过 `maxTotalMs` 自动续期）。
- **参数**：
  - `cmd` (string, 必填)：要执行的子命令名称；
  - `args` (array of string, 可选)：传递给子命令的参数。

#### 常用命令速查：
- **创建沙箱**：
  ```json
  { "cmd": "new", "args": ["--need=code", "--timeout=1800"] }
  ```
  *返回：创建成功的沙箱唯一 ID（如 `sid-abcdef123`）及 AIO 网关地址。*
- **在沙箱内运行代码**：
  ```json
  { "cmd": "code", "args": ["<sid>", "print('Hello CubeSandbox')", "--lang=python"] }
  ```
- **在沙箱内运行 Shell 命令**：
  ```json
  { "cmd": "exec", "args": ["<sid>", "uname -a && lscpu"] }
  ```
- **列出当前用户的所有沙箱**：
  ```json
  { "cmd": "ls", "args": [] }
  ```
- **销毁指定沙箱**：
  ```json
  { "cmd": "rm", "args": ["<sid>"] }
  ```
- **查看沙箱详细信息**：
  ```json
  { "cmd": "info", "args": ["<sid>"] }
  ```

### 4. 异步长任务三件套（`cube_submit` / `cube_log` / `cube_kill`）
针对超过 60 秒的极耗时任务（如大数据处理、全套构建），必须采用异步模式避免阻断会话：
1. **提交任务**：调用 `cube_submit({ cmd: "code", args: ["<sid>", "...大任务..."] })`，获取唯一 `taskId`；
2. **轮询日志**：定期调用 `cube_log({ taskId: "...", offset: 0 })` 获取实时输出与完成状态；
3. **终止任务**：若用户中途要求取消，调用 `cube_kill({ taskId: "..." })` 立即终止进程。

---

## 常见错误与恢复策略

- `Missing API Key`：提示用户打开 Cindy 插件详情页面的「设置」，填入 CubeSandbox API Key；
- `Template Not Found`：说明指定的 `--template` 别名不存在，可先调用 `cube_run({ cmd: "template", args: ["ls"] })` 查看可用的沙箱模板清单；
- `Process Timeout`：普通同步调用超过窗口期未返回，请改用 `cube_submit` 异步工作流。
