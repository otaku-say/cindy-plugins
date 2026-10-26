// plugins/my-env/main.js —— 全局环境变量中枢（浏览器隔离沙箱）
// 值以明文存在插件 /kv（宿主本地），不是 network.secrets 保险库，本代码可读。
// 因此：敏感项全掩码、不提供批量导出、只支持单键读取。

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const KV_LIMIT_BYTES = 60 * 1024;

async function getStore() {
  const res = await fetch('/kv');
  if (!res.ok) throw new Error('读取存储失败: HTTP ' + res.status);
  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error('读取存储失败: 返回内容不是合法 JSON（已中止，避免覆盖原数据）');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  if (!data.variables || typeof data.variables !== 'object' || Array.isArray(data.variables)) {
    data.variables = {};
  }
  return data;
}

async function saveStore(store) {
  const body = JSON.stringify(store);
  if (body.length > KV_LIMIT_BYTES) {
    throw new Error('存储超限: 序列化 ' + body.length + ' 字节，上限 ' + KV_LIMIT_BYTES + ' 字节。请先删除或缩短部分变量。');
  }
  const res = await fetch('/kv', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  if (!res.ok) throw new Error('保存失败: HTTP ' + res.status);
}

function assertKey(key) {
  if (!key) throw new Error('key 不能为空');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error('key 命名不规范（仅字母、数字、下划线，且不能以数字开头）');
  }
  if (RESERVED.has(key)) throw new Error('key 为宿主保留名: ' + key);
}

function isSensitive(entry) {
  return entry.sensitive !== false;
}

function maskOf(entry) {
  if (!entry.value) return '';
  if (isSensitive(entry)) return '••••••';
  return entry.value.length <= 6 ? '••••••' : entry.value.slice(0, 3) + '…';
}

cindy.onHostMessage(async (msg) => {
  if (!msg || msg.type !== 'tool-call') return;
  const { tool, args = {}, callId } = msg;

  try {
    const store = await getStore();
    const vars = store.variables;

    if (tool === 'env_list') {
      const q = String(args.query || '').trim().toLowerCase();
      const items = Object.keys(vars)
        .filter((k) => {
          if (!q) return true;
          return k.toLowerCase().indexOf(q) >= 0 || (vars[k].memo || '').toLowerCase().indexOf(q) >= 0;
        })
        .sort((a, b) => a.localeCompare(b))
        .map((k) => {
          const item = {
            key: k,
            maskedValue: maskOf(vars[k]),
            memo: vars[k].memo || '',
            sensitive: isSensitive(vars[k]),
            updatedAt: vars[k].updatedAt || 0
          };
          return item;
        });
      cindy.send({ type: 'tool-result', callId, ok: true, result: { total: items.length, items } });
      return;
    }

    if (tool === 'env_get') {
      const key = String(args.key || '').trim();
      assertKey(key);
      if (!Object.prototype.hasOwnProperty.call(vars, key)) {
        cindy.send({ type: 'tool-result', callId, ok: false, message: '环境变量不存在: ' + key });
        return;
      }
      const entry = vars[key];
      cindy.send({
        type: 'tool-result',
        callId,
        ok: true,
        result: {
          key,
          value: entry.value,
          memo: entry.memo || '',
          sensitive: isSensitive(entry),
          updatedAt: entry.updatedAt || 0
        }
      });
      return;
    }

    if (tool === 'env_set') {
      const key = String(args.key || '').trim();
      assertKey(key);
      if (args.value === undefined || args.value === null) throw new Error('缺少必须参数: value');
      const value = String(args.value);
      const existing = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : null;
      const sensitive = args.sensitive === undefined
        ? (existing ? isSensitive(existing) : true)
        : args.sensitive !== false;
      vars[key] = { value, memo: String(args.memo || '').trim(), sensitive, updatedAt: Date.now() };
      await saveStore(store);
      cindy.send({
        type: 'tool-result',
        callId,
        ok: true,
        result: { key, message: '已保存 ' + key, maskedValue: maskOf(vars[key]), sensitive }
      });
      return;
    }

    if (tool === 'env_delete') {
      const key = String(args.key || '').trim();
      assertKey(key);
      if (!Object.prototype.hasOwnProperty.call(vars, key)) {
        cindy.send({ type: 'tool-result', callId, ok: false, message: '环境变量不存在: ' + key });
        return;
      }
      delete vars[key];
      await saveStore(store);
      cindy.send({ type: 'tool-result', callId, ok: true, result: { key, deleted: true } });
      return;
    }

    cindy.send({ type: 'tool-result', callId, ok: false, message: '未知工具: ' + tool });
  } catch (err) {
    cindy.send({ type: 'tool-result', callId, ok: false, message: err.message || String(err) });
  }
});
