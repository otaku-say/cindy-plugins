// plugins/cube-cli/node/worker.cjs —— 随包 Node 工作进程
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function log(msg) {
  process.stderr.write(`[cube-worker] ${msg}\n`);
}

function reply(id, result, error) {
  const resp = { jsonrpc: '2.0', id };
  if (error) resp.error = error;
  else resp.result = result;
  process.stdout.write(JSON.stringify(resp) + '\n');
}

function badParams(message) {
  return Object.assign(new Error(message), { code: -32602 });
}

// 参数校验失败统一用 -32602（Agent 侧可据此判断是调用姿势错误）
function invalid(message) {
  return badParams(message);
}

function getStandardPlatformKey() {
  const osMap = { darwin: 'macos', win32: 'windows', linux: 'linux' };
  const archMap = { x64: 'amd64', x86_64: 'amd64', arm64: 'arm64', aarch64: 'arm64' };
  const os = osMap[process.platform] || process.platform;
  const arch = archMap[process.arch] || process.arch;
  return `${os}-${arch}`;
}

function findBinary() {
  const isWin = process.platform === 'win32';
  const ext = isWin ? '.exe' : '';
  const exeName = `cube-cli${ext}`;
  const binDir = path.resolve(__dirname, '..', 'bin');

  // 1. 优先查平铺的 bin/<exeName>（单平台构建产物）
  const flatBin = path.join(binDir, exeName);
  if (fs.existsSync(flatBin)) {
    try { fs.chmodSync(flatBin, 0o755); } catch (_) {}
    return flatBin;
  }

  // 2. 查标准子目录 bin/<os>-<arch>/<exeName>（多架构开发/内嵌目录）
  const stdKey = getStandardPlatformKey();
  const stdBin = path.join(binDir, stdKey, exeName);
  if (fs.existsSync(stdBin)) {
    try { fs.chmodSync(stdBin, 0o755); } catch (_) {}
    return stdBin;
  }

  // 3. 兜底兼容传统架构别名
  const platKey = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(binDir, platKey, exeName),
    path.join(binDir, `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`, exeName),
    path.resolve(__dirname, '..', exeName)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { fs.chmodSync(c, 0o755); } catch (_) {}
      return c;
    }
  }

  return exeName;
}

const tasks = new Map(); // taskId -> taskRecord
const MAX_TASKS = 50; // 限制后台驻留任务数，避免高负载下内存泄漏

function recordTask(taskId, record) {
  if (tasks.size >= MAX_TASKS) {
    for (const [id, t] of tasks) {
      if (t.completed) {
        tasks.delete(id);
        break;
      }
    }
    if (tasks.size >= MAX_TASKS) return false;
  }
  tasks.set(taskId, record);
  return true;
}

function buildEnv(request) {
  const defaultApiUrl = 'https://cubesandbox-api.4a8a.com';
  const defaultProxyUrl = 'https://cubesandbox-proxy.4a8a.com';
  const passedEnv = request.params?.cliEnv || {};
  const env = {
    ...process.env,
    CUBESANDBOX_API_URL: passedEnv.CUBESANDBOX_API_URL || process.env.CUBESANDBOX_API_URL || defaultApiUrl,
    CUBESANDBOX_PROXY_URL: passedEnv.CUBESANDBOX_PROXY_URL || process.env.CUBESANDBOX_PROXY_URL || defaultProxyUrl,
    ...passedEnv
  };
  const secretKey = request.cindy?.secrets?.cubesandbox_api_key;
  if (secretKey) {
    env.CUBESANDBOX_API_KEY = secretKey;
  }
  return env;
}

// ---------------- 参数构建（纯函数，便于单测） ----------------

const MAX_OUTPUT = 256 * 1024; // 同步输出截断保护（按字节）
const MAX_CREATE_OUTPUT = 2 * 1024 * 1024; // 创建响应上限（控制面 JSON）
const MAX_WRITE_BYTES = 8 * 1024 * 1024; // 与 CLI write 的 stdin 上限一致
const MAX_READ_BYTES = 1024 * 1024;
const SYNC_MAX_SECONDS = 100; // 同步 exec/code 上限：必须小于宿主 timeoutMs 上限（120s）
const RESERVED_ENV_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function oneLine(value) {
  return asText(value)
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function strictInt(value, name, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const ok = (typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^-?\d+$/.test(value.trim()));
  if (!ok) throw invalid(`${name} 必须是整数（收到 ${JSON.stringify(value)}）`);
  return toInt(value, fallback, min, max);
}

function envArgs(env) {
  if (env === undefined || env === null) return [];
  if (typeof env !== 'object' || Array.isArray(env)) throw invalid('env 必须是对象（键值对）');
  const out = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw invalid(`env 变量名非法: ${key}（只允许字母、数字、下划线，且不能以数字开头）`);
    }
    if (RESERVED_ENV_KEYS.has(key)) throw invalid(`env 变量名保留，禁止使用: ${key}`);
    if (value !== null && typeof value === 'object') throw invalid(`env.${key} 必须是字符串/数字/布尔值`);
    out.push(`--env=${key}=${String(value ?? '')}`);
  }
  return out;
}

