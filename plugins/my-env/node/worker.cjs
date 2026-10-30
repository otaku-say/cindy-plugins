// plugins/my-env/node/worker.cjs —— 随包 Node 工作进程 (JSON-RPC 2.0 stdio)
// 职责：
//   1. 本地持久化环境变量存储（唯一数据源：设置页与 Agent 都经这里读写）
//   2. 安全向目标文件写入环境变量（.env / shell / json，对话零明文）
//   3. 安全执行本地命令（进程级注入 process.env，输出自动脱敏）
//   4. 无明文凭据自检（只回状态码与账号元数据）
//
// v0.3.0 变更要点：
//   - 存储文件/目录 0600/0700、写前加锁、保留一份 .bak
//   - 敏感值不再镜像到宿主 /kv（旧版会把全部明文复制进 KV）
//   - env/set 支持 value_from（file / env），避免明文进对话参数
//   - env/write_file 的 keys 变必填、默认不覆盖、拒绝软链接与越界路径、创建即 0600
//   - env/exec 超时杀进程树并回传已产生的输出；shell 模式按平台给参数加引号
//   - env/probe 的 keys 变必填，默认拒绝内网/回环目标，支持 allowed_hosts 白名单
//   - 脱敏按长度降序替换并回传命中的键名

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MAX_EXEC_TIMEOUT_MS = 110000; // 宿主单次 RPC 硬上限 120000，留出余量
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PROBE_KEYS = 20;
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10000;

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  try {
    Atomics.wait(SLEEP, 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 兜底自旋 */ }
  }
}

function reply(id, result, error) {
  const resp = { jsonrpc: '2.0', id };
  if (error) {
    resp.error = typeof error === 'string' ? { code: -32000, message: error } : error;
  } else {
    resp.result = result;
  }
  process.stdout.write(JSON.stringify(resp) + '\n');
}

function log(text) {
  process.stderr.write('[my-env-worker] ' + text + '\n');
}

// ---------------------------------------------------------------------------
// 跨平台数据目录发现 (Windows / macOS / Linux) 与权限
// ---------------------------------------------------------------------------
function cindyHomeCandidates() {
  const home = os.homedir();
  const out = [];
  if (process.env.CINDY_HOME) out.push(process.env.CINDY_HOME);
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'CindyGlobal'));
  if (process.platform === 'darwin') out.push(path.join(home, 'Library', 'Application Support', 'CindyGlobal'));
  if (process.env.XDG_CONFIG_HOME) out.push(path.join(process.env.XDG_CONFIG_HOME, 'CindyGlobal'));
  out.push(path.join(home, '.config', 'CindyGlobal'));
  out.push(path.join(home, 'AppData', 'Roaming', 'CindyGlobal'));
  return [...new Set(out)];
}

function resolveStorageDir() {
  for (const candidate of cindyHomeCandidates()) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return path.join(candidate, 'data', 'my-env');
      }
    } catch (_) {}
  }
  return path.join(os.homedir(), '.cindy', 'my-env');
}

function getStorageFile() {
  return path.join(resolveStorageDir(), 'variables.json');
}

function ensureStorageDir() {
  const dir = resolveStorageDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (_) {}
  }
  return dir;
}

/* 纵深的原子写：锁 → .bak → 0o600 临时文件 → rename。
 * 锁是跨进程的（设置页与 Agent 可能同时写），进程内不需要额外互斥。 */
function withStoreLock(fn) {
  ensureStorageDir();
  const lockFile = getStorageFile() + '.lock';
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (_) {
        continue;
      }
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new Error('存储正被另一个进程写入，请稍后重试');
      }
      sleepSync(30);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch (_) {}
  }
}

function assertStoreFileSafe() {
  const file = getStorageFile();
  if (!fs.existsSync(file)) return;
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) throw new Error('存储文件是符号链接，拒绝写入: ' + file);
  if (!st.isFile()) throw new Error('存储路径不是普通文件，拒绝写入: ' + file);
}

function readStore() {
  const file = getStorageFile();
  if (!fs.existsSync(file)) {
    return { version: 2, variables: {} };
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { version: 2, variables: {} };
    }
    if (!data.variables || typeof data.variables !== 'object' || Array.isArray(data.variables)) {
      data.variables = {};
    }
    data.version = 2;
    return data;
  } catch (err) {
    log('读取 variables.json 出错，回退为空: ' + err.message);
    return { version: 2, variables: {} };
  }
}

