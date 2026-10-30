// plugins/my-env —— v0.3.0 行为回归（Node worker + 契约对齐）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'my-env');
const WORKER = path.join(PLUGIN, 'node', 'worker.cjs');
const VERSION = '0.3.1';

function startWorker() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-env-v30-'));
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
    tmpDir,
    call(method, params) {
      const id = seq++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    storeFile() {
      return path.join(tmpDir, 'data', 'my-env', 'variables.json');
    },
    async kill() {
      try { rl.close(); } catch (_) {}
      try { proc.kill(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 50));
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

test('v0.3.0 env_get：敏感项默认拒明文，非敏感项照常可读', async () => {
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

    const plain = await w.call('env/get', { key: 'API_HOST' });
    assert.equal(plain.value, 'https://api.example.com');
    assert.equal(plain.denied, undefined);
  } finally {
    await w.kill();
  }
});

test('v0.3.0 env_set：value_from.file 免明文，inline 值带回 warning', async () => {
  const w = startWorker();
  const SECRET = 'from-file-token-7788';
  try {
    const file = path.join(w.tmpDir, 'secret.txt');
    fs.writeFileSync(file, SECRET + '\n');
    const res = await w.call('env/set', { key: 'FILE_TOKEN', value_from: { file } });
    assert.equal(res.value_source, 'file');
    assert.equal(res.warning, undefined);
    assert.equal(JSON.stringify(res).includes(SECRET), false);
    const got = await w.call('env/get', { key: 'FILE_TOKEN', allow_plaintext: true });
    assert.equal(got.value, SECRET, '末尾换行应被裁掉');

    const inline = await w.call('env/set', { key: 'INLINE_TOKEN', value: 'inline-token-1234' });
    assert.equal(inline.value_source, 'inline');
    assert.ok(inline.warning, '明文入参必须回传 warning');

    await assert.rejects(
      w.call('env/set', { key: 'NO_VALUE' }),
      /缺少必须参数/,
      '既没有 value 也没有 value_from 时应报错'
    );
  } finally {
    await w.kill();
  }
});

test('v0.3.0 env_list：支持分页并报告缺失键', async () => {
  const w = startWorker();
  const SECRET = 'retnq-xbtql-325';
  try {
    await w.call('env/set', { key: 'GH_TOKEN', value: SECRET, sensitive: true });
    await w.call('env/set', { key: 'API_HOST', value: 'https://api.example.com', sensitive: false });

    const one = await w.call('env/list', { keys: ['GH_TOKEN'] });
    assert.equal(one.total, 1);
    assert.equal(one.items[0].maskedValue, '••••••');
    assert.equal(JSON.stringify(one).includes(SECRET), false, '列表回执绝不能含明文');

    const withMissing = await w.call('env/list', { keys: ['GH_TOKEN', 'NOPE_KEY'] });
    assert.deepEqual(withMissing.missing, ['NOPE_KEY']);

    const all = await w.call('env/list', {});
    assert.equal(all.total, 2);

    const page = await w.call('env/list', { limit: 1, offset: 1 });
    assert.equal(page.returned, 1);
    assert.equal(page.hasMore, false);
    assert.equal(page.items[0].key, 'GH_TOKEN');
  } finally {
    await w.kill();
  }
});

test('v0.3.0 存储文件 0600、目录 0700，并保留一份 .bak', async () => {
  const w = startWorker();
  try {
    await w.call('env/set', { key: 'FIRST', value: 'value-one' });
    await w.call('env/set', { key: 'SECOND', value: 'value-two' });
    const file = w.storeFile();
    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(file + '.bak'), '第二次写入前应留下 .bak');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, '存储文件必须是 0600');
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, '存储目录必须是 0700');
      assert.equal(fs.statSync(file + '.bak').mode & 0o777, 0o600, '备份也必须是 0600');
    }
  } finally {
    await w.kill();
  }
});

