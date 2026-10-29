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

// 宿主 cindy.node.request 硬约束：timeoutMs <= 120000，maxTotalMs <= 900000 且 >= timeoutMs。
const RPC_MAX_TIMEOUT_MS = 120000;
const RPC_MAX_TOTAL_MS = 900000;

function budget(timeoutMs, maxTotalMs) {
  const t = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), RPC_MAX_TIMEOUT_MS);
  const m = Math.min(Math.max(Number(maxTotalMs) || t, t), RPC_MAX_TOTAL_MS);
  return { timeoutMs: t, maxTotalMs: m };
}

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

const TOOL_DISPATCH = {
  cube_selfcheck: () => ({ method: 'cube/selfcheck', params: {}, ...budget(15000, 30000) }),
  cube_health: () => ({ method: 'cube/health', params: {}, ...budget(60000, 120000) }),
  cube_new: (args) => ({
    method: 'cube/new',
    params: {
      purpose: args.purpose,
      agent: args.agent,
      dialogue: args.dialogue,
      need: args.need,
      timeoutSeconds: intOr(args.timeoutSeconds, 1800),
      template: args.template,
      noInternet: args.noInternet,
      volume: args.volume,
      env: args.env
    },
    ...budget(120000, 900000)
  }),
  cube_ls: (args) => ({
    method: 'cube/ls',
    params: { metadata: args.metadata, state: args.state, limit: args.limit, v2: args.v2 === true },
    ...budget(60000, 60000)
  }),
  cube_rm: (args) => ({ method: 'cube/rm', params: { sandboxId: args.sandboxId }, ...budget(90000, 90000) }),
  cube_exec: (args) => ({
    method: 'cube/exec',
    params: {
      sandboxId: args.sandboxId,
      command: args.command,
      cwd: args.cwd,
      timeoutSeconds: intOr(args.timeoutSeconds, 100),
      env: args.env
    },
    ...budget(115000, 900000)
  }),
  cube_code: (args) => ({
    method: 'cube/code',
    params: {
      sandboxId: args.sandboxId,
      code: args.code,
      language: args.language,
      timeoutSeconds: intOr(args.timeoutSeconds, 100)
    },
    ...budget(115000, 900000)
  }),
  cube_write_file: (args) => ({
    method: 'cube/write',
    params: { sandboxId: args.sandboxId, path: args.path, content: args.content },
    ...budget(115000, 120000)
  }),
  cube_read_file: (args) => ({
    method: 'cube/read',
    params: { sandboxId: args.sandboxId, path: args.path, maxBytes: args.maxBytes },
    ...budget(115000, 120000)
  }),
  cube_run: (args) => ({
    method: 'cube/run',
    params: { cmd: args.cmd, args: Array.isArray(args.args) ? args.args : [] },
    ...budget(90000, 900000)
  }),
  cube_submit: (args) => ({
    method: 'cube/submit',
    params: {
      cmd: args.cmd,
      args: Array.isArray(args.args) ? args.args : [],
      purpose: args.purpose,
      agent: args.agent,
      dialogue: args.dialogue,
      need: args.need,
      timeoutSeconds: args.timeoutSeconds,
      template: args.template,
      noInternet: args.noInternet,
      volume: args.volume,
      env: args.env
    },
    cancelWithCall: false,
    ...budget(60000, 120000)
  }),
  cube_log: (args) => ({
    method: 'cube/log',
    params: { taskId: args.taskId, offset: args.offset || 0 },
    ...budget(15000, 30000)
  }),
  cube_kill: (args) => ({ method: 'cube/kill', params: { taskId: args.taskId }, ...budget(15000, 30000) })
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
      params: { ...req.params, cliEnv: env },
      callId,
      // 本插件没有前台授权流程，绑定在途调用只会增加宿主侧前置判定；统一不绑定
      cancelWithCall: false,
      timeoutMs: req.timeoutMs,
      maxTotalMs: req.maxTotalMs
    });

    if (!resp.ok) {
      const code = resp.errorCode ? `[${resp.errorCode}] ` : '';
      const error = new Error(`${code}${resp.message || '执行失败'} (tool=${tool}, method=${req.method}, callId=${callId})`);
      error.errorCode = resp.errorCode;
      throw error;
    }
    cindy.send({ type: 'tool-result', callId, ok: true, result: resp.result });
  } catch (err) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: err.message || String(err) });
  }
});