function buildEnvObject(env, label = 'env') {
  const out = Object.create(null);
  if (env === undefined || env === null) return out;
  if (typeof env !== 'object' || Array.isArray(env)) throw invalid(`${label} 必须是对象（键值对）`);
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw invalid(`${label} 变量名非法: ${key}（只允许字母、数字、下划线，且不能以数字开头）`);
    }
    if (RESERVED_ENV_KEYS.has(key)) throw invalid(`${label} 变量名保留，禁止使用: ${key}`);
    if (value !== null && typeof value === 'object') throw invalid(`${label}.${key} 必须是字符串/数字/布尔值`);
    out[key] = String(value ?? '');
  }
  return out;
}

/**
 * 归一化 cube_new 入参：purpose（note，一句中文用途短句）/ agent / dialogue 三项必填。
 */
function normalizeNewParams(params = {}) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw invalid('params 必须是对象');

  for (const field of ['purpose', 'agent', 'dialogue']) {
    if (params[field] !== undefined && typeof params[field] !== 'string') {
      throw invalid(`${field} 必须是字符串（收到 ${JSON.stringify(params[field])}）`);
    }
  }

  const purpose = oneLine(params.purpose);
  const agent = oneLine(params.agent);
  const dialogue = oneLine(params.dialogue);

  if (!purpose) throw invalid('purpose 必填：用一句简短中文写清这次沙箱的用途');
  if (!/[\u4e00-\u9fff]/.test(purpose)) throw invalid('purpose 必须使用中文填写（平台元数据需要中文用途）');
  if ([...purpose].length > 60) throw invalid('purpose 过长（最多 60 字）：note 只写用途短句，不要写 Agent 名或会话 ID');
  if (/(dialogue|agent)\s*[=＝:：]/i.test(purpose)) {
    throw invalid('purpose 只写用途，不要包含 dialogue=/agent= 等元数据；它们由 dialogue、agent 参数单独写入');
  }
  if (!agent) throw invalid('agent 必填：填写当前平台(主/子)Agent，例如 Cindy(主)');
  if ([...agent].length > 60) throw invalid('agent 过长（最多 60 字）');
  if (!dialogue) throw invalid('dialogue 必填：填写当前对话 ID，便于在平台按会话追溯沙箱');
  if (dialogue.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(dialogue)) {
    throw invalid('dialogue 只能是 1-64 位字母、数字、点、下划线、冒号或连字符（当前对话 ID 即可）');
  }

  if (params.need !== undefined && typeof params.need !== 'string') throw invalid('need 必须是字符串');
  const need = params.need == null || params.need === '' ? 'code' : params.need;
  if (!['code', 'browser', 'desktop'].includes(need)) {
    throw invalid(`need 只能是 code / browser / desktop（收到 ${need}）`);
  }

  const timeout = strictInt(params.timeoutSeconds, 'timeoutSeconds', 1800, 60, 86400);

  let template = '';
  if (params.template !== undefined && params.template !== null && params.template !== '') {
    if (typeof params.template !== 'string') throw invalid('template 必须是字符串');
    template = params.template.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(template)) throw invalid('template 只能是模板 ID/别名（1-64 位字母、数字、点、下划线、连字符）');
  }

  let volume = '';
  if (params.volume !== undefined && params.volume !== null && params.volume !== '') {
    if (typeof params.volume !== 'string') throw invalid('volume 必须是字符串');
    volume = params.volume.trim();
    const parts = volume.split(':');
    if (parts.length > 2) throw invalid('volume 格式应为 卷名 或 卷名:挂载路径（只能有一个冒号）');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(parts[0])) throw invalid('volume 卷名只能是字母、数字、点、下划线、连字符');
    if (parts.length === 2) {
      if (!parts[1].startsWith('/')) throw invalid('volume 挂载路径必须是绝对路径（以 / 开头）');
      if (parts[1].split('/').includes('..')) throw invalid('volume 挂载路径不能包含 ..');
      if (/[\u0000-\u001f]/.test(parts[1])) throw invalid('volume 挂载路径不能包含控制字符');
    }
  }

  if (params.noInternet !== undefined && typeof params.noInternet !== 'boolean') {
    throw invalid('noInternet 必须是布尔值');
  }

  return {
    purpose,
    agent,
    dialogue,
    need,
    timeout,
    template,
    volume,
    noInternet: params.noInternet === true,
    envVars: buildEnvObject(params.env)
  };
}

