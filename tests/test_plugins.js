const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// cube-cli worker 默认启动服务；require 加载时（单测）用环境变量关闭
process.env.CUBE_CLI_WORKER_NO_SERVER = '1';

test('manifest.json matches plugins ghost.json', () => {
  const manifestPath = path.join(ROOT, 'scripts', 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json exists');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  assert.ok(manifest.plugins, 'manifest has plugins field');

  for (const [pid, pmeta] of Object.entries(manifest.plugins)) {
    const ghostPath = path.join(ROOT, 'plugins', pid, 'ghost.json');
    assert.ok(fs.existsSync(ghostPath), `ghost.json for ${pid} exists`);

    const ghost = JSON.parse(fs.readFileSync(ghostPath, 'utf-8'));
    assert.equal(ghost.id, pid, `ghost.id matches plugin id ${pid}`);
    assert.equal(ghost.version, pmeta.version, `version matches in manifest and ghost.json for ${pid}`);
    assert.ok(Array.isArray(ghost.tools) && ghost.tools.length > 0, `${pid} has registered tools`);
  }
});

test('main.js dispatches all registered tools in ghost.json for all plugins', () => {
  const plugins = ['cube-cli', 'aiod-cli', 'my-env'];
  for (const pid of plugins) {
    const ghost = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', pid, 'ghost.json'), 'utf-8'));
    const mainJs = fs.readFileSync(path.join(ROOT, 'plugins', pid, 'main.js'), 'utf-8');

    for (const tool of ghost.tools) {
      assert.ok(
        mainJs.includes(tool.name),
        `main.js in ${pid} includes dispatch entry for tool "${tool.name}"`
      );
    }
  }
});

test('worker.cjs findBinary does not delete heterogeneous binary dirs', () => {
  const standardPlatforms = [
    'macos-arm64', 'macos-amd64',
    'windows-amd64', 'windows-arm64',
    'linux-amd64', 'linux-arm64'
  ];

  for (const pid of ['cube-cli', 'aiod-cli']) {
    const binDir = path.join(ROOT, 'plugins', pid, 'bin');
    for (const plat of standardPlatforms) {
      const platDir = path.join(binDir, plat);
      assert.ok(fs.existsSync(platDir), `Binary dir ${platDir} must remain intact`);
    }
  }
});

test('tasks Map bounded eviction test', () => {
  const tasks = new Map();
  const MAX_TASKS = 50;
  function recordTask(taskId, record) {
    if (tasks.size >= MAX_TASKS) {
      for (const [id, t] of tasks) {
        if (t.completed) {
          tasks.delete(id);
          break;
        }
      }
    }
    tasks.set(taskId, record);
  }

  for (let i = 0; i < 50; i++) {
    recordTask(`task_${i}`, { completed: true });
  }
  assert.equal(tasks.size, 50);

  recordTask('task_50', { completed: false });
  assert.equal(tasks.size, 50);
  assert.ok(!tasks.has('task_0'), 'Oldest completed task_0 evicted');
  assert.ok(tasks.has('task_50'), 'New task_50 stored');
});

test('my-env maskValue logic test', () => {
  function maskValue(val) {
    if (!val) return '';
    if (val.length <= 6) return '••••••';
    return `${val.slice(0, 3)}••••${val.slice(-3)}`;
  }

  assert.equal(maskValue(''), '');
  assert.equal(maskValue('12345'), '••••••');
  assert.equal(maskValue('ghp_abcdef123456'), 'ghp••••456');
});

test('locales only reference fields declared in the manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf-8'));
  for (const pid of Object.keys(manifest.plugins)) {
    const ghost = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', pid, 'ghost.json'), 'utf-8'));
    assert.ok(ghost.locales && ghost.locales.en, `${pid} must declare locales.en`);
    const toolNames = new Set(ghost.tools.map((t) => t.name));
    for (const [lang, rel] of Object.entries(ghost.locales)) {
      const loc = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', pid, rel), 'utf-8'));
      for (const key of Object.keys(loc)) {
        assert.ok(['name', 'description', 'whenToUse', 'tools'].includes(key), `${pid}/${lang}: unknown key ${key}`);
      }
      for (const [toolName, toolLoc] of Object.entries(loc.tools || {})) {
        assert.ok(toolNames.has(toolName), `${pid}/${lang}: unknown tool ${toolName}`);
        for (const ptr of Object.keys(toolLoc.parameters || {})) {
          assert.ok(ptr.startsWith('/properties/'), `${pid}/${lang}/${toolName}: bad pointer ${ptr}`);
        }
      }
    }
  }
});

