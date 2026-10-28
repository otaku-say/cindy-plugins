const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

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