/**
 * 组装创建请求体。控制面会保留创建时的任意 metadata 键，因此 dialogue 是独立键；
 * note 只放中文用途短句，task 同用途（admin WebUI 渲染），agent 独立。
 */
function buildCreateBody(p) {
  const metadata = {
    agent: p.agent,
    note: p.purpose,
    // 会话 ID 写入 metadata.task（平台任务函数可见；可用 --metadata=task=<ID> 过滤）
    task: p.dialogue,
    cli: 'cube-cli'
  };
  const body = { templateID: p.templateId, timeout: p.timeout, metadata };
  const envVars = p.envVars || {};
  if (Object.keys(envVars).length > 0) body.envVars = envVars;
  if (p.volume) {
    const i = p.volume.indexOf(':');
    const name = i >= 0 ? p.volume.slice(0, i) : p.volume;
    const mountPath = i >= 0 ? p.volume.slice(i + 1) : `/mnt/${name}`;
    body.volumeMounts = [{ name, path: mountPath }];
  }
  if (p.noInternet) body.allow_internet_access = false;
  return JSON.stringify(body);
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
}

function remaining(deadline, cap) {
  return Math.max(1000, Math.min(cap, deadline - Date.now()));
}

async function gatewayPortOf(bin, env, templateId, budgetMs = 20000) {
  const r = await runCli(bin, 'tpl-info', [templateId], { env, timeoutMs: budgetMs });
  const m = String(r.stdout || '').match(/网关推断\s*[:：]\s*(\d+)/);
  if (!m) return '';
  const port = Number(m[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? String(port) : '';
}

/** 解析模板：--template 优先（别名先解析），否则按 --need 动态挑。整个解析受 deadline 约束。 */
async function resolveTemplate(bin, env, p, deadline = Date.now() + 20000) {
  if (deadline - Date.now() < 3000) {
    throw Object.assign(new Error('模板解析超出本次调用预算（宿主单次调用上限 120 秒）'), { code: -32013 });
  }
  if (p.template) {
    const resolved = await runCli(bin, 'tpl-resolve', [p.template], { env, timeoutMs: remaining(deadline, 20000) });
    const id = resolved.exitCode === 0 ? firstLine(resolved.stdout) : '';
    const templateId = /^tpl-[A-Za-z0-9]+$/.test(id) ? id : p.template;
    return { templateId, gatewayPort: await gatewayPortOf(bin, env, templateId, remaining(deadline, 20000)) };
  }
  const pick = await runCli(bin, 'tpl-pick', [`--need=${p.need}`], { env, timeoutMs: remaining(deadline, 20000) });
  const templateId = firstLine(pick.stdout);
  if (pick.exitCode !== 0 || !/^tpl-[A-Za-z0-9]+$/.test(templateId)) {
    throw Object.assign(
      new Error(`没有可用的 READY 模板：${(pick.stdout || pick.stderr || '').trim() || `need=${p.need}`}`),
      { code: -32013 }
    );
  }
  const m = String(pick.stdout || '').match(/网关\s*=\s*(\d+)/);
  const picked = m ? Number(m[1]) : 0;
  const gatewayPort = Number.isInteger(picked) && picked >= 1 && picked <= 65535
    ? String(picked)
    : await gatewayPortOf(bin, env, templateId, remaining(deadline, 20000));
  return { templateId, gatewayPort };
}

function createRawArgs(body) {
  return ['POST', '/sandboxes', `--body=${body}`];
}

function parseCreateResponse(stdout, proxyUrl, gatewayPort) {
  let data;
  try {
    data = JSON.parse(String(stdout || '').trim());
  } catch (err) {
    throw Object.assign(new Error(`控制面返回不是合法 JSON：${String(stdout || '').slice(0, 300)}`), { code: -32014 });
  }
  const sandboxId = asText(data && data.sandboxID).trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sandboxId)) {
    throw Object.assign(new Error(`控制面未返回合法 sandboxID：${String(stdout || '').slice(0, 300)}`), { code: -32014 });
  }
  const gatewayUrl = gatewayPort ? `/sandbox/${sandboxId}/${gatewayPort}/` : '';
  const base = String(proxyUrl || '').replace(/\/+$/, '');
  return { sandboxId, gatewayUrl, aiodBase: gatewayUrl && base ? `${base}${gatewayUrl}` : '' };
}

function assertSandboxId(value, name = 'sandboxId') {
  const sid = asText(value).trim();
  if (!sid) throw invalid(`${name} 必填（可用 cube_ls 查看）`);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sid)) throw invalid(`${name} 格式不合法（应为 8-64 位字母、数字、下划线或连字符）`);
  return sid;
}