test('v0.3.0 env_writeFile：keys 必填、默认不覆盖、拒绝符号链接', async () => {
  const w = startWorker();
  try {
    await w.call('env/set', { key: 'SECRET_TOKEN', value: 'write-file-secret-99', sensitive: true });
    const target = path.join(process.cwd(), '.my-env-test-' + Date.now() + '.env');

    await assert.rejects(
      w.call('env/writeFile', { target_path: target }),
      /keys 必填/,
      '不允许隐式写入全部凭据'
    );

    const ok = await w.call('env/writeFile', { target_path: target, keys: ['SECRET_TOKEN'] });
    assert.equal(ok.count, 1);
    assert.equal(JSON.stringify(ok).includes('write-file-secret-99'), false);
    assert.equal(fs.readFileSync(target, 'utf8').includes('write-file-secret-99'), true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600);

    await assert.rejects(
      w.call('env/writeFile', { target_path: target, keys: ['SECRET_TOKEN'] }),
      /overwrite/,
      '默认不得覆盖已存在文件'
    );

    if (process.platform !== 'win32') {
      const link = path.join(os.tmpdir(), 'my-env-link-' + Date.now());
      fs.symlinkSync(target, link);
      try {
        await assert.rejects(
          w.call('env/writeFile', { target_path: link, keys: ['SECRET_TOKEN'], overwrite: true }),
          /符号链接/,
          '符号链接目标必须拒绝'
        );
      } finally {
        try { fs.unlinkSync(link); } catch (_) {}
      }
    }

    const outside = path.join(os.tmpdir(), 'my-env-outside-' + Date.now() + '.env');
    await assert.rejects(
      w.call('env/writeFile', { target_path: outside, keys: ['SECRET_TOKEN'] }),
      /工作目录之外/,
      '默认不得写到工作目录之外'
    );

    try { fs.unlinkSync(target); } catch (_) {}
  } finally {
    await w.kill();
  }
});

test('v0.3.0 env_exec：shell 包装、参数加引号、超时杀进程树并回传部分输出', async () => {
  const w = startWorker();
  const isWin = process.platform === "win32";
  const varRef = isWin ? "%SHELL_PLAIN%" : "$SHELL_PLAIN";
  try {
    await w.call("env/set", { key: "SHELL_PLAIN", value: "plain-abc-9", sensitive: false });

    const viaFlag = await w.call("env/exec", {
      command: "echo", args: [varRef], keys: ["SHELL_PLAIN"], shell: true
    });
    assert.ok(viaFlag.stdout.includes("plain-abc-9"), "shell:true 仍应展开变量");

    const viaLine = await w.call("env/exec", {
      command_line: isWin ? "echo %SHELL_PLAIN%" : "printf \"%s\" \"$SHELL_PLAIN\"",
      keys: ["SHELL_PLAIN"]
    });
    assert.ok(viaLine.stdout.includes("plain-abc-9"));

    const noShell = await w.call("env/exec", {
      command: "echo", args: [varRef], keys: ["SHELL_PLAIN"], shell: false
    });
    assert.equal(noShell.stdout.includes("plain-abc-9"), false, "shell:false 时不展开");

    if (!isWin) {
      // Windows 的 cmd /s /c 引号行为依赖 shell 环境，跨平台可验证的只有 POSIX；
      // Windows 上需要完全掌控引号时请用 command_line。
      const quoted = await w.call("env/exec", {
        command: "printf",
        args: ["%s", "a b c"],
        shell: true
      });
      assert.equal(quoted.stdout.trim(), "a b c", "含空格的参数必须整体传递");
    }

    const stdinRes = await w.call("env/exec", {
      command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], stdin: "piped-input"
    });
    assert.equal(stdinRes.stdout.trim(), "piped-input");

    const slow = await w.call("env/exec", {
      command: process.execPath,
      args: ["-e", "console.log(\"started\"); setTimeout(() => {}, 5000)"],
      timeout_ms: 1200
    });
    assert.equal(slow.timedOut, true, "超时必须以 timedOut 标记返回");
    assert.equal(slow.ok, false);
    assert.ok(slow.stdout.includes("started"), "超时也要带回已产生的输出");
  } finally {
    await w.kill();
  }
});

test('v0.3.0 exec 脱敏覆盖全部敏感项，长值优先替换', async () => {
  const w = startWorker();
  const SHORT = 'aaa-token-1111';
  const LONG = 'aaa-token-1111-with-suffix';
  try {
    await w.call('env/set', { key: 'SHORT_TOKEN', value: SHORT, sensitive: true });
    await w.call('env/set', { key: 'LONG_TOKEN', value: LONG, sensitive: true });
    const r = await w.call('env/exec', {
      command: process.execPath,
      args: ['-e', 'console.log("long=' + LONG + ' short=' + SHORT + '")'],
      keys: []
    });
    assert.equal(r.stdout.includes(SHORT), false);
    assert.equal(r.stdout.includes(LONG), false);
    assert.equal(r.stdout.includes('[REDACTED_SECRET]-with-suffix'), false, '长值必须先替换，不能留残片');
    assert.ok(r.redacted_hits >= 2);
    assert.deepEqual(r.redacted_keys.sort(), ['LONG_TOKEN', 'SHORT_TOKEN']);
  } finally {
    await w.kill();
  }
});

