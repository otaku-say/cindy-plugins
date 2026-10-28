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

/**
 * 起一个隔离的 worker（CINDY_HOME 指向临时目录），返回 call/kill。
 * worker 是 stdio JSON-RPC，不需要 Cindy 宿主即可驱动。
 */
function startWorker() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-env-h-'));
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

test('v0.2.3 env_get 默认拒绝敏感项明文，仅 allow_plaintext:true 放行', async () => {
  const w = startWorker();
  const SECRET = 'plain-text-SHOULD-NOT-LEAK-42';
  try {
    await w.call('env/set', { key: 'GH_TOKEN', value: SECRET, sensitive: true });
    await w.call('env/set', { key: 'API_HOST', value: 'https://api.example.com', sensitive: false });

    const denied = await w.call('env/get', { key: 'GH_TOKEN' });
    assert.equal(denied.value, null, '敏感项默认不得返回明文');
    assert.equal(denied.denied, 'SENSITIVE_PLAINTEXT_BLOCKED');
    assert.equal(denied.maskedValue, '••••••');
    assert.ok(denied.hint && denied.hint.length > 0, '必须给出替代方案提示');
    assert.equal(JSON.stringify(denied).includes(SECRET), false, '回执里绝不能出现明文');

    const allowed = await w.call('env/get', { key: 'GH_TOKEN', allow_plaintext: true });
    assert.equal(allowed.value, SECRET, '显式 allow_plaintext 才放行');
    assert.equal(allowed.denied, undefined);

    const normal = await w.call('env/get', { key: 'API_HOST' });
    assert.equal(normal.value, 'https://api.example.com', '非敏感项不受影响');
    assert.equal(normal.denied, undefined);
  } finally {
    await w.kill();
  }
});

test('v0.2.3 exec 脱敏覆盖全部敏感项（不只注入的 keys）并回传命中数', async () => {
  const w = startWorker();
  const A = 'aaa-token-1111';
  const B = 'bbb-token-2222';
  try {
    await w.call('env/set', { key: 'A_TOKEN', value: A, sensitive: true });
    await w.call('env/set', { key: 'B_TOKEN', value: B, sensitive: true });

    // 只注入 A，但命令把 B 的字面值也打印出来
    const r = await w.call('env/exec', {
      command: process.execPath,
      args: ['-e', 'console.log("out: ' + B + ' and ' + A + '")'],
      keys: ['A_TOKEN']
    });

    assert.equal(r.stdout.includes(B), false, '未注入的敏感项也必须脱敏');
    assert.equal(r.stdout.includes(A), false, '已注入的敏感项必须脱敏');
    assert.ok(r.redacted_hits >= 2, '应统计脱敏命中数，实际=' + r.redacted_hits);
    assert.ok(String(r.redacted_warning || '').includes('敏感值'), '应给出脱敏警示');
    assert.deepEqual(r.injected_keys, ['A_TOKEN']);
  } finally {
    await w.kill();
  }
});

test('v0.2.3 env_exec 透传 shell 语义（$VAR 可在进程内展开）', async () => {
  const w = startWorker();
  try {
    await w.call('env/set', { key: 'SHELL_PLAIN', value: 'plain-abc-9', sensitive: false });

    const withShell = await w.call('env/exec', {
      command: 'echo', args: ['$SHELL_PLAIN'], keys: ['SHELL_PLAIN'], shell: true
    });
    assert.ok(withShell.stdout.includes('plain-abc-9'), 'shell:true 时应展开变量，实际=' + JSON.stringify(withShell.stdout));

    const noShell = await w.call('env/exec', {
      command: 'echo', args: ['$SHELL_PLAIN'], keys: ['SHELL_PLAIN'], shell: false
    });
    assert.equal(noShell.stdout.includes('plain-abc-9'), false, 'shell:false 时不得展开');
  } finally {
    await w.kill();
  }
});

test('v0.2.3 env_probe 只回传状态码，绝不回显密钥', async () => {
  const w = startWorker();
  const KEY = 'probe-secret-999';
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization === 'Bearer ' + KEY) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"echo":"' + KEY + '"}');
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"msg":"bad"}');
    }
  });
  try {
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await w.call('env/set', { key: 'PROBE_KEY', value: KEY, sensitive: true });

    const good = await w.call('env/probe', {
      kind: 'http', keys: ['PROBE_KEY'], url: 'http://127.0.0.1:' + port + '/'
    });
    assert.equal(good.ok, true);
    assert.equal(good.checks[0].status, 200);
    assert.equal(JSON.stringify(good).includes(KEY), false, '响应体里的密钥不得被回传');

    const bad = await w.call('env/probe', {
      kind: 'http', keys: ['PROBE_KEY'], url: 'http://127.0.0.1:' + port + '/', ok_status: [201]
    });
    assert.equal(bad.ok, false, '状态码不在期望集合时应判失败');

    const missing = await w.call('env/probe', { kind: 'http', keys: ['NOPE'], url: 'http://127.0.0.1:1/' });
    assert.equal(missing.ok, false);
    assert.ok(String(missing.checks[0].error).includes('不存在'));
  } finally {
    try { srv.close(); } catch (_) {}
    await w.kill();
  }
});

test('v0.2.3 ghost.json 与 main.js 的工具契约双向对齐', () => {
  const ghost = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'my-env', 'ghost.json'), 'utf-8'));
  const mainJs = fs.readFileSync(path.join(ROOT, 'plugins', 'my-env', 'main.js'), 'utf-8');
  const byName = Object.fromEntries(ghost.tools.map((t) => [t.name, t]));

  assert.equal(ghost.version, '0.2.3');

  // 新增工具必须双向声明
  assert.ok(byName.env_probe, 'ghost.json 必须声明 env_probe');
  assert.ok(mainJs.includes('env_probe:'), 'main.js 必须分派 env_probe');
  assert.ok(mainJs.includes("method: 'env/probe'"), 'main.js 必须路由到 env/probe');

  // 实现有、契约无的旧缺陷回归：shell 与 allow_plaintext
  assert.ok(Object.prototype.hasOwnProperty.call(byName.env_exec.parameters.properties, 'shell'), 'env_exec 必须声明 shell');
  assert.ok(mainJs.includes('shell: args.shell'), 'main.js 必须透传 shell');
  assert.ok(Object.prototype.hasOwnProperty.call(byName.env_get.parameters.properties, 'allow_plaintext'), 'env_get 必须声明 allow_plaintext');
  assert.ok(mainJs.includes('allow_plaintext: args.allow_plaintext'), 'main.js 必须透传 allow_plaintext');

  // worker 侧真实存在对应 handler
  const workerJs = fs.readFileSync(WORKER, 'utf-8');
  assert.ok(workerJs.includes("'env/probe'"), 'worker 必须实现 env/probe');
  assert.ok(workerJs.includes('SENSITIVE_PLAINTEXT_BLOCKED'), 'worker 必须默认拒绝敏感项明文');
  assert.ok(workerJs.includes('redacted_hits'), 'worker 必须回传脱敏命中数');
});