test('my-env keeps no bulk plaintext export and guards reserved keys', () => {
  const ghost = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'my-env', 'ghost.json'), 'utf-8'));
  assert.ok(!ghost.tools.some((t) => t.name === 'env_dump_for_sandbox'), 'bulk export tool must stay removed');
  const mainJs = fs.readFileSync(path.join(ROOT, 'plugins', 'my-env', 'main.js'), 'utf-8');
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    assert.ok(mainJs.includes(name), `main.js must guard reserved key ${name}`);
  }

  // 导出/导入只允许出现在设置页（用户手动触发），且导入同样要挡保留键
  const settingsJs = fs.readFileSync(path.join(ROOT, 'plugins', 'my-env', 'settings.js'), 'utf-8');
  assert.ok(settingsJs.includes('parseImportPayload') && settingsJs.includes('buildExportJson'),
    'settings page keeps manual export/import handlers');
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    assert.ok(settingsJs.includes(name), `settings.js must guard reserved key ${name} on import`);
  }
  assert.ok(!ghost.tools.some((t) => /dump|export|bulk/i.test(t.name)),
    'no bulk-read/export tool may appear on the Agent tool surface');
});

test('带 upstream 的插件必须在 main 分支内嵌全部平台二进制', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf-8'));
  for (const [pid, pmeta] of Object.entries(manifest.plugins)) {
    if (!pmeta.upstream) continue;
    const supported = pmeta.upstream.supported_platforms || Object.keys(manifest.platforms);
    for (const plat of supported) {
      const pinfo = manifest.platforms[plat];
      assert.ok(pinfo, `manifest.platforms 缺少 ${plat}`);
      const exe = pmeta.upstream.binary_name.replace('{ext}', pinfo.ext);
      const file = path.join(ROOT, 'plugins', pid, 'bin', plat, exe);
      assert.ok(fs.existsSync(file), `${pid} 缺少 ${plat} 的二进制: plugins/${pid}/bin/${plat}/${exe}`);
      assert.ok(fs.statSync(file).size > 100 * 1024, `${pid}/${plat} 二进制体积异常（疑似占位文件）`);
    }
  }
});

test('upstream 指向独立仓库，产物模板用 <tool>-<os>-<arch> 命名', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'manifest.json'), 'utf-8'));
  for (const [pid, pmeta] of Object.entries(manifest.plugins)) {
    if (!pmeta.upstream) continue;
    const up = pmeta.upstream;
    assert.ok(!/sandbox-cli/.test(up.repo), `${pid} 的 upstream 仍指向已拆分的 sandbox-cli`);
    assert.match(up.repo, /^otaku-say\/[a-z0-9-]+$/, `${pid} 的 upstream.repo 格式不对: ${up.repo}`);
    assert.ok(String(up.repo).endsWith(pid), `${pid} 的 upstream 应指向同名独立仓库，实际 ${up.repo}`);
    assert.ok(up.artifact_template.includes('{os}') && up.artifact_template.includes('{arch}'),
      `${pid} 的 artifact_template 必须用 {os}/{arch}（上游发布资产命名），实际 ${up.artifact_template}`);
    assert.ok(!up.artifact_template.includes('-{target}'),
      `${pid} 的 artifact_template 不能再按 zig 三元组拼文件名`);
  }
});

test('文档里不再出现已废弃的架构专属分支地址', () => {
  for (const rel of ['README.md', 'CONTRIBUTING.md']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    assert.ok(!text.includes('#plat/'), `${rel} 仍包含 #plat/ 分支地址`);
  }
});