function writeStoreNow(store) {
  assertStoreFileSafe();
  const file = getStorageFile();
  const dir = ensureStorageDir();

  // 保留一份上一版，误删/误导入可人工回滚
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, file + '.bak');
      if (process.platform !== 'win32') fs.chmodSync(file + '.bak', 0o600);
    } catch (err) {
      log('备份旧存储失败（继续写入）: ' + err.message);
    }
  }

  const tmp = path.join(dir, '.variables.tmp-' + randomUUID());
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {}
  }
}

function saveStore(store) {
  withStoreLock(() => writeStoreNow(store));
}

function assertKey(key) {
  if (!key) throw new Error('key 不能为空');
  if (!KEY_RE.test(key)) {
    throw new Error('key 命名不规范（仅字母、数字、下划线，且不能以数字开头）');
  }
  if (RESERVED.has(key)) throw new Error('key 为保留名: ' + key);
}

function isSensitive(entry) {
  return entry.sensitive !== false;
}

function maskOf(entry) {
  if (!entry || !entry.value) return '';
  if (isSensitive(entry)) return '••••••';
  return entry.value.length <= 6 ? '••••••' : entry.value.slice(0, 3) + '…';
}

function formatDotenv(vars) {
  const lines = [];
  for (const [k, v] of Object.entries(vars)) {
    const escaped = String(v)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
    lines.push(`${k}="${escaped}"`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function formatShell(vars) {
  const lines = [];
  for (const [k, v] of Object.entries(vars)) {
    const escaped = String(v)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
    lines.push(`export ${k}="${escaped}"`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function formatJson(vars) {
  return JSON.stringify(vars, null, 2) + '\n';
}

/* 脱敏：按长度降序替换，回传命中的键名（只键名，不含值）。
 * 变长串先替换，避免短串命中后把长串切成 "[REDACTED_SECRET]尾缀" 残片。 */
function redactOutput(text, entries) {
  if (!text || typeof text !== 'string') return { text: '', hits: 0, keys: [] };
  const list = entries
    .filter((e) => e && typeof e.value === 'string' && e.value.length >= 4)
    .sort((a, b) => b.value.length - a.value.length);
  let result = text;
  let hits = 0;
  const keys = [];
  for (const entry of list) {
    const parts = result.split(entry.value);
    if (parts.length > 1) {
      hits += parts.length - 1;
      result = parts.join('[REDACTED_SECRET]');
      keys.push(entry.key);
    }
  }
  return { text: result, hits, keys: [...new Set(keys)] };
}

function sensitiveEntries(allVars) {
  return Object.entries(allVars)
    .filter(([, entry]) => entry && isSensitive(entry) && typeof entry.value === 'string')
    .map(([key, entry]) => ({ key, value: entry.value }));
}

// ---------------------------------------------------------------------------
// 凭据自检（只回白名单字段，绝不回传响应体）
// ---------------------------------------------------------------------------
function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
    return false;
  }
  return false;
}

async function assertProbeTarget(u, params) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const allow = Array.isArray(params?.allowed_hosts)
    ? params.allowed_hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean)
    : [];
  if (allow.length > 0 && !allow.includes(host.toLowerCase())) {
    throw new Error(`目标主机不在 allowed_hosts 白名单内: ${host}`);
  }
  if (params?.allow_private === true) return host;

  let addrs = [];
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
    } catch (err) {
      throw new Error('无法解析目标主机: ' + host);
    }
  }
  for (const addr of addrs) {
    if (isPrivateAddress(addr)) {
      throw new Error(`目标解析到内网/本机地址（${addr}），如确需探测请显式传 allow_private: true`);
    }
  }
  return host;
}

function httpJson(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      resolve({ status: 0, headers: {}, json: null, error: '非法 URL: ' + String((e && e.message) || e) });
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      resolve({ status: 0, headers: {}, json: null, error: '仅支持 http/https' });
      return;
    }
    const mod = require(u.protocol === 'http:' ? 'node:http' : 'node:https');
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = mod.request(u, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (d) => { if (body.length < 64 * 1024) body += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) { json = null; }
        done({ status: res.statusCode || 0, headers: res.headers || {}, json });
      });
    });
    req.on('error', (e) => done({ status: 0, headers: {}, json: null, error: String((e && e.message) || e) }));
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(); } catch (_) {}
      done({ status: 0, headers: {}, json: null, error: 'timeout ' + timeoutMs + 'ms' });
    });
    req.end();
  });
}

