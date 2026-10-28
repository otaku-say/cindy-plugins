// plugins/my-env/main.js —— 全局环境变量中枢（调度与通道中继）
// 架构：
//   - 随包 Node 进程 (worker.cjs) 负责本地海量持久化与进程/文件级安全注入
//   - 本沙箱负责工具分发、/kv 镜像同步与设置页 BroadcastChannel 广播中继
//   - 敏感项全掩码，对话流中绝不露出明文

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const CHANNEL = 'my-env';

// 宿主 cindy.node.request 的硬约束（越界会被整条调用拒收，错误码 INVALID_REQUEST）：
//   timeoutMs   <= 120000
//   maxTotalMs  <= 900000 且 >= timeoutMs
// 因此对外承诺的 timeout_ms 上限(MAX_EXEC_TIMEOUT_MS)不能直接 +5s 丢给宿主。
const RPC_MAX_TIMEOUT_MS = 120000;
const RPC_MAX_TOTAL_MS = 900000;
const MAX_EXEC_TIMEOUT_MS = 300000;

function rpcBudget(method, params) {
  if (method !== 'env/exec') return { timeoutMs: 30000 };
  const want = Math.min(
    Math.max(Number(params && params.timeout_ms) || 30000, 1000),
    MAX_EXEC_TIMEOUT_MS
  );
  return {
    timeoutMs: Math.min(want + 5000, RPC_MAX_TIMEOUT_MS),
    maxTotalMs: Math.min(want + 10000, RPC_MAX_TOTAL_MS)
  };
}

async function callNode(method, params) {
  const res = await cindy.node.request({
    method,
    params: params || {},
    ...rpcBudget(method, params)
  });
  if (!res || !res.ok) {
    const reason = (res && (res.message || res.errorCode)) || 'Node 工作进程执行失败';
    throw new Error(String(reason));
  }
  return res.result;
}

// 读取当前 /kv 存储，用于与 Node 持久层同步
async function readKv() {
  try {
    const res = await fetch('/kv');
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (_) {
    return null;
  }
}

// 尝试镜像同步到 /kv（仅当体积 <= 60KB 时；超限则由 Node 本地存储完全接管）
async function mirrorToKv(variables) {
  if (!variables || typeof variables !== 'object') return;
  try {
    const body = JSON.stringify({ variables });
    if (body.length > 60 * 1024) return;
    await fetch('/kv', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body
    });
  } catch (_) {
    /* 忽略 /kv 写入错误，以 Node 磁盘持久化为权威数据源 */
  }
}

async function syncFromKv() {
  const kv = await readKv();
  if (kv && kv.variables && typeof kv.variables === 'object') {
    try {
      await callNode('env/sync', { variables: kv.variables });
    } catch (_) {}
  }
}

const TOOL_DISPATCH = {
  env_list: (args) => ({ method: 'env/list', params: { query: args.query } }),
  env_get: (args) => ({ method: 'env/get', params: { key: args.key } }),
  env_set: (args) => ({
    method: 'env/set',
    params: {
      key: args.key,
      value: args.value,
      memo: args.memo,
      sensitive: args.sensitive
    }
  }),
  env_delete: (args) => ({ method: 'env/delete', params: { key: args.key } }),
  env_write_file: (args) => ({
    method: 'env/writeFile',
    params: {
      target_path: args.target_path,
      keys: args.keys,
      format: args.format,
      overwrite: args.overwrite,
      file_mode: args.file_mode
    }
  }),
  env_exec: (args) => ({
    method: 'env/exec',
    params: {
      command: args.command,
      args: Array.isArray(args.args) ? args.args : [],
      keys: args.keys,
      cwd: args.cwd,
      timeout_ms: args.timeout_ms
    }
  })
};

cindy.onHostMessage(async (msg) => {
  if (!msg || msg.type !== 'tool-call') return;
  const { tool, args = {}, callId } = msg;

  const dispatch = TOOL_DISPATCH[tool];
  if (!dispatch) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: '未知工具: ' + tool });
    return;
  }

  try {
    // 调用前确保 /kv 变更已同步入 Node 持久层
    await syncFromKv();

    const req = dispatch(args);
    const result = await callNode(req.method, req.params);

    // 若发生了增删改，自动更新 /kv 镜像
    if (tool === 'env_set' || tool === 'env_delete') {
      try {
        const store = await callNode('env/exportStore');
        if (store && store.variables) await mirrorToKv(store.variables);
      } catch (_) {}
    }

    cindy.send({ type: 'tool-result', callId, ok: true, result });
  } catch (err) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: (err && err.message) || String(err) });
  }
});

// ---------------------------------------------------------------------------
// 设置页面与面板通信通道 (BroadcastChannel)
// ---------------------------------------------------------------------------
try {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = async (event) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    try {
      if (data.type === 'settings-updated') {
        await syncFromKv();
        channel.postMessage({ id: data.id, ok: true });
      } else if (data.type === 'get-all') {
        const store = await callNode('env/exportStore');
        channel.postMessage({ id: data.id, ok: true, variables: store.variables });
      }
    } catch (err) {
      channel.postMessage({ id: data.id, ok: false, message: (err && err.message) || String(err) });
    }
  };
} catch (_) {
  /* 宿主环境不支持 BroadcastChannel 时优雅降级 */
}
