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

cindy.onHostMessage(async (msg) => {
  if (!msg || msg.type !== 'tool-call') return;

  const { tool, args, callId } = msg;

  try {
    const kv = await getKvConfig();
    const env = {
      CUBESANDBOX_API_URL: kv.CUBESANDBOX_API_URL || 'https://cubesandbox-api.4a8a.com',
      CUBESANDBOX_PROXY_URL: kv.CUBESANDBOX_PROXY_URL || 'https://cubesandbox-proxy.4a8a.com'
    };

    if (tool === 'cube_version') {
      const resp = await cindy.node.request({
        method: 'cube/run',
        params: { cmd: 'version', args: [], env },
        callId,
        cancelWithCall: true,
        timeoutMs: 15000
      });
      if (!resp.ok) throw new Error(resp.message || '执行失败');
      cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
      return;
    }

    if (tool === 'cube_health') {
      const resp = await cindy.node.request({
        method: 'cube/health',
        params: { env },
        callId,
        cancelWithCall: true,
        timeoutMs: 30000
      });
      if (!resp.ok) throw new Error(resp.message || '健康检查失败');
      cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
      return;
    }

    if (tool === 'cube_run') {
      const cmd = args.cmd;
      const cmdArgs = Array.isArray(args.args) ? args.args : [];
      const resp = await cindy.node.request({
        method: 'cube/run',
        params: { cmd, args: cmdArgs, env },
        callId,
        cancelWithCall: true,
        timeoutMs: 60000,
        maxTotalMs: 900000
      });
      if (!resp.ok) throw new Error(resp.message || '执行失败');
      cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
      return;
    }

    if (tool === 'cube_submit') {
      const cmd = args.cmd;
      const cmdArgs = Array.isArray(args.args) ? args.args : [];
      const resp = await cindy.node.request({
        method: 'cube/submit',
        params: { cmd, args: cmdArgs, env },
        callId,
        cancelWithCall: false, // 异步任务在后台独立运行
        timeoutMs: 15000
      });
      if (!resp.ok) throw new Error(resp.message || '异步提交失败');
      cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
      return;
    }

    if (tool === 'cube_log') {
      const resp = await cindy.node.request({
        method: 'cube/log',
        params: { taskId: args.taskId, offset: args.offset || 0 },
        callId,
        cancelWithCall: true,
        timeoutMs: 15000
      });
      if (!resp.ok) throw new Error(resp.message || '读取日志失败');
      cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
      return;
    }

    if (tool === 'cube_kill') {
      const resp = await cindy.node.request({
        method: 'cube/kill',
        params: { taskId: args.taskId },
        callId,
        cancelWithCall: true,
        timeoutMs: 15000
      });
      if (!resp.ok) throw new Error(resp.message || '终止任务失败');
      cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
      return;
    }

    cindy.send({ type: 'tool-result', callId, ok: false, message: `未知工具: ${tool}` });
  } catch (err) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: err.message || String(err) });
  }
});
