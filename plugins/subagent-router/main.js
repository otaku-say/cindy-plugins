// plugins/subagent-router/main.js —— 工具分发 + 设置页的落盘通道
// 设置页没有 cindy 桥，只能写 /kv 并经 BroadcastChannel 广播；这里收广播、
// 把配置交给 node worker 落盘，并用同一通道回执（设置页据此显示成功/失败）。

const TOOL_DISPATCH = {
  router_status: 'status',
  router_install: 'install',
  router_uninstall: 'uninstall',
  router_config_get: 'config/get',
  router_config_set: 'config/set',
};

const CHANNEL = 'subagent-router';

async function callNode(method, params) {
  const res = await cindy.node.request({ method, params: params || {} });
  if (!res || !res.ok) {
    const reason = (res && (res.message || res.errorCode)) || 'Node 工作进程失败';
    throw new Error(String(reason));
  }
  return res.result;
}

// 设置页可能只把配置写进 /kv（主进程当时不在），工具调用前补一次同步。
async function syncConfigFromKv() {
  try {
    const res = await fetch('/kv');
    const text = res.ok ? await res.text() : '';
    if (!text.trim()) return;
    const parsed = JSON.parse(text);
    if (!parsed || !parsed.config || !Array.isArray(parsed.config.groups)) return;
    await callNode('config/set', { config: parsed.config });
  } catch (_) {
    /* 同步失败不阻塞工具调用：config.json 保持上一次的状态 */
  }
}

cindy.onHostMessage(async (msg) => {
  if (!msg || msg.type !== 'tool-call') return;
  const { tool, args = {}, callId } = msg;
  const method = TOOL_DISPATCH[tool];
  if (!method) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: '未知工具: ' + tool });
    return;
  }
  try {
    await syncConfigFromKv();
    const params = tool === 'router_config_set' ? { config: args.config } : {};
    const result = await callNode(method, params);
    cindy.send({ type: 'tool-result', callId, ok: true, result });
  } catch (err) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: (err && err.message) || String(err) });
  }
});

// ---------------------------------------------------------------- 设置页通道
async function handlePanelMessage(msg) {
  const config = msg.config || (msg.type === 'apply' ? (await readKvConfig()) : null);
  if (msg.type === 'apply') {
    if (!config) throw new Error('收到 apply 但没有配置');
    const saved = await callNode('config/set', { config });
    const installed = await callNode('install');
    const status = await callNode('status');
    return { changed: Boolean(installed.changed || saved.changed), status };
  }
  if (msg.type === 'install') {
    if (config) await callNode('config/set', { config });
    const installed = await callNode('install');
    const status = await callNode('status');
    return { changed: Boolean(installed.changed), status };
  }
  if (msg.type === 'uninstall') {
    const removed = await callNode('uninstall');
    const status = await callNode('status');
    return { changed: Boolean(removed.changed), status };
  }
  if (msg.type === 'status') {
    return { status: await callNode('status') };
  }
  throw new Error('未知面板请求: ' + msg.type);
}

async function readKvConfig() {
  try {
    const res = await fetch('/kv');
    const text = res.ok ? await res.text() : '';
    if (!text.trim()) return null;
    const parsed = JSON.parse(text);
    return parsed && parsed.config ? parsed.config : null;
  } catch (_) {
    return null;
  }
}

try {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    try {
      const result = await handlePanelMessage(msg);
      channel.postMessage(Object.assign({ id: msg.id, ok: true }, result));
    } catch (err) {
      channel.postMessage({ id: msg.id, ok: false, message: (err && err.message) || String(err) });
    }
  };
} catch (_) {
  /* 宿主不支持 BroadcastChannel 时，设置页会收到超时提示 */
}