async function probeGithub(key, token, params, timeoutMs) {
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cindy-my-env-probe'
  };
  const me = await httpJson('https://api.github.com/user', headers, timeoutMs);
  const out = {
    key,
    provider: 'github',
    ok: me.status === 200,
    status: me.status,
    login: (me.json && me.json.login) || null,
    scopes: String(me.headers['x-oauth-scopes'] || ''),
    error: me.error || (me.status === 200 ? null : 'HTTP ' + me.status)
  };
  const repo = String(params?.repo || '').trim();
  if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
    const r = await httpJson('https://api.github.com/repos/' + repo, headers, timeoutMs);
    const pm = (r.json && r.json.permissions) || {};
    out.repo = {
      name: repo,
      status: r.status,
      push: pm.push === true,
      admin: pm.admin === true,
      default_branch: (r.json && r.json.default_branch) || null
    };
    if (r.status !== 200 || pm.push !== true) out.ok = false;
  }
  return out;
}

async function probeHttp(key, token, params, timeoutMs) {
  const url = String(params?.url || '').trim();
  if (!url) return { key, provider: 'http', ok: false, status: 0, error: 'http 模式必须提供 url' };
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return { key, provider: 'http', ok: false, status: 0, error: '非法 URL' };
  }
  await assertProbeTarget(u, params);
  const headerName = String(params?.header || 'Authorization').trim() || 'Authorization';
  const template = String(params?.header_template || 'Bearer {token}');
  const headers = { 'User-Agent': 'cindy-my-env-probe' };
  headers[headerName] = template.split('{token}').join(token);
  const expect = Array.isArray(params?.ok_status) && params.ok_status.length
    ? params.ok_status.map((x) => Number(x)).filter((x) => Number.isInteger(x))
    : [200];
  const r = await httpJson(url, headers, timeoutMs);
  return {
    key,
    provider: 'http',
    host: u.host,
    ok: expect.includes(r.status),
    status: r.status,
    expected: expect,
    error: r.error || (expect.includes(r.status) ? null : 'HTTP ' + r.status)
  };
}

// ---------------------------------------------------------------------------
// env/exec 辅助
// ---------------------------------------------------------------------------
/* shell 模式下的参数引用：
 *   - 含空白/引号/重定向/通配符的参数加引号，避免被拆成多个参数；
 *   - 不加引号保留 $VAR / %VAR% 展开语义（shell 模式的本意）；
 *   - 需要完全掌控引号时请直接传 command_line。 */
