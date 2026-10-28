const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'plugins', 'my-env', 'node', 'worker.cjs');

function startWorker() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-env-v24-'));
  const proc = spawn('node', [WORKER], {
    env: { ...process.env, CINDY_HOME: tmpDir },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map();
  let seq = 1;
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  });
  return {
    call(method, params) {
      const id = seq++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async kill() {
      try { rl.close(); } catch (_) {}
      try { proc.kill(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 50));
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

test('v0.2.4 env_get 保留：敏感项默认拒明文，非敏感项照常可读', async () => {
  const w = startWorker();
  const SECRET = 'hqpzt-ncgvn-77';
  try {
    await w.call('env/set', { key: 'GH_TOKEN', value: SECRET, sensitive: true });
    await w.call('env/set', { key: 'API_HOST', value: 'https://api.example.com', sensitive: false });

    const denied = await w.call('env/get', { key: 'GH_TOKEN' });
    assert.equal(denied.value, null);
    assert.equal(denied.denied, 'SENSITIVE_PLAINTEXT_BLOCKED');
    assert.equal(JSON.stringify(denied).includes(SECRET), false);

    const allowed = await w.call('env/get', { key: 'GH_TOKEN', allow_plaintext: true });
    assert.equal(allowed.value, SECRET);

    // 非敏感配置一次读到位，无需落盘
    const plain = await w.call('env/get', { key: 'API_HOST' });
    assert.equal(plain.value, 'https://api.example.com');
    assert.equal(plain.denied, undefined);
  } finally {
    await w.kill();
  }
});

test('v0.2.4 env_list 支持按 keys 批量精确查询并报告缺失键', async () => {
  const w = startWorker();
  const SECRET = 'retnq-xbtql-325';
  try {
    await w.call('env/set', { key: 'GH_TOKEN', value: SECRET, sensitive: true });
    await w.call('env/set', { key: 'API_HOST', value: 'https://api.example.com', sensitive: false });

    const one = await w.call('env/list', { keys: ['GH_TOKEN'], });
    assert.equal(one.total, 1);
    assert.equal(one.items[0].maskedValue, '••••••');
    assert.equal(JSON.stringify(one).includes(SECRET), false, '列表回执绝不能含明文');

    const withMissing = await w.call('env/list', { keys: ['GH_TOKEN', 'NOPE_KEY'] });
    assert.deepEqual(withMissing.missing, ['NOPE_KEY']);

    const all = await w.call('env/list', {});
    assert.equal(all.total, 2);
  } finally {
    await w.kill();
  }
});

test('v0.2.4 env_exec 走显式 shell 包装，语义与 shell:true 等价', async () => {
  const w = startWorker();
  try {
    await w.call('env/set', { key: 'SHELL_PLAIN', value: 'plain-abc-9', sensitive: false });

    const viaFlag = await w.call('env/exec', {
      command: 'echo', args: ['$SHELL_PLAIN'], keys: ['SHELL_PLAIN'], shell: true
    });
    assert.ok(viaFlag.stdout.includes('plain-abc-9'), 'shell:true 仍应展开变量');

    const viaLine = await w.call('env/exec', {
      command_line: 'printf "%s" "$SHELL_PLAIN"', keys: ['SHELL_PLAIN']
    });
    assert.ok(viaLine.stdout.includes('plain-abc-9'), 'command_line 应走 shell 执行');

    const noShell = await w.call('env/exec', {
      command: 'echo', args: ['$SHELL_PLAIN'], keys: ['SHELL_PLAIN'], shell: false
    });
    assert.equal(noShell.stdout.includes('plain-abc-9'), false, 'shell:false 时不展开');
  } finally {
    await w.kill();
  }
});

test('v0.2.4 源码层不再出现 shell:true 写法（DEP0190 根治）', () => {
  const raw = fs.readFileSync(WORKER, 'utf-8');
  // 只看代码行：注释里会引用旧写法做说明，不能算违规
  const src = raw.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.equal(/shell:\s*true/.test(src), false, '不得出现 shell: true');
  assert.equal(/shell:\s*useShell/.test(src), false, '不得把 shell 变量直接交给 spawn');
  assert.ok(/shell:\s*false/.test(src), 'spawn 必须显式 shell:false');
  assert.ok(src.includes('/bin/sh'), 'POSIX 必须显式用 /bin/sh -c');
  assert.ok(src.includes('ComSpec'), 'Windows 必须显式用 ComSpec /c');
  assert.ok(src.includes('command_line'), '必须有 command_line 入口');
});

test('v0.2.4 exec 脱敏仍覆盖全部敏感项并回传命中数', async () => {
  const w = startWorker();
  const A = 'aaa-token-1111';
  const B = 'bbb-token-2222';
  try {
    await w.call('env/set', { key: 'A_TOKEN', value: A, sensitive: true });
    await w.call('env/set', { key: 'B_TOKEN', value: B, sensitive: true });
    const r = await w.call('env/exec', {
      command: process.execPath,
      args: ['-e', 'console.log("out: ' + B + ' and ' + A + '")'],
      keys: ['A_TOKEN']
    });
    assert.equal(r.stdout.includes(B), false, '未注入的敏感项也要脱敏');
    assert.equal(r.stdout.includes(A), false);
    assert.ok(r.redacted_hits >= 2);
  } finally {
    await w.kill();
  }
});

test('v0.2.4 env_probe 只回状态码，绝不回显密钥', async () => {
  const w = startWorker();
  const KEY = 'probe-secret-999';
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization === 'Bearer ' + KEY) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"echo":"' + KEY + '"}');
    } else {
      res.writeHead(401);
      res.end('{}');
    }
  });
  try {
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await w.call('env/set', { key: 'PROBE_KEY', value: KEY, sensitive: true });
    const good = await w.call('env/probe', { kind: 'http', keys: ['PROBE_KEY'], url: 'http://127.0.0.1:' + port + '/' });
    assert.equal(good.ok, true);
    assert.equal(JSON.stringify(good).includes(KEY), false);
  } finally {
    try { srv.close(); } catch (_) {}
    await w.kill();
  }
});

test('v0.2.4 工具面保持 7 个，新增参数三层契约双向对齐', () => {
  const ghost = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'my-env', 'ghost.json'), 'utf-8'));
  const mainJs = fs.readFileSync(path.join(ROOT, 'plugins', 'my-env', 'main.js'), 'utf-8');
  const names = ghost.tools.map((t) => t.name).sort();
  const byName = Object.fromEntries(ghost.tools.map((t) => [t.name, t]));

  assert.equal(ghost.version, '0.2.4');
  assert.deepEqual(names, ['env_delete', 'env_exec', 'env_get', 'env_list', 'env_probe', 'env_set', 'env_write_file']);

  assert.ok(byName.env_list.parameters.properties.keys, 'env_list 必须声明 keys');
  assert.ok(mainJs.includes('keys: args.keys'), 'main.js 必须透传 env_list.keys');
  assert.ok(byName.env_exec.parameters.properties.command_line, 'env_exec 必须声明 command_line');
  assert.ok(mainJs.includes('command_line: args.command_line'), 'main.js 必须透传 command_line');
  assert.ok(byName.env_exec.parameters.properties.shell, 'env_exec 必须声明 shell');
  assert.ok(mainJs.includes('shell: args.shell'), 'main.js 必须透传 shell');
});
