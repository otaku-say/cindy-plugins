// plugins/my-env/main.js —— 全局环境变量与凭据中枢（运行在浏览器隔离沙箱）

async function getStore() {
  try {
    const res = await fetch('/kv');
    if (!res.ok) return { variables: {} };
    const data = await res.json();
    if (!data || typeof data !== 'object') return { variables: {} };
    if (!data.variables || typeof data.variables !== 'object') {
      data.variables = {};
    }
    return data;
  } catch (_) {
    return { variables: {} };
  }
}

async function saveStore(store) {
  const res = await fetch('/kv', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(store)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`持久化存储失败: ${errText || res.statusText}`);
  }
}

function maskValue(val) {
  if (!val) return '';
  if (val.length <= 6) return '••••••';
  return `${val.slice(0, 3)}••••${val.slice(-3)}`;
}

cindy.onHostMessage(async (msg) => {
  if (!msg || msg.type !== 'tool-call') return;
  const { tool, args = {}, callId } = msg;

  try {
    const store = await getStore();
    const vars = store.variables;

    if (tool === 'env_list') {
      const q = (args.query || '').trim().toLowerCase();
      const list = Object.entries(vars)
        .filter(([k, v]) => {
          if (!q) return true;
          return k.toLowerCase().includes(q) || (v.memo && v.memo.toLowerCase().includes(q));
        })
        .map(([k, v]) => ({
          key: k,
          maskedValue: maskValue(v.value),
          memo: v.memo || '',
          updatedAt: v.updatedAt || Date.now()
        }))
        .sort((a, b) => a.key.localeCompare(b.key));

      cindy.send({ type: 'tool-result', callId, ok: true, result: { total: list.length, items: list } });
      return;
    }

    if (tool === 'env_get') {
      const key = (args.key || '').trim();
      if (!key) throw new Error('缺少必须参数: key');
      const item = vars[key];
      if (!item) {
        cindy.send({ type: 'tool-result', callId, ok: false, message: `未找到环境变量: ${key}` });
        return;
      }
      cindy.send({
        type: 'tool-result',
        callId,
        ok: true,
        result: {
          key,
          value: item.value,
          memo: item.memo || '',
          updatedAt: item.updatedAt
        }
      });
      return;
    }

    if (tool === 'env_set') {
      const key = (args.key || '').trim();
      const val = args.value !== undefined ? String(args.value) : '';
      const memo = (args.memo || '').trim();

      if (!key) throw new Error('key 不能为空');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error('key 命名不规范（仅允许字母、数字和下划线，且不能以数字开头）');
      }

      vars[key] = {
        value: val,
        memo,
        updatedAt: Date.now()
      };
      await saveStore(store);

      cindy.send({
        type: 'tool-result',
        callId,
        ok: true,
        result: { key, message: `环境变量 ${key} 已保存`, maskedValue: maskValue(val) }
      });
      return;
    }

    if (tool === 'env_delete') {
      const key = (args.key || '').trim();
      if (!key) throw new Error('缺少必须参数: key');
      if (!vars[key]) {
        cindy.send({ type: 'tool-result', callId, ok: false, message: `环境变量不存在: ${key}` });
        return;
      }
      delete vars[key];
      await saveStore(store);
      cindy.send({ type: 'tool-result', callId, ok: true, result: { key, deleted: true } });
      return;
    }

    if (tool === 'env_dump_for_sandbox') {
      const keys = Array.isArray(args.keys) && args.keys.length > 0 ? args.keys : Object.keys(vars);
      const dumped = {};
      let matchedCount = 0;
      for (const k of keys) {
        if (vars[k] && vars[k].value !== undefined) {
          dumped[k] = vars[k].value;
          matchedCount++;
        }
      }
      cindy.send({
        type: 'tool-result',
        callId,
        ok: true,
        result: { count: matchedCount, env: dumped }
      });
      return;
    }

    cindy.send({ type: 'tool-result', callId, ok: false, message: `未知工具: ${tool}` });
  } catch (err) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: err.message || String(err) });
  }
});
