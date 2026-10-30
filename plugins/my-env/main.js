// plugins/my-env/main.js —— 环境变量中枢（调度与设置页通道中继）
// 架构（v0.3.0）：
//   - 随包 Node 进程 (worker.cjs) 是唯一数据源：持久化、注入、脱敏都在那里
//   - 本沙箱只做工具分发与设置页通道中继，不再镜像 /kv
//   - 敏感项全掩码，对话流中绝不露出明文
//
// 历史教训：v0.2.x 每次工具调用都把 /kv 的条目 upsert 进 Node 存储，并且只在
// value 变化时才更新。结果是"设置页删掉的键会复活、只改 memo 的编辑永不生效"，
// 而 /kv 里还多存了一份明文。v0.3.0 直接删掉这层镜像，设置页改走下面的通道。

const CHANNEL = 'my-env';

// 宿主 cindy.node.request 的硬约束（越界会被整条调用拒收）：
//   timeoutMs <= 120000，maxTotalMs <= 900000 且 >= timeoutMs
const RPC_MAX_TIMEOUT_MS = 118000;
const RPC_MAX_TOTAL_MS = 900000;
const MAX_EXEC_TIMEOUT_MS = 110000;

function rpcBudget(method, params) {
  if (method === 'env/probe') {
    const want = Math.min(Math.max(Number(params && params.timeout_ms) || 15000, 1000), 60000);
    return {
      timeoutMs: Math.min(want * 2 + 5000, RPC_MAX_TIMEOUT_MS),
      maxTotalMs: Math.min(want * 3 + 10000, RPC_MAX_TOTAL_MS)
    };
  }
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

const TOOL_DISPATCH = {
  env_list: (args) => ({
    method: 'env/list',
    params: { query: args.query, keys: args.keys, limit: args.limit, offset: args.offset }
  }),
  env_get: (args) => ({
    method: 'env/get',
    params: { key: args.key, allow_plaintext: args.allow_plaintext }
  }),
  env_set: (args) => ({
    method: 'env/set',
    params: {
      key: args.key,
      value: args.value,
      value_from: args.value_from,
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
      timeout_ms: args.timeout_ms,
      shell: args.shell,
      command_line: args.command_line,
      stdin: args.stdin
    }
  }),
  env_probe: (args) => ({
    method: 'env/probe',
    params: {
      kind: args.kind,
      keys: args.keys,
      repo: args.repo,
      url: args.url,
      header: args.header,
      header_template: args.header_template,
      ok_status: args.ok_status,
      timeout_ms: args.timeout_ms,
      allow_private: args.allow_private,
      allowed_hosts: args.allowed_hosts
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
    const req = dispatch(args);
    const result = await callNode(req.method, req.params);
    cindy.send({ type: 'tool-result', callId, ok: true, result });
  } catch (err) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: (err && err.message) || String(err) });
  }
});

// ---------------------------------------------------------------------------
// 设置页面通道 (BroadcastChannel)
// 设置在宿主 cindy-ghost:// 沙箱里，没有 cindy 对象；所有读写都由这里转给 worker，
// 因此设置页与 Agent 看到的是同一份数据，也不再有 /kv 的第二份明文。
// ---------------------------------------------------------------------------
const CHANNEL_OPS = {
  store: async () => {
    const [store, stats] = await Promise.all([callNode('env/store'), callNode('env/stats')]);
    return { variables: store.variables, stats };
  },
  stats: () => callNode('env/stats'),
  set: (data) => callNode('env/set', {
    key: data.key,
    value: data.value,
    memo: data.memo,
    sensitive: data.sensitive
  }),
  delete: (data) => callNode('env/delete', { key: data.key }),
  import: (data) => callNode('env/import', {
    variables: data.variables,
    overwrite: data.overwrite === true
  })
};

try {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = async (event) => {
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;
    const respond = (payload) => {
      try {
        channel.postMessage({ id: data.id, ...payload });
      } catch (_) {}
    };
    const op = CHANNEL_OPS[data.type];
    if (!op) {
      respond({ ok: false, message: '未知设置页请求: ' + data.type });
      return;
    }
    try {
      respond({ ok: true, ...(await op(data)) });
    } catch (err) {
      respond({ ok: false, message: (err && err.message) || String(err) });
    }
  };
} catch (_) {
  /* 宿主环境不支持 BroadcastChannel 时优雅降级（设置页会提示后台不可达） */
}
