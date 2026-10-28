// Plugin-specific guarantees for subagent-router: idempotency and no residue.
// Spawns the real worker over stdio against a throw-away Cindy home, so this
// exercises the shipped code path instead of a re-implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PLUGIN = path.resolve(__dirname, '..', 'plugins', 'subagent-router');
const WORKER = path.join(PLUGIN, 'node', 'worker.cjs');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-'));
  fs.mkdirSync(path.join(home, 'pi-package-home'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'pi-package-home', 'settings.json'),
    JSON.stringify({ packages: ['npm:keep-me'] }, null, 2) + '\n',
  );
  return home;
}

function call(home, method, params) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      env: { ...process.env, CINDY_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', reject);
    child.on('close', () => {
      const line = out.split('\n').filter(Boolean)[0];
      if (!line) return reject(new Error('worker produced no output'));
      const msg = JSON.parse(line);
      if (msg.error) return reject(new Error(msg.error.message));
      resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} }) + '\n');
    child.stdin.end();
  });
}

const readSettings = (home) => JSON.parse(fs.readFileSync(path.join(home, 'pi-package-home', 'settings.json'), 'utf8'));

test('install is idempotent and keeps unrelated entries', async () => {
  const home = makeHome();
  try {
    const first = await call(home, 'install');
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);

    const afterFirst = readSettings(home);
    assert.equal(afterFirst.packages.filter((e) => e.includes('cindy-extensions')).length, 1, 'exactly one injected entry');
    assert.ok(afterFirst.packages.includes('npm:keep-me'), 'unrelated entry preserved');
    assert.ok(fs.existsSync(path.join(home, 'cindy-extensions', 'subagent-router', 'index.js')), 'extension written');

    const second = await call(home, 'install');
    assert.equal(second.ok, true);
    assert.equal(second.changed, false, 'second install reports no change');
    assert.deepEqual(readSettings(home), afterFirst, 'settings unchanged on second install');

    const status = await call(home, 'status');
    assert.equal(status.injected, true);
    assert.equal(status.duplicateEntries, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install repairs duplicates instead of adding more', async () => {
  const home = makeHome();
  try {
    await call(home, 'install');
    const dir = path.join(home, 'cindy-extensions', 'subagent-router').replace(/\\/g, '/');
    const settings = readSettings(home);
    settings.packages.push(dir, dir);
    fs.writeFileSync(path.join(home, 'pi-package-home', 'settings.json'), JSON.stringify(settings, null, 2));

    const statusBefore = await call(home, 'status');
    assert.equal(statusBefore.duplicateEntries, 2, 'two extra entries are visible as duplicates');

    await call(home, 'install');
    const matches = readSettings(home).packages.filter((e) => e === dir);
    assert.equal(matches.length, 1, 'duplicates collapsed to one');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall removes entry and files, and is idempotent', async () => {
  const home = makeHome();
  try {
    await call(home, 'install');
    const first = await call(home, 'uninstall');
    assert.equal(first.changed, true);
    assert.deepEqual(readSettings(home).packages, ['npm:keep-me'], 'only the injected entry was removed');
    assert.equal(fs.existsSync(path.join(home, 'cindy-extensions', 'subagent-router')), false, 'extension dir deleted');

    const second = await call(home, 'uninstall');
    assert.equal(second.changed, false, 'second uninstall reports nothing to do');
    assert.deepEqual(readSettings(home).packages, ['npm:keep-me']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('config/set normalises input and config/get round-trips', async () => {
  const home = makeHome();
  try {
    await call(home, 'install');
    const set = await call(home, 'config/set', {
      config: {
        defaultGroupId: 'free',
        groups: [
          { id: 'free', name: '免费', description: '默认使用', models: [{ id: 'group/gemini-3.8-flash', provider: 'magpie', name: 'Gemini' }, { id: 'group/gemini-3.8-flash' }] },
          { id: 'Bad Id!', name: 'nope', models: [] },
          { id: 'flagship', name: '旗舰', description: '最难的任务', models: [{ id: 'group/kimi-k3', provider: 'magpie' }] },
        ],
      },
    });
    assert.equal(set.ok, true);
    assert.equal(set.config.groups.length, 2, 'invalid group id dropped');
    assert.equal(set.config.groups[0].models.length, 1, 'duplicate model collapsed');
    assert.equal(set.config.defaultGroupId, 'free');

    const got = await call(home, 'config/get');
    assert.deepEqual(got.config.groups.map((g) => g.id), ['free', 'flagship']);

    const again = await call(home, 'config/set', { config: got.config });
    assert.equal(again.changed, false, 're-saving the same config is a no-op');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('missing Cindy home fails closed without writing anything', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-empty-'));
  try {
    const res = await call(empty, 'install');
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'CINDY_HOME_NOT_FOUND');
    assert.deepEqual(fs.readdirSync(empty), [], 'no files created');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