test('my-env worker provides env_write_file and env_exec with zero plaintext in results and output redaction', async () => {
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-env-test-'));
  const workerFile = path.join(ROOT, 'plugins', 'my-env', 'node', 'worker.cjs');

  const proc = spawn('node', [workerFile], {
    env: { ...process.env, CINDY_HOME: tmpDir },
    stdio: ['pipe', 'pipe', 'inherit']
  });

  const readline = require('node:readline');
  const rl = readline.createInterface({ input: proc.stdout });

  const pending = new Map();
  let reqSeq = 1;

  rl.on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  function call(method, params) {
    const id = reqSeq++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  try {
    await call('env/set', { key: 'SECRET_TOKEN', value: 'wldkvf-02847-prm', sensitive: true });
    await call('env/set', { key: 'API_ENDPOINT', value: 'https://api.example.com', sensitive: false });

    const targetFile = path.join(tmpDir, 'project', '.env');
    const writeRes = await call('env/writeFile', { target_path: targetFile, format: 'dotenv' });
    assert.equal(writeRes.ok, true);
    assert.equal(writeRes.count, 2);
    assert.deepEqual(writeRes.written_keys.sort(), ['API_ENDPOINT', 'SECRET_TOKEN']);
    assert.equal(JSON.stringify(writeRes).includes('wldkvf-02847-prm'), false);

    const onDisk = fs.readFileSync(targetFile, 'utf8');
    assert.ok(onDisk.includes('SECRET_TOKEN="wldkvf-02847-prm"'));
    assert.ok(onDisk.includes('API_ENDPOINT="https://api.example.com"'));

    const execRes = await call('env/exec', {
      command: 'node',
      args: ['-e', 'console.log("RESULT:" + process.env.SECRET_TOKEN + " " + process.env.API_ENDPOINT)']
    });
    assert.equal(execRes.ok, true);
    assert.equal(execRes.exitCode, 0);
    assert.ok(execRes.stdout.includes('[REDACTED_SECRET]'));
    assert.ok(!execRes.stdout.includes('wldkvf-02847-prm'));
    assert.ok(execRes.stdout.includes('https://api.example.com'));
  } finally {
    proc.stdin.end();
    proc.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------- cube-cli 参数构建与元数据铁律 ----------------

const cubeWorker = require(path.join(ROOT, 'plugins', 'cube-cli', 'node', 'worker.cjs'));

const SID = 'sid00001abcd';

test('cube_new 强制 purpose/agent/dialogue，会话 ID 写入 metadata.task', () => {
  const p = cubeWorker.normalizeNewParams({
    purpose: '修复 my-env 转义 bug 并跑单测',
    agent: 'Cindy(主)',
    dialogue: 'bb5c7920-31b6-4ba7-9cf5-96bb2a29d4b1'
  });
  const body = JSON.parse(cubeWorker.buildCreateBody({ ...p, templateId: 'tpl-abc123' }));
  assert.equal(body.templateID, 'tpl-abc123');
  assert.equal(body.timeout, 1800);
  assert.equal(body.metadata.task, 'bb5c7920-31b6-4ba7-9cf5-96bb2a29d4b1');
  assert.equal(body.metadata.dialogue, undefined, '会话 ID 只写 task，不再写 dialogue 键');
  assert.equal(body.metadata.agent, 'Cindy(主)');
  // note 只写中文用途短句，不得混入 agent / 会话 ID
  assert.equal(body.metadata.note, '修复 my-env 转义 bug 并跑单测');
  assert.ok(!body.metadata.note.includes('dialogue=') && !body.metadata.note.includes('Cindy('));
  assert.equal(body.metadata.cli, 'cube-cli');
});

test('cube_new 缺字段/非中文用途/非法值都报明确错误', () => {
  const base = { purpose: '验证构建脚本', agent: 'Cindy(主)', dialogue: 'abc123' };
  assert.throws(() => cubeWorker.normalizeNewParams({ agent: 'a', dialogue: 'd' }), /purpose 必填/);
  assert.throws(() => cubeWorker.normalizeNewParams({ purpose: 'run tests', agent: 'a', dialogue: 'd' }), /必须使用中文/);
  assert.throws(() => cubeWorker.normalizeNewParams({ purpose: '验证', dialogue: 'd' }), /agent 必填/);
  assert.throws(() => cubeWorker.normalizeNewParams({ purpose: '验证', agent: 'a' }), /dialogue 必填/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, need: 'gpu' }), /need 只能是/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, env: { 'bad-key': 'x' } }), /env 变量名非法/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, purpose: '验'.repeat(61) }), /purpose 过长/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, purpose: '验证 dialogue=abc' }), /只写用途/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, purpose: '验证 agent=Cindy' }), /只写用途/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, purpose: '验证 dialogue＝abc' }), /只写用途/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, purpose: '验证 dialogue\u200b=abc' }), /只写用途/);
  // 类型严格：不做隐式 String()
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, purpose: ['验证'] }), /必须是字符串/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, agent: {} }), /必须是字符串/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, dialogue: 123 }), /必须是字符串/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, dialogue: 'has space' }), /dialogue 只能是/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, need: ['code'] }), /need 必须是字符串/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, timeoutSeconds: true }), /timeoutSeconds 必须是整数/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, template: '--header=X:1' }), /template 只能是/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, volume: 'a:b:c' }), /只能有一个冒号/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, volume: 'a:relative' }), /绝对路径/);
  assert.throws(() => cubeWorker.normalizeNewParams({ ...base, volume: 'a:/mnt/../etc' }), /不能包含 \.\./);
  assert.throws(() => cubeWorker.normalizeNewParams(null), /params 必须是对象/);
});