function buildExecArgs(params = {}) {
  const sandboxId = assertSandboxId(params.sandboxId);
  const command = asText(params.command).trim();
  if (!command) throw invalid('command 必填：要执行的 shell 命令');
  if (/^(-h|--help|help)(\s|$)/i.test(command)) throw invalid('command 不能是 help/-h/--help（只会打印 CLI 帮助，不会执行）');
  if (command.length > 30000) throw invalid('command 过长（上限 30000 字符）：长脚本请用 cube_write_file 落盘后执行');
  const timeout = strictInt(params.timeoutSeconds, 'timeoutSeconds', SYNC_MAX_SECONDS, 1, SYNC_MAX_SECONDS);
  const args = [sandboxId, `--timeout=${timeout}`];
  if (params.cwd !== undefined && params.cwd !== null && params.cwd !== '') {
    if (typeof params.cwd !== 'string') throw invalid('cwd 必须是字符串');
    if (!params.cwd.startsWith('/')) throw invalid('cwd 必须是绝对路径（以 / 开头）');
    args.push(`--cwd=${params.cwd}`);
  }
  args.push(...envArgs(params.env));
  // `--` 终止 flag 解析：命令以 -- 开头也能原样透传
  args.push('--', command);
  return args;
}

function buildCodeArgs(params = {}) {
  const sandboxId = assertSandboxId(params.sandboxId);
  if (typeof params.code !== 'string') throw invalid('code 必须是字符串');
  if (!params.code.trim()) throw invalid('code 必填：要执行的代码片段');
  if (['-h', '--help', 'help'].includes(params.code.trim().toLowerCase())) throw invalid('code 不能是 help/-h/--help');
  if (params.code.length > 30000) throw invalid('code 过长（上限 30000 字符）：请用 cube_write_file 落盘后执行');
  const language = params.language == null || params.language === '' ? 'python' : String(params.language).toLowerCase();
  const aliases = { python: 'python', py: 'python', js: 'js', javascript: 'js', node: 'js', bash: 'bash', sh: 'bash', shell: 'bash' };
  const lang = aliases[language];
  if (!lang) throw invalid(`language 只支持 python / js / bash（收到 ${language}）`);
  const timeout = strictInt(params.timeoutSeconds, 'timeoutSeconds', SYNC_MAX_SECONDS, 1, SYNC_MAX_SECONDS);
  return [sandboxId, `--lang=${lang}`, `--timeout=${timeout}`, '--', params.code];
}

function buildWriteArgs(params = {}) {
  const sandboxId = assertSandboxId(params.sandboxId);
  const remotePath = asText(params.path).trim();
  if (!remotePath) throw invalid('path 必填：沙箱内的目标路径，例如 /root/app.py');
  if (!remotePath.startsWith('/')) throw invalid('path 必须是沙箱内的绝对路径（以 / 开头）');
  if (/[\u0000-\u001f]/.test(remotePath)) throw invalid('path 不能包含控制字符');
  if (typeof params.content !== 'string') throw invalid('content 必填：要写入的文件内容（字符串）');
  const bytes = Buffer.byteLength(params.content, 'utf8');
  if (bytes > MAX_WRITE_BYTES) {
    throw invalid(`content 过大（${bytes} 字节，上限 ${MAX_WRITE_BYTES}）：请分片多次调用 cube_write_file 写入`);
  }
  return { args: [sandboxId, '-', remotePath], content: params.content, bytes };
}

function buildReadArgs(params = {}) {
  const sandboxId = assertSandboxId(params.sandboxId);
  const remotePath = asText(params.path).trim();
  if (!remotePath) throw invalid('path 必填：沙箱内的文件路径');
  if (!remotePath.startsWith('/')) throw invalid('path 必须是沙箱内的绝对路径（以 / 开头）');
  if (/[\u0000-\u001f]/.test(remotePath)) throw invalid('path 不能包含控制字符');
  const maxBytes = strictInt(params.maxBytes, 'maxBytes', MAX_OUTPUT, 1024, MAX_READ_BYTES);
  return { args: [sandboxId, remotePath], maxBytes };
}

