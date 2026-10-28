// plugins/my-env/node/worker.cjs —— 随包 Node 工作进程 (JSON-RPC 2.0 stdio)
// 职责：
//   1. 本地持久化环境变量存储（跨平台无 60KB /kv 上限，存储海量变量）
//   2. 安全向目标文件写入环境变量（.env / shell / json，对话零明文）
//   3. 安全执行本地命令（进程级注入 process.env，输出自动脱敏）

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

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
// 跨平台数据目录发现 (Windows / macOS / Linux)
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

function readStore() {
  const file = getStorageFile();
  if (!fs.existsSync(file)) {
    return { version: 1, variables: {} };
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { version: 1, variables: {} };
    }
    if (!data.variables || typeof data.variables !== 'object' || Array.isArray(data.variables)) {
      data.variables = {};
    }
    return data;
  } catch (err) {
    log('读取 variables.json 出错，回退为空: ' + err.message);
    return { version: 1, variables: {} };
  }
}

function saveStore(store) {
  const dir = resolveStorageDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = getStorageFile();
  const tmp = file + '.tmp-' + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function assertKey(key) {
  if (!key) throw new Error('key 不能为空');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
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

function redactOutput(text, sensitiveList) {
  if (!text || typeof text !== 'string') return '';
  let result = text;
  for (const secret of sensitiveList) {
    if (secret && typeof secret === 'string' && secret.length >= 4) {
      result = result.split(secret).join('[REDACTED_SECRET]');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 方法实现
// ---------------------------------------------------------------------------
const methods = {
  'env/list': (params) => {
    const store = readStore();
    const vars = store.variables;
    const q = String(params?.query || '').trim().toLowerCase();
    const items = Object.keys(vars)
      .filter((k) => {
        if (!q) return true;
        return k.toLowerCase().indexOf(q) >= 0 || (vars[k].memo || '').toLowerCase().indexOf(q) >= 0;
      })
      .sort((a, b) => a.localeCompare(b))
      .map((k) => ({
        key: k,
        maskedValue: maskOf(vars[k]),
        memo: vars[k].memo || '',
        sensitive: isSensitive(vars[k]),
        updatedAt: vars[k].updatedAt || 0
      }));
    return { total: items.length, items };
  },

  'env/get': (params) => {
    const key = String(params?.key || '').trim();
    assertKey(key);
    const store = readStore();
    if (!Object.prototype.hasOwnProperty.call(store.variables, key)) {
      throw new Error('环境变量不存在: ' + key);
    }
    const entry = store.variables[key];
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
    if (params?.value === undefined || params?.value === null) {
      throw new Error('缺少必须参数: value');
    }
    const value = String(params.value);
    const store = readStore();
    const vars = store.variables;
    const existing = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : null;
    const sensitive = params.sensitive === undefined
      ? (existing ? isSensitive(existing) : true)
      : params.sensitive !== false;
    vars[key] = { value, memo: String(params.memo || '').trim(), sensitive, updatedAt: Date.now() };
    saveStore(store);
    return { key, message: '已保存 ' + key, maskedValue: maskOf(vars[key]), sensitive };
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

  'env/writeFile': (params) => {
    const targetPath = String(params?.target_path || '').trim();
    if (!targetPath) throw new Error('缺少必需参数: target_path');

    const absPath = path.resolve(targetPath);
    const overwrite = params.overwrite !== false;

    if (!overwrite && fs.existsSync(absPath)) {
      throw new Error(`目标文件已存在且 overwrite 为 false: ${absPath}`);
    }

    const store = readStore();
    const allVars = store.variables;
    const requestedKeys = Array.isArray(params.keys) ? params.keys.map((k) => String(k).trim()).filter(Boolean) : [];

    const varsToWrite = {};
    if (requestedKeys.length > 0) {
      for (const k of requestedKeys) {
        if (Object.prototype.hasOwnProperty.call(allVars, k)) {
          varsToWrite[k] = allVars[k].value;
        }
      }
    } else {
      for (const [k, entry] of Object.entries(allVars)) {
        varsToWrite[k] = entry.value;
      }
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

    fs.mkdirSync(path.dirname(absPath), { recursive: true });

    // 原子写入
    const tmp = absPath + '.tmp-' + randomUUID();
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, absPath);

    // POSIX 权限设置（默认 0600，Windows 自动跳过）
    if (process.platform !== 'win32') {
      try {
        const mode = parseInt(String(params.file_mode || '0600'), 8);
        fs.chmodSync(absPath, mode);
      } catch (_) {}
    }

    const writtenKeys = Object.keys(varsToWrite);
    log(`writeFile: ${absPath} (${writtenKeys.length} keys, format: ${format})`);

    // 对话与回执中绝不返回明文值，只返回摘要元数据
    return {
      ok: true,
      target_path: absPath,
      written_keys: writtenKeys,
      count: writtenKeys.length,
      format,
      bytes: Buffer.byteLength(content, 'utf8')
    };
  },

  'env/exec': async (params) => {
    const command = String(params?.command || '').trim();
    if (!command) throw new Error('缺少必需参数: command');

    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const cwd = params.cwd ? path.resolve(params.cwd) : process.cwd();
    const timeoutMs = Math.min(Math.max(Number(params.timeout_ms) || 30000, 1000), 300000);

    const store = readStore();
    const allVars = store.variables;
    const requestedKeys = Array.isArray(params.keys) ? params.keys.map((k) => String(k).trim()).filter(Boolean) : [];

    const injectedVars = {};
    const sensitiveValues = [];

    // 收集待注入环境变量与敏感脱敏清单
    if (requestedKeys.length > 0) {
      for (const k of requestedKeys) {
        if (Object.prototype.hasOwnProperty.call(allVars, k)) {
          injectedVars[k] = allVars[k].value;
          if (isSensitive(allVars[k])) sensitiveValues.push(allVars[k].value);
        }
      }
    } else {
      for (const [k, entry] of Object.entries(allVars)) {
        injectedVars[k] = entry.value;
        if (isSensitive(entry)) sensitiveValues.push(entry.value);
      }
    }

    const env = { ...process.env, ...injectedVars };

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const MAX_OUTPUT = 256 * 1024;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      // Windows 平台适配：若明确传了 shell 参数按传参；若未传，则对非批处理脚本优先 shell: false 避免 cmd.exe 误拆引号
      const isWin = process.platform === 'win32';
      let useShell = false;
      if (typeof params?.shell === 'boolean') {
        useShell = params.shell;
      } else if (isWin) {
        const lower = command.toLowerCase();
        useShell = lower.endsWith('.cmd') || lower.endsWith('.bat');
      }

      const proc = spawn(command, args, {
        cwd,
        env,
        shell: useShell,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch (_) {}
        reject(new Error(`命令执行超时 (${timeoutMs}ms): ${command}`));
      }, timeoutMs);

      proc.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_OUTPUT) {
          stdout += chunk.toString('utf8');
        } else if (!stdoutTruncated) {
          stdout += '\n[... stdout truncated at 256KB ...]';
          stdoutTruncated = true;
        }
      });

      proc.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_OUTPUT) {
          stderr += chunk.toString('utf8');
        } else if (!stderrTruncated) {
          stderr += '\n[... stderr truncated at 256KB ...]';
          stderrTruncated = true;
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        // ENOENT 是最常见的误用：command 不在这台机器的 PATH 里（例如 Windows 上没有
        // bash / grep）。原始 "spawn bash ENOENT" 对调用方毫无指引，这里补上可用做法。
        if (err && err.code === 'ENOENT') {
          const hint = isWin
            ? "该命令不在 PATH 中。Windows 可改用 cmd、powershell、node，或写完整路径（如 C:\Program Files\Git\bin\bash.exe）。"
            : '该命令不在 PATH 中，请检查是否已安装，或改用绝对路径。';
          reject(new Error(`无法启动命令 "${command}"：${hint}`));
          return;
        }
        reject(err);
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        // 对输出中的敏感密钥执行掩码过滤
        const sanitizedStdout = redactOutput(stdout, sensitiveValues);
        const sanitizedStderr = redactOutput(stderr, sensitiveValues);

        resolve({
          ok: exitCode === 0,
          exitCode: exitCode ?? -1,
          stdout: sanitizedStdout,
          stderr: sanitizedStderr,
          injected_keys: Object.keys(injectedVars),
          count: Object.keys(injectedVars).length
        });
      });
    });
  },

  'env/sync': (params) => {
    const incoming = params?.variables;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return { ok: true, synced: false };
    }
    const store = readStore();
    let changed = false;
    for (const [k, v] of Object.entries(incoming)) {
      if (RESERVED.has(k) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      if (!v || typeof v !== 'object') continue;
      if (!Object.prototype.hasOwnProperty.call(store.variables, k) || store.variables[k].value !== v.value) {
        store.variables[k] = {
          value: String(v.value ?? ''),
          memo: String(v.memo || ''),
          sensitive: v.sensitive !== false,
          updatedAt: v.updatedAt || Date.now()
        };
        changed = true;
      }
    }
    if (changed) saveStore(store);
    return { ok: true, count: Object.keys(store.variables).length };
  },

  'env/exportStore': () => {
    const store = readStore();
    return { ok: true, variables: store.variables };
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
