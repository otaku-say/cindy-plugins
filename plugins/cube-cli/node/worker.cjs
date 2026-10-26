// plugins/cube-cli/node/worker.cjs —— 随包 Node 工作进程
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function log(msg) {
  process.stderr.write(`[cube-worker] ${msg}\n`);
}

function reply(id, result, error) {
  const resp = { jsonrpc: '2.0', id };
  if (error) resp.error = error;
  else resp.result = result;
  process.stdout.write(JSON.stringify(resp) + '\n');
}

function findBinary() {
  const isWin = process.platform === 'win32';
  const ext = isWin ? '.exe' : '';
  const exeName = `cube-cli${ext}`;

  const candidates = [
    path.resolve(__dirname, '..', 'bin', exeName),
    path.resolve(__dirname, '..', 'bin', `${process.platform}-${process.arch}`, exeName),
    path.resolve(__dirname, '..', exeName)
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        fs.accessSync(c, fs.constants.X_OK);
      } catch (_) {
        try { fs.chmodSync(c, 0o755); } catch (e) {}
      }
      return c;
    }
  }
  return exeName;
}

const tasks = new Map(); // taskId -> { process, logs: [], exitCode: null, completed: false, startTime }

function buildEnv(request) {
  const env = { ...process.env, ...(request.params?.env || {}) };
  const secretKey = request.cindy?.secrets?.cubesandbox_api_key;
  if (secretKey) {
    env.CUBESANDBOX_API_KEY = secretKey;
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

  const { id, method, params } = request;

  if (method === 'cube/run' || method === 'cube/health') {
    const bin = findBinary();
    const env = buildEnv(request);
    const cmd = method === 'cube/health' ? 'health' : (params.cmd || 'version');
    const args = method === 'cube/health' ? [] : (Array.isArray(params.args) ? params.args : []);
    const fullArgs = [cmd, ...args];

    log(`Spawning ${bin} ${cmd}`);

    const proc = spawn(bin, fullArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const MAX_OUTPUT = 256 * 1024; // 256KB 截断保护

    proc.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf-8');
    });
    proc.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf-8');
    });

    proc.on('error', (err) => {
      log(`Process error: ${err.message}`);
      reply(id, null, { code: -32001, message: `启动 CLI 失败: ${err.message}` });
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

  if (method === 'cube/submit') {
    const bin = findBinary();
    const env = buildEnv(request);
    const cmd = params.cmd || 'ls';
    const args = Array.isArray(params.args) ? params.args : [];
    const fullArgs = [cmd, ...args];
    const taskId = `cube_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

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
    tasks.set(taskId, taskRecord);

    const appendLog = (text) => {
      const lines = text.split('\n');
      for (const l of lines) {
        if (l) {
          taskRecord.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${l}`);
          if (taskRecord.logs.length > 2000) taskRecord.logs.shift(); // 保留最新 2000 行
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

  if (method === 'cube/log') {
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

  if (method === 'cube/kill') {
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
