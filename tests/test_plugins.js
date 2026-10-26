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

test('main.js dispatches all registered tools in ghost.json', () => {
  const plugins = ['cube-cli', 'aiod-cli'];
  for (const pid of plugins) {
    const ghost = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', pid, 'ghost.json'), 'utf-8'));
    const mainJs = fs.readFileSync(path.join(ROOT, 'plugins', pid, 'main.js'), 'utf-8');

    for (const tool of ghost.tools) {
      assert.ok(
        mainJs.includes(`${tool.name}:`),
        `main.js in ${pid} includes dispatch entry for tool "${tool.name}"`
      );
    }
  }
});

test('worker.cjs findBinary does not delete heterogeneous binary dirs', () => {
  // 验证各插件 bin/ 下的多架构目录依然完整存在，未被篡改清除
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

  // 插入 50 个已完成任务
  for (let i = 0; i < 50; i++) {
    recordTask(`task_${i}`, { completed: true });
  }
  assert.equal(tasks.size, 50);

  // 再插入第 51 个，应剔除最早完成的
  recordTask('task_50', { completed: false });
  assert.equal(tasks.size, 50);
  assert.ok(!tasks.has('task_0'), 'Oldest completed task_0 evicted');
  assert.ok(tasks.has('task_50'), 'New task_50 stored');
});