function quoteForShell(arg, isWin) {
  const s = String(arg);
  if (isWin) {
    return /[\s"&|<>^()%!]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  return /[\s'"&|<>;*?[\]{}#~!]/.test(s) ? "'" + s.replace(/'/g, "'\\''") + "'" : s;
}

function killTree(proc, isWin) {
  if (!proc || proc.pid == null) return;
  if (isWin) {
    try {
      const k = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => {});
    } catch (_) {
      try { proc.kill(); } catch (_) {}
    }
    return;
  }
  const signalGroup = (sig) => {
    try {
      process.kill(-proc.pid, sig);
      return true;
    } catch (_) {
      return false;
    }
  };
  if (!signalGroup('SIGTERM')) {
    try { proc.kill('SIGTERM'); } catch (_) {}
  }
  const hard = setTimeout(() => {
    if (!signalGroup('SIGKILL')) {
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
  }, 2000);
  if (hard.unref) hard.unref();
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 方法实现
// ---------------------------------------------------------------------------
const methods = {
  'env/list': (params) => {
    const store = readStore();
    const vars = store.variables;
    const q = String(params?.query || '').trim().toLowerCase();

    const wantKeys = Array.isArray(params?.keys)
      ? params.keys.map((k) => String(k).trim()).filter(Boolean)
      : [];
    const wanted = wantKeys.length > 0 ? new Set(wantKeys) : null;
    const missing = wanted ? wantKeys.filter((k) => !Object.prototype.hasOwnProperty.call(vars, k)) : [];

    const filtered = Object.keys(vars)
      .filter((k) => (wanted ? wanted.has(k) : true))
      .filter((k) => {
        if (!q) return true;
        return k.toLowerCase().indexOf(q) >= 0 || (vars[k].memo || '').toLowerCase().indexOf(q) >= 0;
      })
      .sort((a, b) => a.localeCompare(b));

    const limit = Math.min(Math.max(Number(params?.limit) || 100, 1), 500);
    const offset = Math.max(Number(params?.offset) || 0, 0);
    const page = filtered.slice(offset, offset + limit);

    return {
      total: filtered.length,
      returned: page.length,
      offset,
      limit,
      hasMore: offset + page.length < filtered.length,
      items: page.map((k) => ({
        key: k,
        maskedValue: maskOf(vars[k]),
        memo: vars[k].memo || '',
        sensitive: isSensitive(vars[k]),
        updatedAt: vars[k].updatedAt || 0
      })),
      missing: missing.length ? missing : undefined
    };
  },

  'env/get': (params) => {
    const key = String(params?.key || '').trim();
    assertKey(key);
    const store = readStore();
    if (!Object.prototype.hasOwnProperty.call(store.variables, key)) {
      throw new Error('环境变量不存在: ' + key);
    }
    const entry = store.variables[key];

    /* 敏感项默认绝不返回明文：返回值会整条落进 Agent 的对话上下文并被持久化。
     * 历史上两次 GitHub PAT 泄漏就是这么发生的。 */
    if (isSensitive(entry) && params?.allow_plaintext !== true) {
      return {
        key,
        value: null,
        memo: entry.memo || '',
        sensitive: true,
        denied: 'SENSITIVE_PLAINTEXT_BLOCKED',
        maskedValue: maskOf(entry),
        hint: '敏感项禁止明文读取（明文会进入会话记录）。请改用 env_exec 进程注入、env_write_file 落盘，或用 env_probe 探测可用性；确需明文时必须显式传 allow_plaintext: true。',
        updatedAt: entry.updatedAt || 0
      };
    }

    return {
      key,
      value: entry.value,
      memo: entry.memo || '',
      sensitive: isSensitive(entry),
      updatedAt: entry.updatedAt || 0
    };
  },

  'env/set': (params) => {
    const key = String(params?.key || '').trim();
    assertKey(key);

    /* 值来源优先级：value_from.file > value_from.env > value(inline)。
     * inline 值会经过 Agent 工具参数进入会话记录，因此回执里带 warning。 */
    let value;
    let source = 'inline';
    const vf = params?.value_from;
    if (vf && typeof vf === 'object') {
      if (typeof vf.file === 'string' && vf.file.trim()) {
        const p = path.resolve(vf.file.trim());
        try {
          value = fs.readFileSync(p, 'utf8').replace(/\r?\n$/, '');
        } catch (err) {
          throw new Error('读取 value_from.file 失败: ' + p + ' (' + (err.code || err.message) + ')');
        }
        source = 'file';
      } else if (typeof vf.env === 'string' && vf.env.trim()) {
        const name = vf.env.trim();
        if (!(name in process.env)) throw new Error('value_from.env 找不到该环境变量: ' + name);
        value = String(process.env[name]);
        source = 'env';
      }
    }
    if (value === undefined) {
      if (params?.value === undefined || params?.value === null) {
        throw new Error('缺少必须参数: value（或 value_from.file / value_from.env）');
      }
      value = String(params.value);
      source = 'inline';
    }

    const store = readStore();
    const vars = store.variables;
    const existing = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : null;
    const sensitive = params?.sensitive === undefined
      ? (existing ? isSensitive(existing) : true)
      : params.sensitive !== false;
    vars[key] = { value, memo: String(params.memo || '').trim(), sensitive, updatedAt: Date.now() };
    saveStore(store);

    return {
      key,
      message: (existing ? '已更新 ' : '已保存 ') + key,
      maskedValue: maskOf(vars[key]),
      sensitive,
      value_source: source,
      warning: source === 'inline'
        ? '值以明文出现在工具参数中，已进入本次会话记录。下次请用 value_from.file / value_from.env，或让用户在设置页填写。'
        : undefined
    };
  },

  'env/delete': (params) => {
    const key = String(params?.key || '').trim();
    assertKey(key);
    const store = readStore();
    if (!Object.prototype.hasOwnProperty.call(store.variables, key)) {
      throw new Error('环境变量不存在: ' + key);
    }
    delete store.variables[key];
    saveStore(store);
    return { key, deleted: true };
  },

  'env/import': (params) => {
    const incoming = params?.variables;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw new Error('variables 必须是对象');
    }
    const overwrite = params?.overwrite === true;
    const store = readStore();
    const vars = store.variables;
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const invalid = [];

    for (const [key, entry] of Object.entries(incoming)) {
      if (!KEY_RE.test(key) || RESERVED.has(key)) {
        invalid.push(key);
        continue;
      }
      const raw = typeof entry === 'string' ? { value: entry } : entry;
      if (!raw || typeof raw !== 'object' || typeof raw.value !== 'string' || raw.value === '') {
        invalid.push(key);
        continue;
      }
      const exists = Object.prototype.hasOwnProperty.call(vars, key);
      if (exists && !overwrite) {
        skipped++;
        continue;
      }
      vars[key] = {
        value: raw.value,
        memo: String(raw.memo || '').trim(),
        sensitive: raw.sensitive !== false,
        updatedAt: typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt) ? raw.updatedAt : Date.now()
      };
      if (exists) updated++;
      else added++;
    }
    if (added + updated > 0) saveStore(store);
    return { ok: true, added, updated, skipped, invalid };
  },

  'env/writeFile': (params) => {
    const targetPath = String(params?.target_path || '').trim();
    if (!targetPath) throw new Error('缺少必需参数: target_path');

    const requestedKeys = Array.isArray(params.keys) ? params.keys.map((k) => String(k).trim()).filter(Boolean) : [];
    if (requestedKeys.length === 0) {
      throw new Error('keys 必填：请显式列出要写入的变量，避免把全部凭据一次性落盘');
    }

    /* 不做「必须在 cwd 内」的限制：worker 的 cwd 是宿主应用目录（Windows 上是 Temp），
     * 不是 Agent 的任务工作目录，按它做白名单只会把正常写入全堵住。安全边界放在：
     * keys 必填、默认不覆盖、拒绝符号链接、只写普通文件；回执总是回传绝对路径。 */
    const absPath = path.resolve(targetPath);
    const overwrite = params.overwrite === true;

    if (fs.existsSync(absPath)) {
      const st = fs.lstatSync(absPath);
      if (st.isSymbolicLink()) throw new Error('目标文件是符号链接，拒绝写入: ' + absPath);
      if (!st.isFile()) throw new Error('目标路径不是普通文件: ' + absPath);
      if (!overwrite) throw new Error(`目标文件已存在且 overwrite 为 false: ${absPath}`);
    }

    const store = readStore();
    const allVars = store.variables;
    const varsToWrite = {};
    const missing = [];
    for (const k of requestedKeys) {
      if (Object.prototype.hasOwnProperty.call(allVars, k)) varsToWrite[k] = allVars[k].value;
      else missing.push(k);
    }
    if (Object.keys(varsToWrite).length === 0) {
      throw new Error('给定的 keys 都不存在: ' + requestedKeys.join(', '));
    }

    const format = String(params.format || 'dotenv').toLowerCase();
    let content = '';
    if (format === 'dotenv') {
      content = formatDotenv(varsToWrite);
    } else if (format === 'shell') {
      content = formatShell(varsToWrite);
    } else if (format === 'json') {
      content = formatJson(varsToWrite);
    } else {
      throw new Error(`不支持的格式: ${format}（支持 'dotenv' | 'shell' | 'json'）`);
    }

    const modeStr = String(params.file_mode || '0600');
    if (!/^[0-7]{3,4}$/.test(modeStr)) throw new Error('file_mode 必须是八进制权限，例如 0600');
    const mode = parseInt(modeStr, 8);

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    // 创建时就带权限，避免"先 0644 再 chmod"露出窗口
    const tmp = path.join(path.dirname(absPath), '.my-env.tmp-' + randomUUID());
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    fs.renameSync(tmp, absPath);

    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(absPath, mode);
      } catch (_) {}
    }

    const writtenKeys = Object.keys(varsToWrite);
    log(`writeFile: ${absPath} (${writtenKeys.length} keys, format: ${format})`);

    return {
      ok: true,
      target_path: absPath,
      written_keys: writtenKeys,
      count: writtenKeys.length,
      format,
      bytes: Buffer.byteLength(content, 'utf8'),
      file_mode: process.platform === 'win32' ? 'acl' : modeStr,
      missing_keys: missing.length ? missing : undefined
    };
  },

  'env/exec': (params) => {
    const command = String(params?.command || '').trim();
    const commandLine = String(params?.command_line || '').trim();
    if (!command && !commandLine) {
      throw new Error('缺少必需参数: command（或直接给 command_line 走 shell 语义）');
    }

    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const cwd = params.cwd ? path.resolve(params.cwd) : process.cwd();
    const timeoutMs = Math.min(Math.max(Number(params.timeout_ms) || 30000, 1000), MAX_EXEC_TIMEOUT_MS);
    const stdinText = typeof params?.stdin === 'string' ? params.stdin : null;

    const store = readStore();
    const allVars = store.variables;
    const requestedKeys = Array.isArray(params.keys) ? params.keys.map((k) => String(k).trim()).filter(Boolean) : [];

    const injectedVars = {};
    for (const k of requestedKeys) {
      if (Object.prototype.hasOwnProperty.call(allVars, k)) injectedVars[k] = allVars[k].value;
    }
    if (requestedKeys.length === 0) {
      for (const [k, entry] of Object.entries(allVars)) injectedVars[k] = entry.value;
    }

    // 脱敏清单覆盖【全部】敏感项，而不只是本次注入的 keys：
    // 命令可能读到未注入的键（配置文件、其它来源）并回显。
    const redactList = sensitiveEntries(allVars);
    const env = { ...process.env, ...injectedVars };
    const isWin = process.platform === 'win32';

    const explicitLine = commandLine ? commandLine : null;
    const wantShell = typeof params?.shell === 'boolean'
      ? params.shell
      : (isWin && /\.(cmd|bat)$/i.test(command));
    const shellMode = explicitLine !== null || wantShell;

    let spawnCmd = command;
    let spawnArgs = args;
    if (shellMode) {
      const line = explicitLine !== null
        ? explicitLine
        : [command].concat(args).map((a) => quoteForShell(a, isWin)).join(' ');
      if (isWin) {
        spawnCmd = process.env.ComSpec || 'cmd.exe';
        spawnArgs = ['/d', '/s', '/c', line];
      } else {
        spawnCmd = '/bin/sh';
        spawnArgs = ['-c', line];
      }
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const so = redactOutput(payload.stdout, redactList);
        const se = redactOutput(payload.stderr, redactList);
        const hits = so.hits + se.hits;
        resolve({
          ok: payload.exitCode === 0 && !payload.timedOut,
          timedOut: payload.timedOut,
          exitCode: payload.exitCode === null || payload.exitCode === undefined ? -1 : payload.exitCode,
          stdout: so.text,
          stderr: se.text,
          injected_keys: Object.keys(injectedVars),
          count: Object.keys(injectedVars).length,
          redacted_hits: hits,
          redacted_keys: [...new Set(so.keys.concat(se.keys))],
          redacted_warning: hits > 0
            ? '输出中出现过 ' + hits + ' 处敏感值，已替换为 [REDACTED_SECRET]'
            : null,
          timeout_ms: timeoutMs
        });
      };

      let proc;
      try {
        proc = spawn(spawnCmd, spawnArgs, {
          cwd,
          env,
          shell: false,
          detached: !isWin,
          windowsHide: true,
          stdio: [stdinText === null ? 'ignore' : 'pipe', 'pipe', 'pipe']
        });
      } catch (err) {
        reject(err);
        return;
      }

      const outChunks = [];
      const errChunks = [];
      const outState = { bytes: 0, truncated: false };
      const errState = { bytes: 0, truncated: false };

      const collect = (chunks, chunk, state) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        if (state.bytes >= MAX_OUTPUT_BYTES) {
          state.truncated = true;
          return;
        }
        const room = MAX_OUTPUT_BYTES - state.bytes;
        chunks.push(buf.subarray(0, room));
        state.bytes += Math.min(buf.length, room);
        if (buf.length > room) state.truncated = true;
      };

      timer = setTimeout(() => {
        killTree(proc, isWin);
        finish({
          timedOut: true,
          exitCode: null,
          stdout: Buffer.concat(outChunks).toString('utf8') + '\n[... 超时前输出 ...]',
          stderr: Buffer.concat(errChunks).toString('utf8')
        });
      }, timeoutMs);

      if (proc.stdin && stdinText !== null) {
        proc.stdin.on('error', () => {});
        try {
          proc.stdin.end(stdinText);
        } catch (_) {}
      }

      proc.stdout.on('data', (chunk) => collect(outChunks, chunk, outState));
      proc.stderr.on('data', (chunk) => collect(errChunks, chunk, errState));

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err && err.code === 'ENOENT') {
          const hint = isWin
            ? "该命令不在 PATH 中。Windows 可改用 cmd、powershell、node，或写完整路径（如 C:\\Program Files\\Git\\bin\\bash.exe）。"
            : '该命令不在 PATH 中，请检查是否已安装，或改用绝对路径。';
          reject(new Error(`无法启动命令 "${command}"：${hint}`));
          return;
        }
        reject(err);
      });

      proc.on('close', (exitCode) => {
        const tail = (truncated) => truncated ? '\n[... 输出超过 256KB，已截断 ...]' : '';
        finish({
          timedOut: false,
          exitCode,
          stdout: Buffer.concat(outChunks).toString('utf8') + tail(outState.truncated),
          stderr: Buffer.concat(errChunks).toString('utf8') + tail(errState.truncated)
        });
      });
    });
  },

  'env/probe': async (params) => {
    const kind = String(params?.kind || 'github').toLowerCase();
    if (kind !== 'github' && kind !== 'http') {
      throw new Error("不支持的 kind: " + kind + "（支持 'github' | 'http'）");
    }
    const timeoutMs = Math.min(Math.max(Number(params?.timeout_ms) || 15000, 1000), 60000);
    const store = readStore();
    const allVars = store.variables;

    const requested = Array.isArray(params?.keys) ? params.keys.map((k) => String(k).trim()).filter(Boolean) : [];
    if (requested.length === 0) {
      throw new Error('keys 必填：探测会把凭据发送到目标地址，禁止隐式使用全部敏感项');
    }
    if (requested.length > MAX_PROBE_KEYS) {
      throw new Error(`一次最多探测 ${MAX_PROBE_KEYS} 个键，请分批`);
    }
    const keys = requested;

    const checks = [];
    for (const key of keys) {
      const entry = allVars[key];
      if (!entry) {
        checks.push({ key, ok: false, status: 0, error: '环境变量不存在' });
        continue;
      }
      const token = String(entry.value || '');
      if (!token) {
        checks.push({ key, ok: false, status: 0, error: '值为空' });
        continue;
      }
      try {
        checks.push(kind === 'github'
          ? await probeGithub(key, token, params, timeoutMs)
          : await probeHttp(key, token, params, timeoutMs));
      } catch (e) {
        checks.push({ key, ok: false, status: 0, error: String((e && e.message) || e).slice(0, 200) });
      }
    }
    return { ok: checks.every((c) => c.ok), kind, count: checks.length, checks };
  },

  /* 设置页通道：整包读取（含明文，仅供本机 UI 显示与编辑） */
  'env/store': () => {
    const store = readStore();
    return { ok: true, variables: store.variables };
  },

  'env/stats': () => {
    const file = getStorageFile();
    let bytes = 0;
    let mode = null;
    try {
      const st = fs.statSync(file);
      bytes = st.size;
      mode = process.platform === 'win32' ? 'acl' : '0' + (st.mode & 0o777).toString(8);
    } catch (_) {}
    const store = readStore();
    const entries = Object.values(store.variables);
    return {
      ok: true,
      path: file,
      bytes,
      mode,
      count: entries.length,
      sensitive_count: entries.filter(isSensitive).length
    };
  }
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line || !line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (_) {
    reply(null, null, { code: -32700, message: 'Parse error' });
    return;
  }
  const handler = methods[request.method];
  if (!handler) {
    reply(request.id, null, { code: -32601, message: 'Method not found: ' + request.method });
    return;
  }
  Promise.resolve()
    .then(() => handler(request.params || {}))
    .then((result) => reply(request.id, result, null))
    .catch((err) => reply(request.id, null, (err && err.message) || String(err)));
});