function buildLsArgs(params = {}) {
  const args = [];
  if (params.metadata !== undefined && params.metadata !== null && params.metadata !== '') {
    if (typeof params.metadata !== 'string') throw invalid('metadata 必须是字符串，例如 task=xxx');
    const metadata = params.metadata.trim();
    if (!/^[A-Za-z0-9_.:-]+=[^\u0000-\u001f]+(,[A-Za-z0-9_.:-]+=[^\u0000-\u001f]+)*$/.test(metadata)) {
      throw invalid('metadata 格式应为 key=value 或 key1=v1,key2=v2');
    }
    args.push(`--metadata=${metadata}`);
  }
  if (params.state !== undefined && params.state !== null && params.state !== '') {
    if (typeof params.state !== 'string' || !/^[a-z]+$/.test(params.state)) throw invalid('state 只能是 running / paused 等小写状态名');
    args.push(`--state=${params.state}`);
  }
  const limit = strictInt(params.limit, 'limit', 0, 0, 1000);
  if (limit > 0) args.push(`--limit=${limit}`);
  // limit 只有 v2 接口生效，自动带上 --v2，避免“传了 limit 却仍返回 200 条”
  if (params.v2 === true || limit > 0) args.push('--v2');
  return args;
}

function normalizeApiPath(rawPath) {
  let s = String(rawPath || '').trim();
  try { s = decodeURIComponent(s); } catch (_) {}
  s = s.split(/[?#]/)[0].replace(/\\/g, '/');
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return `/${parts.join('/')}`.toLowerCase();
}

/** 取位置参数（跳过 flag 与 `--` 终止符），避免前置 flag 绕过命令判定。 */
function positionals(args) {
  const out = [];
  let end = false;
  for (const a of args) {
    const s = String(a);
    if (!end && s === '--') { end = true; continue; }
    if (!end && s.startsWith('-') && s !== '-') continue;
    out.push(s);
  }
  return out;
}

/** 创建类命令一律拦截：必须走 cube_new（元数据完整）；同时封住宿主文件读取。 */
function assertCreateInvocation(cmd, args) {
  if (cmd === 'new') {
    throw invalid('创建沙箱请用 cube_new（会自动写入 dialogue/note/agent 元数据），不要用 cube_run cmd=new');
  }
  if (cmd === 'clone') {
    throw invalid('clone 会创建沙箱但元数据不可控；需要克隆请先用 cube_run 打快照，再用 cube_new 加 --template');
  }
  if (cmd === 'write' || cmd === 'write-files' || cmd === 'write_files') {
    throw invalid('cube_run 不能从宿主本地文件上传；请用 cube_write_file 传 content（stdin 通道）');
  }
  if (cmd === 'raw') {
    for (const a of args) {
      if (/^--body=(@|-)/.test(String(a))) throw invalid('raw 禁止 --body=@文件 或 --body=-（读取宿主/标准输入内容）');
    }
    const pos = positionals(args);
    const method = String(pos[0] || '').toUpperCase();
    const target = normalizeApiPath(pos[1]);
    if (['POST', 'PUT', 'PATCH'].includes(method) && /^\/(v2\/)?sandboxes$/.test(target)) {
      throw invalid('不允许通过 cube_run raw 创建沙箱；请用 cube_new（会写入 dialogue/note/agent 元数据）');
    }
  }
}

/** 拦截裸 --env=NAME：CLI 会从宿主进程环境读取同名变量，可能把密钥送进沙箱。 */
function assertNoBareEnvArgs(args) {
  for (const a of args) {
    if (typeof a !== 'string') continue;
    if (/^--env=[^=]+$/.test(a)) {
      throw invalid('--env=NAME（不带值）会从宿主环境读取变量，可能把密钥送进沙箱；请用 --env=NAME=VALUE');
    }
  }
}

// ---------------- 进程执行 ----------------

function spawnCli(bin, args, { env, stdinData, maxOutput, timeoutMs, markers = true, trim = true } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      env,
      stdio: [stdinData === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    const limit = Math.max(1024, Number(maxOutput) || MAX_OUTPUT);
    const chunks = { out: [], err: [] };
    const bytes = { out: 0, err: 0 };
    const truncated = { out: false, err: false };
    let settled = false;
    let timer = null;

    const push = (which, d) => {
      if (bytes[which] >= limit) {
        truncated[which] = true;
        return;
      }
      const room = limit - bytes[which];
      const buf = d.length > room ? Buffer.from(d.subarray(0, room)) : d;
      chunks[which].push(buf);
      bytes[which] += buf.length;
      if (d.length > room) truncated[which] = true;
    };

    const textOf = (which) => Buffer.concat(chunks[which]).toString('utf-8');
    const build = (exitCode) => {
      const out = `${textOf('out')}${markers && truncated.out ? '\n[... stdout truncated ...]' : ''}`;
      const err = `${textOf('err')}${markers && truncated.err ? '\n[... stderr truncated ...]' : ''}`;
      return {
        stdout: trim ? out.trimEnd() : out,
        stderr: trim ? err.trimEnd() : err,
        exitCode,
        stdoutTruncated: truncated.out,
        stderrTruncated: truncated.err
      };
    };

    const finish = (result, err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        const result = build(124);
        finish({
          ...result,
          stderr: `${result.stderr}${result.stderr ? '\n' : ''}[cube-worker] 本地等待超时，已终止 CLI 进程`
        });
      }, timeoutMs);
    }

    proc.stdout.on('data', (d) => push('out', d));
    proc.stderr.on('data', (d) => push('err', d));
    proc.on('error', (err) => {
      log(`Process error: ${err.message}`);
      finish(null, new Error(`启动 CLI 失败: ${err.message}`));
    });
    proc.on('close', (code) => finish(build(code == null ? 1 : code)));

    if (stdinData !== undefined) {
      proc.stdin.on('error', () => {});
      proc.stdin.end(stdinData);
    }
  });
}

