// plugins/aiod-cli/main.js —— aiod-cli 沙箱内操作插件电子脑（浏览器沙箱）

async function getKvConfig() {
  try {
    const res = await fetch('/kv');
    if (!res.ok) return {};
    const data = await res.json();
    return data || {};
  } catch (e) {
    return {};
  }
}

const LONG_TASK = { timeoutMs: 60000, maxTotalMs: 900000 };

const TOOL_DISPATCH = {
  aiod_version: () => ({ method: 'aiod/run', params: { cmd: 'version', args: [] }, timeoutMs: 15000 }),
  aiod_health: () => ({ method: 'aiod/health', params: {}, timeoutMs: 30000 }),
  aiod_run: (args) => ({
    method: 'aiod/run',
    params: {
      cmd: args.cmd,
      args: Array.isArray(args.args) ? args.args : [],
      maxOutput: args.maxOutputBytes
    },
    ...LONG_TASK
  }),
  aiod_exec: (args) => ({
    method: 'aiod/exec',
    params: {
      command: args.command,
      cwd: args.cwd,
      shell: args.shell,
      timeoutSec: args.timeoutSec,
      maxOutputBytes: args.maxOutputBytes,
      separateStderr: args.separateStderr,
      commandEnv: args.env
    },
    ...LONG_TASK
  }),
  aiod_write_file: (args) => ({
    method: 'aiod/write-file',
    params: { path: args.path, content: args.content, append: args.append },
    ...LONG_TASK
  }),
  aiod_write_stream: (args) => ({
    method: 'aiod/write-stream',
    params: { path: args.path, uploadId: args.uploadId, content: args.content, begin: args.begin, final: args.final },
    ...LONG_TASK
  }),
  aiod_stat: (args) => ({
    method: 'aiod/stat',
    params: { path: args.path },
    timeoutMs: 60000
  }),
  aiod_read_file: (args) => ({
    method: 'aiod/read-file',
    params: {
      path: args.path,
      startLine: args.startLine,
      startByte: args.startByte,
      tail: args.tail,
      maxLines: args.maxLines,
      maxBytes: args.maxBytes,
      allowPartial: args.allowPartial,
      exact: args.exact
    },
    ...LONG_TASK
  }),
  aiod_edit_file: (args) => ({
    method: 'aiod/edit-file',
    params: {
      path: args.path,
      old: args.old,
      new: args.new,
      mode: args.mode,
      insertLine: args.insertLine,
      text: args.text,
      allowPartialMismatch: args.allowPartialMismatch
    },
    ...LONG_TASK
  }),
  aiod_upload: (args) => ({
    method: 'aiod/transfer',
    params: {
      direction: 'put',
      localPath: args.localPath,
      remotePath: args.remotePath,
      overwrite: args.overwrite
    },
    ...LONG_TASK
  }),
  aiod_download: (args) => ({
    method: 'aiod/transfer',
    params: { direction: 'get', localPath: args.localPath, remotePath: args.remotePath },
    ...LONG_TASK
  }),
  aiod_submit: (args) => ({
    method: 'aiod/submit',
    params: {
      command: args.command,
      cwd: args.cwd,
      shell: args.shell,
      timeoutSec: args.timeoutSec,
      commandEnv: args.env,
      cmd: args.cmd,
      args: args.args
    },
    timeoutMs: 60000,
    maxTotalMs: 300000
  }),
  aiod_log: (args) => ({
    method: 'aiod/log',
    params: {
      taskId: args.taskId,
      commandId: args.commandId,
      offset: args.offset,
      tail: args.tail,
      wait: args.wait,
      waitTimeoutSec: args.waitTimeoutSec
    },
    timeoutMs: 60000,
    maxTotalMs: 300000
  }),
  aiod_kill: (args) => ({ method: 'aiod/kill', params: { taskId: args.taskId, commandId: args.commandId }, timeoutMs: 30000 })
};

cindy.onHostMessage(async (msg) => {
  if (!msg || msg.type !== 'tool-call') return;

  const { tool, args = {}, callId } = msg;
  const dispatch = TOOL_DISPATCH[tool];
  if (!dispatch) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: `未知工具: ${tool}` });
    return;
  }

  try {
    const kv = await getKvConfig();
    const env = {
      SANDBOX_BASE: (args && args.base) || kv.SANDBOX_BASE || ''
    };

    const req = dispatch(args);
    const resp = await cindy.node.request({
      method: req.method,
      params: { ...req.params, env },
      callId,
      cancelWithCall: false,
      timeoutMs: req.timeoutMs || 15000,
      ...(req.maxTotalMs ? { maxTotalMs: req.maxTotalMs } : {})
    });

    if (!resp.ok) throw new Error(resp.message || '执行失败');
    cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
  } catch (err) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: err.message || String(err) });
  }
});