test('cube_new 选项映射与上限（need/timeout/noInternet/volume/env）', () => {
  const p = cubeWorker.normalizeNewParams({
    purpose: '浏览器截图验证',
    agent: 'worker-2(子)',
    dialogue: 'd-1',
    need: 'browser',
    timeoutSeconds: 600,
    template: 'aio-browser',
    noInternet: true,
    volume: 'data:/mnt/data',
    env: { TOKENLESS: '1' }
  });
  const body = JSON.parse(cubeWorker.buildCreateBody({ ...p, templateId: 'tpl-x' }));
  assert.equal(body.timeout, 600);
  assert.equal(body.allow_internet_access, false);
  assert.deepEqual(body.volumeMounts, [{ name: 'data', path: '/mnt/data' }]);
  assert.deepEqual(body.envVars, { TOKENLESS: '1' });
  const clamped = cubeWorker.normalizeNewParams({ purpose: '验证', agent: 'a', dialogue: 'd', timeoutSeconds: 999999999 });
  assert.equal(clamped.timeout, 86400, 'timeout 必须夹到上限');
  const defVol = JSON.parse(cubeWorker.buildCreateBody({ ...cubeWorker.normalizeNewParams({ purpose: '验证', agent: 'a', dialogue: 'd', volume: 'data' }), templateId: 'tpl-x' }));
  assert.deepEqual(defVol.volumeMounts, [{ name: 'data', path: '/mnt/data' }]);
});

test('cube_new 控制面响应解析出 sandboxId / gateway / aiodBase', () => {
  const stdout = JSON.stringify({ templateID: 'tpl-abc123', sandboxID: 'cd1e093c8f1f403a9b829d3c995103c2', domain: 'cube.app' });
  const parsed = cubeWorker.parseCreateResponse(stdout, 'https://cubesandbox-proxy.4a8a.com/', '8080');
  assert.equal(parsed.sandboxId, 'cd1e093c8f1f403a9b829d3c995103c2');
  assert.equal(parsed.gatewayUrl, '/sandbox/cd1e093c8f1f403a9b829d3c995103c2/8080/');
  assert.equal(parsed.aiodBase, 'https://cubesandbox-proxy.4a8a.com/sandbox/cd1e093c8f1f403a9b829d3c995103c2/8080/');
  assert.throws(() => cubeWorker.parseCreateResponse('HTTP 500: boom', 'https://p', '8080'), /合法 JSON/);
  assert.throws(() => cubeWorker.parseCreateResponse('{"domain":"cube.app"}', 'https://p', '8080'), /sandboxID/);
  assert.throws(() => cubeWorker.parseCreateResponse('{"sandboxID":"../../evil"}', 'https://p', '8080'), /sandboxID/);
});