async function runCli(bin, cmd, args, options = {}) {
  log(`Spawning ${bin} ${cmd}`);
  return spawnCli(bin, [cmd, ...args], options);
}

function failedCliMessage(result) {
  const parts = [];
  const out = (result.stdout || '').trim();
  const err = (result.stderr || '').trim();
  if (out) parts.push(out);
  if (err) parts.push(err);
  return `cube-cli 退出码 ${result.exitCode}${parts.length ? `：${parts.join('\n')}` : ''}`;
}

function extractCreateResult(task) {
  for (let i = task.logs.length - 1; i >= 0; i -= 1) {
    const m = task.logs[i].match(/\{[^{}]*"sandboxID"[^{}]*\}/);
    if (!m) continue;
    try {
      const data = JSON.parse(m[0]);
      if (data && typeof data.sandboxID === 'string') task.sandboxId = data.sandboxID;
      return;
    } catch (_) {}
  }
}

function appendTaskLine(task, line) {
  task.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  if (task.logs.length > 2000) {
    task.logs.shift();
    task.dropped += 1;
  }
}

function appendTaskChunk(task, text) {
  task.pending += text;
  const lines = task.pending.split('\n');
  task.pending = lines.pop();
  for (const l of lines) appendTaskLine(task, l);
  if (task.pending.length > 65536) {
    appendTaskLine(task, `${task.pending.slice(0, 65536)}…`);
    task.pending = task.pending.slice(65536);
  }
}

function flushTask(task) {
  if (task.pending) {
    appendTaskLine(task, task.pending);
    task.pending = '';
  }
}

function attachTaskProcess(task, proc) {
  task.process = proc;
  proc.stdout.on('data', (d) => appendTaskChunk(task, d.toString('utf-8')));
  proc.stderr.on('data', (d) => appendTaskChunk(task, d.toString('utf-8')));
  proc.on('close', (code) => {
    flushTask(task);
    task.completed = true;
    task.exitCode = code;
    if (task.cmd === 'new') extractCreateResult(task);
    log(`Task ${task.taskId} finished with code ${code}`);
  });
  proc.on('error', (err) => {
    flushTask(task);
    task.completed = true;
    task.exitCode = -1;
    appendTaskLine(task, `Error: ${err.message}`);
  });
}

// ---------------- JSON-RPC 分发 ----------------

