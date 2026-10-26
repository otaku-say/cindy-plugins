// plugins/aiod-cli/node/worker.cjs —— 随包 Node 工作进程
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function log(msg) {
  process.stderr.write(`[aiod-worker] ${msg}\n`);
}

function reply(id, result, error) {
  const resp = { jsonrpc: '2.0', id };
  if (error) resp.error = error;
  else resp.result = result;
  process.stdout.write(JSON.stringify(resp) + '\n');
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
  const exeName = `aiod-cli${ext}`;
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

const tasks = new Map();
const MAX_TASKS = 50; // 限制后台驻留任务数，避免高负载下内存泄漏

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

function buildEnv(request) {
  const env = { ...process.env, ...(request.params?.env || {}) };
  const secretKey = request.cindy?.secrets?.sandbox_key;
  if (secretKey) {
    env.SANDBOX_KEY = secretKey;
  }
  return env;
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line || !line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    return;
  }

  const { id, method, params = {} } = request;

  if (method === 'aiod/run' || method === 'aiod/health') {
    const bin = findBinary();
    const env = buildEnv(request);
    const cmd = method === 'aiod/health' ? 'health' : (params.cmd || 'version');
    const args = method === 'aiod/health' ? [] : (Array.isArray(params.args) ? params.args : []);
    const fullArgs = [cmd, ...args];

    log(`Spawning ${bin} ${cmd}`);

    const proc = spawn(bin, fullArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const MAX_OUTPUT = 256 * 1024;

    proc.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += d.toString('utf-8');
      } else if (!stdoutTruncated) {
        stdout += '\n[... stdout truncated at 256KB ...]';
        stdoutTruncated = true;
      }
    });
    proc.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += d.toString('utf-8');
      } else if (!stderrTruncated) {
        stderr += '\n[... stderr truncated at 256KB ...]';
        stderrTruncated = true;
      }
    });

    proc.on('error', (err) => {
      log(`Process error: ${err.message}`);
      reply(id, null, { code: -32001, message: `启动 aiod-cli 失败: ${err.message}` });
    });

    proc.on('close', (code) => {
      reply(id, {
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code || 0
      });
    });
    return;
  }

  if (method === 'aiod/submit') {
    const bin = findBinary();
    const env = buildEnv(request);
    const cmd = params.cmd || 'exec';
    const args = Array.isArray(params.args) ? params.args : [];
    const fullArgs = [cmd, ...args];
    const taskId = `aiod_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    log(`Submitting background task ${taskId}: ${bin} ${cmd}`);
    const proc = spawn(bin, fullArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const taskRecord = {
      taskId,
      cmd,
      args,
      process: proc,
      logs: [],
      exitCode: null,
      completed: false,
      startTime: Date.now()
    };
    recordTask(taskId, taskRecord);

    const appendLog = (text) => {
      const lines = text.split('\n');
      for (const l of lines) {
        if (l) {
          taskRecord.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${l}`);
          if (taskRecord.logs.length > 2000) taskRecord.logs.shift();
        }
      }
    };

    proc.stdout.on('data', (d) => appendLog(d.toString('utf-8')));
    proc.stderr.on('data', (d) => appendLog(d.toString('utf-8')));

    proc.on('close', (code) => {
      taskRecord.completed = true;
      taskRecord.exitCode = code;
      log(`Task ${taskId} finished with code ${code}`);
    });

    proc.on('error', (err) => {
      taskRecord.completed = true;
      taskRecord.exitCode = -1;
      appendLog(`Error: ${err.message}`);
    });

    reply(id, {
      taskId,
      cmd,
      status: 'running',
      message: `异步任务已提交 (ID: ${taskId})`
    });
    return;
  }

  if (method === 'aiod/log') {
    const { taskId, offset = 0 } = params || {};
    const task = tasks.get(taskId);
    if (!task) {
      reply(id, null, { code: -32002, message: `任务不存在: ${taskId}` });
      return;
    }
    const currentLogs = task.logs.slice(offset);
    reply(id, {
      taskId,
      status: task.completed ? 'completed' : 'running',
      completed: task.completed,
      exitCode: task.exitCode,
      logs: currentLogs,
      nextOffset: offset + currentLogs.length,
      totalLines: task.logs.length
    });
    return;
  }

  if (method === 'aiod/kill') {
    const { taskId } = params || {};
    const task = tasks.get(taskId);
    if (!task) {
      reply(id, null, { code: -32002, message: `任务不存在: ${taskId}` });
      return;
    }
    if (!task.completed && task.process) {
      try {
        task.process.kill('SIGTERM');
      } catch (e) {
        try { task.process.kill('SIGKILL'); } catch (_) {}
      }
    }
    task.completed = true;
    reply(id, { taskId, killed: true });
    return;
  }

  reply(id, null, { code: -32601, message: `Method not found: ${method}` });
});
