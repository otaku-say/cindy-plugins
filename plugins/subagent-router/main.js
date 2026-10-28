// plugins/subagent-router/main.js —— 子代理模型链（浏览器隔离沙箱侧分发）
// 真正的落盘与 settings.json 改动都在 node/worker.cjs；这里只做工具分发。

const TOOL_DISPATCH = {
  router_status: 'status',
  router_install: 'install',
  router_uninstall: 'uninstall',
  router_config_get: 'config/get',
  router_config_set: 'config/set',
};

cindy.onHostMessage(async (msg) => {
  if (!msg || msg.type !== 'tool-call') return;
  const { tool, args = {}, callId } = msg;
  const method = TOOL_DISPATCH[tool];
  if (!method) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: '未知工具: ' + tool });
    return;
  }

  try {
    const params = tool === 'router_config_set' ? { config: args.config } : {};
    const response = await cindy.node.request({ method, params });
    if (!response || !response.ok) {
      const reason = response && (response.message || response.errorCode);
      cindy.send({
        type: 'tool-result',
        callId,
        ok: false,
        message: reason ? String(reason) : 'Node 工作进程返回失败',
      });
      return;
    }
    cindy.send({ type: 'tool-result', callId, ok: true, result: response.result });
  } catch (err) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: (err && err.message) || String(err) });
  }
});
