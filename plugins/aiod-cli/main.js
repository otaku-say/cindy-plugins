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

const TOOL_DISPATCH = {
  aiod_version: () => ({ method: 'aiod/run', params: { cmd: 'version', args: [] }, timeoutMs: 15000 }),
  aiod_health: () => ({ method: 'aiod/health', params: {}, timeoutMs: 30000 }),
  aiod_run: (args) => ({ method: 'aiod/run', params: { cmd: args.cmd, args: Array.isArray(args.args) ? args.args : [] }, timeoutMs: 60000, maxTotalMs: 900000 }),
  aiod_submit: (args) => ({ method: 'aiod/submit', params: { cmd: args.cmd, args: Array.isArray(args.args) ? args.args : [] }, cancelWithCall: false, timeoutMs: 15000 }),
  aiod_log: (args) => ({ method: 'aiod/log', params: { taskId: args.taskId, offset: args.offset || 0 }, timeoutMs: 15000 }),
  aiod_kill: (args) => ({ method: 'aiod/kill', params: { taskId: args.taskId }, timeoutMs: 15000 })
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