test('cube_exec 参数：-- 分隔、默认 100 秒、cwd 绝对路径、env', () => {
  const args = cubeWorker.buildExecArgs({ sandboxId: SID, command: 'ls -la' });
  assert.deepEqual(args, [SID, '--timeout=100', '--', 'ls -la']);
  const full = cubeWorker.buildExecArgs({ sandboxId: SID, command: 'npm test', cwd: '/root/app', env: { CI: '1' }, timeoutSeconds: 60 });
  assert.deepEqual(full, [SID, '--timeout=60', '--cwd=/root/app', '--env=CI=1', '--', 'npm test']);
  const dash = cubeWorker.buildExecArgs({ sandboxId: SID, command: '--env=FOO=bar' });
  assert.equal(dash.at(-1), '--env=FOO=bar');
  assert.equal(dash.at(-2), '--');
  assert.throws(() => cubeWorker.buildExecArgs({ sandboxId: SID }), /command 必填/);
  assert.throws(() => cubeWorker.buildExecArgs({ command: 'ls' }), /sandboxId 必填/);
  assert.throws(() => cubeWorker.buildExecArgs({ sandboxId: 'short', command: 'ls' }), /sandboxId 格式/);
  assert.throws(() => cubeWorker.buildExecArgs({ sandboxId: SID, command: 'ls', cwd: 'relative' }), /绝对路径/);
  const clamped = cubeWorker.buildExecArgs({ sandboxId: SID, command: 'x', timeoutSeconds: 100000 });
  assert.ok(clamped.includes('--timeout=100'));
});

test('cube_code 语言别名与非法语言', () => {
  assert.ok(cubeWorker.buildCodeArgs({ sandboxId: SID, code: 'print(1)' }).includes('--lang=python'));
  assert.ok(cubeWorker.buildCodeArgs({ sandboxId: SID, code: '1', language: 'javascript' }).includes('--lang=js'));
  assert.ok(cubeWorker.buildCodeArgs({ sandboxId: SID, code: 'echo', language: 'sh' }).includes('--lang=bash'));
  const args = cubeWorker.buildCodeArgs({ sandboxId: SID, code: '-print(1)' });
  assert.equal(args.at(-1), '-print(1)');
  assert.equal(args.at(-2), '--');
  assert.throws(() => cubeWorker.buildCodeArgs({ sandboxId: SID, code: 'x', language: 'ruby' }), /language 只支持/);
  assert.throws(() => cubeWorker.buildCodeArgs({ sandboxId: SID, code: '   ' }), /code 必填/);
});

test('cube_write_file / cube_read_file 路径与容量保护', () => {
  const w = cubeWorker.buildWriteArgs({ sandboxId: SID, path: '/root/a.py', content: 'print(1)\n' });
  assert.deepEqual(w.args, [SID, '-', '/root/a.py']);
  assert.equal(w.bytes, 9);
  assert.throws(() => cubeWorker.buildWriteArgs({ sandboxId: SID, path: '/a' }), /content 必填/);
  assert.throws(() => cubeWorker.buildWriteArgs({ sandboxId: SID, content: 'x' }), /path 必填/);
  assert.throws(() => cubeWorker.buildWriteArgs({ sandboxId: SID, path: 'relative.py', content: 'x' }), /绝对路径/);
  assert.throws(() => cubeWorker.buildWriteArgs({ sandboxId: SID, path: '/a', content: 'x'.repeat(cubeWorker.MAX_WRITE_BYTES + 1) }), /content 过大/);
  const r = cubeWorker.buildReadArgs({ sandboxId: SID, path: '/root/a.log' });
  assert.deepEqual(r.args, [SID, '/root/a.log']);
  assert.equal(r.maxBytes, cubeWorker.MAX_OUTPUT);
  assert.equal(cubeWorker.buildReadArgs({ sandboxId: SID, path: '/a', maxBytes: 99999999 }).maxBytes, 1024 * 1024);
  assert.throws(() => cubeWorker.buildReadArgs({ sandboxId: SID, path: '/a', maxBytes: 'x' }), /maxBytes 必须是整数/);
});

