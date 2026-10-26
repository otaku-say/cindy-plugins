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

cindy.onHostMessage(async (msg) => {
  if (!msg || msg.type !== 'tool-call') return;

  const { tool, args, callId } = msg;

  try {
    const kv = await getKvConfig();
    const env = {
      SANDBOX_BASE: (args && args.base) || kv.SANDBOX_BASE || ''
    };

    if (tool === 'aiod_version') {
      const resp = await cindy.node.request({
        method: 'aiod/run',
        params: { cmd: 'version', args: [], env },
        callId,
        cancelWithCall: false,
        timeoutMs: 15000
      });
      if (!resp.ok) throw new Error(resp.message || '执行失败');
      cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
      return;
    }

    if (tool === 'aiod_health') {
      const resp = await cindy.node.request({
        method: 'aiod/health',
        params: { env },
        callId,
        cancelWithCall: false,
        timeoutMs: 30000
      });
      if (!resp.ok) throw new Error(resp.message || '健康检查失败');
      cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
      return;
    }

    if (tool === 'aiod_run') {
      const cmd = args.cmd;
      const cmdArgs = Array.isArray(args.args) ? args.args : [];
      const resp = await cindy.node.request({
        method: 'aiod/run',
        params: { cmd, args: cmdArgs, env },
        callId,
        cancelWithCall: false,
        timeoutMs: 60000,
        maxTotalMs: 900000
      });
      if (!resp.ok) throw new Error(resp.message || '执行失败');
      cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
      return;
    }

    if (tool === 'aiod_submit') {
      const cmd = args.cmd;
      const cmdArgs = Array.isArray(args.args) ? args.args : [];
      const resp = await cindy.node.request({
        method: 'aiod/submit',
        params: { cmd, args: cmdArgs, env },
        callId,
        cancelWithCall: false,
        timeoutMs: 15000
      });
      if (!resp.ok) throw new Error(resp.message || '异步提交失败');
      cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
      return;
    }

    if (tool === 'aiod_log') {
      const resp = await cindy.node.request({
        method: 'aiod/log',
        params: { taskId: args.taskId, offset: args.offset || 0 },
        callId,
        cancelWithCall: false,
        timeoutMs: 15000
      });
      if (!resp.ok) throw new Error(resp.message || '读取日志失败');
      cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
      return;
    }

    if (tool === 'aiod_kill') {
      const resp = await cindy.node.request({
        method: 'aiod/kill',
        params: { taskId: args.taskId },
        callId,
        cancelWithCall: false,
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
