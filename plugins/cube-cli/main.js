// plugins/cube-cli/main.js —— CubeSandbox 控制面插件电子脑（浏览器沙箱）

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
  cube_version: () => ({ method: 'cube/run', params: { cmd: 'version', args: [] }, timeoutMs: 15000 }),
  cube_health: () => ({ method: 'cube/health', params: {}, timeoutMs: 30000 }),
  cube_run: (args) => ({ method: 'cube/run', params: { cmd: args.cmd, args: Array.isArray(args.args) ? args.args : [] }, timeoutMs: 60000, maxTotalMs: 900000 }),
  cube_submit: (args) => ({ method: 'cube/submit', params: { cmd: args.cmd, args: Array.isArray(args.args) ? args.args : [] }, cancelWithCall: false, timeoutMs: 15000 }),
  cube_log: (args) => ({ method: 'cube/log', params: { taskId: args.taskId, offset: args.offset || 0 }, timeoutMs: 15000 }),
  cube_kill: (args) => ({ method: 'cube/kill', params: { taskId: args.taskId }, timeoutMs: 15000 })
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
      CUBESANDBOX_API_URL: kv.CUBESANDBOX_API_URL || 'https://cubesandbox-api.4a8a.com',
      CUBESANDBOX_PROXY_URL: kv.CUBESANDBOX_PROXY_URL || 'https://cubesandbox-proxy.4a8a.com'
    };

    const req = dispatch(args);
    const resp = await cindy.node.request({
      method: req.method,
      params: { ...req.params, env },
      callId,
      cancelWithCall: req.cancelWithCall !== false,
      timeoutMs: req.timeoutMs || 15000,
      ...(req.maxTotalMs ? { maxTotalMs: req.maxTotalMs } : {})
    });

    if (!resp.ok) throw new Error(resp.message || '执行失败');
    cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
  } catch (err) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: err.message || String(err) });
  }
});