test('cube_ls 支持元数据过滤与状态/数量', () => {
  assert.deepEqual(cubeWorker.buildLsArgs({}), []);
  assert.deepEqual(cubeWorker.buildLsArgs({ metadata: 'task=abc-1' }), ['--metadata=task=abc-1']);
  assert.deepEqual(cubeWorker.buildLsArgs({ metadata: 'task=abc-1,agent=Cindy(主)', state: 'running', limit: 20, v2: true }), [
    '--metadata=task=abc-1,agent=Cindy(主)',
    '--state=running',
    '--limit=20',
    '--v2'
  ]);
  // limit 只有 v2 生效：传 limit 时必须自动带 --v2
  assert.deepEqual(cubeWorker.buildLsArgs({ limit: 20 }), ['--limit=20', '--v2']);
  assert.throws(() => cubeWorker.buildLsArgs({ metadata: 'bad meta' }), /metadata 格式/);
  assert.throws(() => cubeWorker.buildLsArgs({ state: 'Running' }), /state 只能是/);
  assert.throws(() => cubeWorker.buildLsArgs({ limit: 'x' }), /limit 必须是整数/);
  assert.throws(() => cubeWorker.buildLsArgs({ limit: 1.5 }), /limit 必须是整数/);
});

test('创建沙箱只能走 cube_new：new/clone/raw 创建都被拦', () => {
  assert.throws(() => cubeWorker.assertCreateInvocation('new', []), /请用 cube_new/);
  assert.throws(() => cubeWorker.assertCreateInvocation('clone', [SID]), /clone/);
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['POST', '/sandboxes']), /不允许/);
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['post', '/v2/sandboxes?x=1']), /不允许/);
  // 前置 flag / 路径变体不能绕过
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['--json', 'POST', '/sandboxes']), /不允许/);
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['--', 'POST', '/sandboxes']), /不允许/);
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['POST', '//sandboxes']), /不允许/);
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['POST', '/sandboxes/../sandboxes']), /不允许/);
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['POST', '/Sandboxes']), /不允许/);
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['POST', '/sandboxes%2F']), /不允许/);
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['POST', '/sandboxes#frag']), /不允许/);
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['POST', '/v2/sandboxes#x']), /不允许/);
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['POST', '/sandboxes', '--body=@/etc/passwd']), /禁止/);
  assert.throws(() => cubeWorker.assertCreateInvocation('raw', ['GET', '/sandboxes', '--body=-']), /禁止/);
  assert.throws(() => cubeWorker.assertCreateInvocation('write', [SID, 'C:/secret.txt', '/root/x']), /宿主本地文件/);
  assert.throws(() => cubeWorker.assertCreateInvocation('write-files', [SID, '--files=/root/a:./a']), /宿主本地文件/);
  assert.throws(() => cubeWorker.assertCreateInvocation('write', [SID, '-', '/root/x']), /cube_write_file/);
  assert.doesNotThrow(() => cubeWorker.assertCreateInvocation('raw', ['POST', `/sandboxes/${SID}/network`]));
  assert.doesNotThrow(() => cubeWorker.assertCreateInvocation('info', [SID]));
  assert.throws(() => cubeWorker.assertNoBareEnvArgs(['exec', SID, 'printenv', '--env=CUBESANDBOX_API_KEY']), /不带值/);
  assert.doesNotThrow(() => cubeWorker.assertNoBareEnvArgs(['exec', SID, 'printenv', '--env=FOO=bar']));
});

test('help 旗标不会伪装成成功执行', () => {
  assert.throws(() => cubeWorker.buildExecArgs({ sandboxId: SID, command: '--help' }), /help/);
  assert.throws(() => cubeWorker.buildExecArgs({ sandboxId: SID, command: '-h' }), /help/);
  assert.throws(() => cubeWorker.buildCodeArgs({ sandboxId: SID, code: 'help' }), /help/);
  assert.doesNotThrow(() => cubeWorker.buildExecArgs({ sandboxId: SID, command: 'helpful-cmd --help' }));
});