test('v0.3.0 env_probe：keys 必填、默认拒绝内网目标、只回状态码', async () => {
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

    await assert.rejects(w.call('env/probe', { kind: 'http', url: 'http://127.0.0.1:' + port + '/' }),
      /keys 必填/, '不允许隐式探测全部敏感项');

    const blocked = await w.call('env/probe', {
      kind: 'http', keys: ['PROBE_KEY'], url: 'http://127.0.0.1:' + port + '/'
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.checks[0].error, /内网|本机/);

    const good = await w.call('env/probe', {
      kind: 'http', keys: ['PROBE_KEY'], url: 'http://127.0.0.1:' + port + '/', allow_private: true
    });
    assert.equal(good.ok, true);
    assert.equal(JSON.stringify(good).includes(KEY), false);

    const notAllowed = await w.call('env/probe', {
      kind: 'http', keys: ['PROBE_KEY'], url: 'http://127.0.0.1:' + port + '/',
      allow_private: true, allowed_hosts: ['api.example.com']
    });
    assert.equal(notAllowed.ok, false);
    assert.match(notAllowed.checks[0].error, /allowed_hosts/);
  } finally {
    try { srv.close(); } catch (_) {}
    await w.kill();
  }
});

test('v0.3.0 源码层：不再镜像 /kv，导出/导入只在设置页', () => {
  const mainJs = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf-8');
  const settingsJs = fs.readFileSync(path.join(PLUGIN, 'settings.js'), 'utf-8');
  const workerSrc = fs.readFileSync(WORKER, 'utf-8');

  assert.equal(/(^|[^a-zA-Z])fetch\(['"]\/kv/.test(mainJs), false, 'main.js 不得再读写 /kv');
  assert.equal(mainJs.includes('mirrorToKv'), false, 'KV 镜像必须删除');
  assert.ok(mainJs.includes('CHANNEL_OPS'), '设置页必须经通道读写 worker');
  assert.ok(settingsJs.includes('parseImportPayload') && settingsJs.includes('buildExportJson'));
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    assert.ok(workerSrc.includes(name), `worker 必须挡住保留键 ${name}`);
  }

  // shell:true 是命令注入面，必须保持显式包装
  const src = workerSrc.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.equal(/shell:\s*true/.test(src), false);
  assert.ok(/shell:\s*false/.test(src));
  assert.ok(src.includes('/bin/sh'));
  assert.ok(src.includes('ComSpec'));
});

test('v0.3.0 工具面保持 7 个，参数在 ghost.json / main.js / worker 三层对齐', () => {
  const ghost = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'ghost.json'), 'utf-8'));
  const mainJs = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf-8');
  const names = ghost.tools.map((t) => t.name).sort();
  const byName = Object.fromEntries(ghost.tools.map((t) => [t.name, t]));

  assert.equal(ghost.version, VERSION);
  assert.deepEqual(names, ['env_delete', 'env_exec', 'env_get', 'env_list', 'env_probe', 'env_set', 'env_write_file']);

  assert.ok(byName.env_list.parameters.properties.limit);
  assert.ok(mainJs.includes('limit: args.limit'));

  assert.ok(byName.env_set.parameters.properties.value_from, 'env_set 必须声明 value_from');
  assert.ok(mainJs.includes('value_from: args.value_from'));

  assert.ok(byName.env_write_file.parameters.required.includes('keys'), 'keys 必须必填');
  assert.ok(byName.env_write_file.parameters.properties.allow_outside_cwd);
  assert.ok(mainJs.includes('allow_outside_cwd: args.allow_outside_cwd'));

  assert.ok(byName.env_exec.parameters.properties.command_line);
  assert.ok(mainJs.includes('command_line: args.command_line'));
  assert.ok(byName.env_exec.parameters.properties.shell);
  assert.ok(mainJs.includes('shell: args.shell'));
  assert.ok(byName.env_exec.parameters.properties.stdin);
  assert.ok(mainJs.includes('stdin: args.stdin'));

  assert.ok(byName.env_probe.parameters.required.includes('keys'), 'probe keys 必须必填');
  assert.ok(byName.env_probe.parameters.properties.allow_private);
  assert.ok(mainJs.includes('allow_private: args.allow_private'));

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf-8'));
  assert.equal(manifest.plugins['my-env'].version, VERSION, 'manifest 与 ghost.json 版本必须一致');
});