async function handle(request) {
  const { method } = request;
  const rawParams = request.params;
  if (rawParams !== undefined && (rawParams === null || typeof rawParams !== 'object' || Array.isArray(rawParams))) {
    throw invalid('params 必须是对象');
  }
  const params = rawParams || {};
  const bin = findBinary();
  const env = buildEnv(request);

  if (method === 'cube/run') {
    const cmd = oneLine(params.cmd);
    if (!cmd) throw invalid('cmd 必填');
    assertCreateInvocation(cmd, Array.isArray(params.args) ? params.args : []);
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    assertNoBareEnvArgs(args);
    return { result: await runCli(bin, cmd, args, { env, timeoutMs: 80000 }) };
  }

  if (method === 'cube/health') {
    const [health, version] = await Promise.all([
      runCli(bin, 'health', [], { env, timeoutMs: 30000 }),
      runCli(bin, 'version', [], { env, timeoutMs: 30000 })
    ]);
    return {
      result: {
        healthy: health.exitCode === 0,
        exitCode: health.exitCode,
        health: { stdout: health.stdout, stderr: health.stderr, exitCode: health.exitCode },
        version: { stdout: version.stdout, stderr: version.stderr, exitCode: version.exitCode }
      }
    };
  }

  if (method === 'cube/new') {
    const p = normalizeNewParams(params);
    const deadline = Date.now() + 110000;
    const { templateId, gatewayPort } = await resolveTemplate(bin, env, p, deadline);
    const body = buildCreateBody({ ...p, templateId });
    const run = await runCli(bin, 'raw', createRawArgs(body), {
      env,
      timeoutMs: remaining(deadline, 110000),
      maxOutput: MAX_CREATE_OUTPUT
    });
    if (run.exitCode !== 0) throw Object.assign(new Error(failedCliMessage(run)), { code: -32010 });
    if (run.stdoutTruncated) {
      throw Object.assign(new Error('创建响应超过 2MiB 被截断，无法确认结果；请用 cube_ls metadata=task=... 核对后再决定是否 cube_rm'), { code: -32015 });
    }
    let parsed;
    try {
      parsed = parseCreateResponse(run.stdout, env.CUBESANDBOX_PROXY_URL, gatewayPort);
    } catch (err) {
      throw Object.assign(
        new Error(`${err.message}；沙箱可能已经创建，请先用 cube_ls metadata=task=${p.dialogue} 核对再决定 cube_rm，避免重复创建`),
        { code: err.code || -32014 }
      );
    }
    const warnings = gatewayPort ? [] : ['未解析到模板网关端口，gatewayUrl/aiodBase 为空；可用 cube_run ports <sandboxId> 查看实际端口'];
    return {
      result: {
        sandboxId: parsed.sandboxId,
        templateId,
        gatewayUrl: parsed.gatewayUrl,
        aiodBase: parsed.aiodBase,
        metadata: { agent: p.agent, note: p.purpose, task: p.dialogue, cli: 'cube-cli' },
        warnings,
        stdout: run.stdout,
        stderr: run.stderr,
        exitCode: run.exitCode
      }
    };
  }

  if (method === 'cube/exec') {
    const args = buildExecArgs(params);
    return { result: await runCli(bin, 'exec', args, { env, timeoutMs: 110000 }) };
  }

  if (method === 'cube/code') {
    const args = buildCodeArgs(params);
    return { result: await runCli(bin, 'code', args, { env, timeoutMs: 110000 }) };
  }

  if (method === 'cube/write') {
    const { args, content, bytes } = buildWriteArgs(params);
    const run = await runCli(bin, 'write', args, { env, stdinData: content, timeoutMs: 110000 });
    if (run.exitCode !== 0) throw Object.assign(new Error(failedCliMessage(run)), { code: -32011 });
    return { result: { path: asText(params.path).trim(), bytes, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode } };
  }

  if (method === 'cube/read') {
    const { args, maxBytes } = buildReadArgs(params);
    const run = await runCli(bin, 'cat', args, { env, maxOutput: maxBytes, timeoutMs: 110000, markers: false, trim: false });
    if (run.exitCode !== 0) throw Object.assign(new Error(failedCliMessage(run)), { code: -32012 });
    // 按字节截断可能切在多字节字符中间，去掉末尾替换字符，保证字节数不超上限
    const content = run.stdoutTruncated ? run.stdout.replace(/�$/, '') : run.stdout;
    return {
      result: {
        path: asText(params.path).trim(),
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        truncated: !!run.stdoutTruncated,
        exitCode: run.exitCode
      }
    };
  }

  if (method === 'cube/ls') {
    const args = buildLsArgs(params);
    return { result: await runCli(bin, 'ls', args, { env, timeoutMs: 55000 }) };
  }

  if (method === 'cube/rm') {
    const sandboxId = assertSandboxId(params.sandboxId);
    return { result: await runCli(bin, 'rm', [sandboxId], { env, timeoutMs: 85000 }) };
  }

  if (method === 'cube/submit') {
    const cmd = oneLine(params.cmd);
    if (!cmd) throw invalid('cmd 必填');
    let prepared = null;
    let args = [];
    if (cmd === 'new') prepared = normalizeNewParams(params);
    else {
      args = Array.isArray(params.args) ? params.args.map(String) : [];
      assertCreateInvocation(cmd, args);
      assertNoBareEnvArgs(args);
    }
    const taskId = `cube_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const taskRecord = {
      taskId,
      cmd,
      args,
      process: null,
      logs: [],
      pending: '',
      dropped: 0,
      exitCode: null,
      completed: false,
      cancelled: false,
      startTime: Date.now()
    };
    if (!recordTask(taskId, taskRecord)) {
      throw Object.assign(new Error('后台任务已达上限 50，请先用 cube_kill 或等任务结束后重试'), { code: -32016 });
    }
    if (prepared) {
      // 立即返回 taskId；模板解析与创建放到后台，避免宿主 60s 超时
      (async () => {
        try {
          const deadline = Date.now() + 110000;
          const { templateId, gatewayPort } = await resolveTemplate(bin, env, prepared, deadline);
          taskRecord.templateId = templateId;
          taskRecord.gatewayPort = gatewayPort;
          appendTaskLine(taskRecord, `[template] ${templateId} 网关=${gatewayPort || '?'}`);
          if (taskRecord.cancelled) {
            taskRecord.completed = true;
            taskRecord.exitCode = 130;
            return;
          }
          const createArgs = createRawArgs(buildCreateBody({ ...prepared, templateId }));
          taskRecord.args = createArgs;
          const proc = spawn(bin, ['raw', ...createArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
          attachTaskProcess(taskRecord, proc);
        } catch (err) {
          appendTaskLine(taskRecord, `Error: ${err.message}`);
          taskRecord.completed = true;
          taskRecord.exitCode = -1;
        }
      })();
    } else {
      try {
        const proc = spawn(bin, [cmd, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        attachTaskProcess(taskRecord, proc);
      } catch (err) {
        appendTaskLine(taskRecord, `Error: ${err.message}`);
        taskRecord.completed = true;
        taskRecord.exitCode = -1;
      }
    }
    return {
      result: {
        taskId,
        cmd,
        status: 'running',
        message: `异步任务已提交 (ID: ${taskId})；请每 60-90 秒 cube_log 一次，避免 worker 空闲回收`
      }
    };
  }

  if (method === 'cube/log') {
    const { taskId } = params;
    const task = tasks.get(taskId);
    if (!task) throw Object.assign(new Error(`任务不存在: ${taskId}`), { code: -32002 });
    const total = task.dropped + task.logs.length;
    const start = toInt(params.offset, 0, 0, total);
    let logs;
    let droppedLines = 0;
    if (start < task.dropped) {
      logs = task.logs.slice();
      droppedLines = task.dropped - start;
    } else {
      logs = task.logs.slice(start - task.dropped);
    }
    return {
      result: {
        taskId,
        status: task.completed ? 'completed' : 'running',
        completed: task.completed,
        exitCode: task.exitCode,
        logs,
        nextOffset: total,
        totalLines: total,
        droppedLines,
        ...(task.sandboxId ? { sandboxId: task.sandboxId } : {}),
        ...(task.templateId ? { templateId: task.templateId } : {}),
        ...(task.gatewayPort ? { gatewayPort: task.gatewayPort } : {})
      }
    };
  }

  if (method === 'cube/kill') {
    const { taskId } = params;
    const task = tasks.get(taskId);
    if (!task) throw Object.assign(new Error(`任务不存在: ${taskId}`), { code: -32002 });
    const alreadyCompleted = task.completed;
    let killed = false;
    if (!task.completed) {
      task.cancelled = true;
      if (task.process) {
        try {
          task.process.kill('SIGTERM');
          killed = true;
        } catch (e) {
          try { task.process.kill('SIGKILL'); killed = true; } catch (_) {}
        }
        const escalation = setTimeout(() => {
          if (!task.completed && task.process) {
            try { task.process.kill('SIGKILL'); } catch (_) {}
          }
        }, 5000);
        if (typeof escalation.unref === 'function') escalation.unref();
      } else {
        // 还在模板解析阶段：标记取消，后台流程会在下一个检查点退出
        task.completed = true;
        task.exitCode = 130;
        killed = true;
      }
    }
    return { result: { taskId, killed, alreadyCompleted, cancelled: task.cancelled === true } };
  }

  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

let inflight = 0;
const MAX_INFLIGHT = 16;

function startServer() {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line || !line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch (err) {
      reply(null, null, { code: -32700, message: 'JSON 解析失败：请求行不是合法 JSON' });
      return;
    }
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.method !== 'string') {
      reply(request && request.id !== undefined ? request.id : null, null, { code: -32600, message: '无效请求：缺少 method' });
      return;
    }
    const { id } = request;
    if (inflight >= MAX_INFLIGHT) {
      reply(id, null, { code: -32017, message: `并发调用过多（上限 ${MAX_INFLIGHT}），请稍后重试` });
      return;
    }
    inflight += 1;
    handle(request)
      .then(({ result }) => reply(id, result))
      .catch((err) => {
        if (err && typeof err.code === 'number' && err.message) {
          reply(id, null, { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) });
          return;
        }
        log(`Handler error: ${err && err.message ? err.message : err}`);
        reply(id, null, { code: -32000, message: err && err.message ? err.message : String(err) });
      })
      .finally(() => { inflight -= 1; });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  normalizeNewParams,
  buildCreateBody,
  parseCreateResponse,
  assertCreateInvocation,
  assertNoBareEnvArgs,
  assertSandboxId,
  buildExecArgs,
  buildCodeArgs,
  buildWriteArgs,
  buildReadArgs,
  buildLsArgs,
  MAX_OUTPUT,
  MAX_WRITE_BYTES,
  SYNC_MAX_SECONDS
};