test('cube-cli 工具面与密钥注入方法一致', () => {
  const ghost = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'cube-cli', 'ghost.json'), 'utf-8'));
  const names = ghost.tools.map((t) => t.name);
  for (const required of ['cube_new', 'cube_ls', 'cube_rm', 'cube_exec', 'cube_code', 'cube_write_file', 'cube_read_file', 'cube_run', 'cube_health', 'cube_submit', 'cube_log', 'cube_kill']) {
    assert.ok(names.includes(required), `缺少工具 ${required}`);
  }
  assert.ok(!names.includes('cube_version'), 'cube_version 应已并入 cube_health');

  const newTool = ghost.tools.find((t) => t.name === 'cube_new');
  assert.deepEqual(newTool.parameters.required, ['purpose', 'agent', 'dialogue']);

  const mainJs = fs.readFileSync(path.join(ROOT, 'plugins', 'cube-cli', 'main.js'), 'utf-8');
  const methods = [...mainJs.matchAll(/method:\s*'(cube\/[a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(methods.length > 0, 'main.js 必须声明 cube/* 方法');
  const bound = new Set(ghost.node.secretBindings[0].methods);
  for (const method of new Set(methods)) {
    assert.ok(bound.has(method), `secretBindings.methods 缺少 ${method}（否则新工具拿不到 API Key）`);
  }
});

test('cube-cli 文档与工具面同步', () => {
  const manual = fs.readFileSync(path.join(ROOT, 'plugins', 'cube-cli', 'manual', 'guide', 'MANUAL.md'), 'utf-8');
  for (const tool of ['cube_new', 'cube_exec', 'cube_code', 'cube_write_file', 'cube_read_file', 'cube_ls', 'cube_rm', 'cube_health', 'cube_run']) {
    assert.ok(manual.includes(tool), `MANUAL.md 缺少 ${tool}`);
  }
  assert.ok(manual.includes('metadata.task') || manual.includes('metadata=task='), 'MANUAL.md 必须写明会话 ID 写入 metadata.task');
});

test('cube-cli 宿主 RPC 预算不超过硬约束（timeoutMs<=120000, maxTotalMs>=timeoutMs）', () => {
  const mainJs = fs.readFileSync(path.join(ROOT, 'plugins', 'cube-cli', 'main.js'), 'utf-8');
  const budgets = [...mainJs.matchAll(/budget\((\d+),\s*(\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(budgets.length >= 10, `budget() 调用太少: ${budgets.length}`);
  for (const [timeoutMs, maxTotalMs] of budgets) {
    assert.ok(timeoutMs <= 120000, `timeoutMs 越界: ${timeoutMs}`);
    assert.ok(maxTotalMs >= timeoutMs, `maxTotalMs(${maxTotalMs}) < timeoutMs(${timeoutMs})`);
    assert.ok(maxTotalMs <= 900000, `maxTotalMs 越界: ${maxTotalMs}`);
  }
  assert.ok(!/timeoutMs:\s*\d{6,}/.test(mainJs), 'main.js 不应出现 >= 6 位的裸 timeoutMs 字面量');
  const ghost = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'cube-cli', 'ghost.json'), 'utf-8'));
  const execTool = ghost.tools.find((t) => t.name === 'cube_exec');
  assert.match(execTool.parameters.properties.timeoutSeconds.description, /100/);
  const lsTool = ghost.tools.find((t) => t.name === 'cube_ls');
  assert.ok(lsTool.parameters.properties.metadata, 'cube_ls 必须支持 metadata 过滤');
});


test('cube-cli worker 被宿主 require 加载时也会启动 JSON-RPC 服务', async () => {
  const { spawn } = require('node:child_process');
  const worker = path.join(ROOT, 'plugins', 'cube-cli', 'node', 'worker.cjs');
  const env = { ...process.env };
  delete env.CUBE_CLI_WORKER_NO_SERVER;
  const proc = spawn(process.execPath, ['-e', 'require(process.argv[1])', worker], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  const reply = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`worker 未在 8s 内响应（这是宿主 require 加载路径的回归）stderr=${err.slice(0, 400)}`)), 8000);
    proc.stdout.on('data', (d) => {
      out += d.toString();
      const line = out.split('\n').find((l) => l.trim());
      if (!line) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
    });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'cube/ping', params: {} }) + '\n');
  }).finally(() => { try { proc.kill(); } catch (_) {} });

  assert.equal(reply.id, 1, JSON.stringify(reply));
  assert.equal(reply.result.ok, true);
  assert.equal(typeof reply.result.pid, 'number');
  assert.ok(Array.isArray(reply.result.methods) && reply.result.methods.includes('cube/ping'));
});
