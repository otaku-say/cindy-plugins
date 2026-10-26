// plugins/cube-cli/settings.js —— 设置页外挂交互逻辑（严格遵守 CSP）

const apiKeyInput = document.getElementById('apiKey');
const apiUrlInput = document.getElementById('apiUrl');
const proxyUrlInput = document.getElementById('proxyUrl');
const apiKeyBadge = document.getElementById('apiKeyBadge');
const saveBtn = document.getElementById('saveBtn');
const statusDiv = document.getElementById('status');

function showStatus(text, isError = false) {
  statusDiv.textContent = text;
  statusDiv.className = isError ? 'error' : 'success';
  statusDiv.style.display = 'block';
  setTimeout(() => {
    statusDiv.style.display = 'none';
  }, 4000);
}

async function loadConfig() {
  try {
    // 1. 读取 safeStorage 凭证状态
    const secRes = await fetch('/secrets');
    if (secRes.ok) {
      const secrets = await secRes.json();
      const target = Array.isArray(secrets) && secrets.find(s => s.key === 'cubesandbox_api_key');
      if (target && target.saved) {
        apiKeyBadge.style.display = 'inline-block';
        apiKeyBadge.textContent = target.tail ? `已保存 (尾号 ${target.tail})` : '已安全保存';
        apiKeyInput.placeholder = '••••••••••••••••（若需更换请重新输入）';
      }
    }

    // 2. 读取 /kv 配置对象
    const kvRes = await fetch('/kv');
    if (kvRes.ok) {
      const kv = await kvRes.json();
      if (kv && typeof kv === 'object') {
        if (kv.CUBESANDBOX_API_URL) apiUrlInput.value = kv.CUBESANDBOX_API_URL;
        if (kv.CUBESANDBOX_PROXY_URL) proxyUrlInput.value = kv.CUBESANDBOX_PROXY_URL;
      }
    }
  } catch (e) {
    console.error('[Cube CLI Settings] 加载配置失败', e);
  }
}

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  try {
    // 1. 如果输入了新 API Key，存入 safeStorage
    const keyVal = apiKeyInput.value.trim();
    if (keyVal) {
      const sRes = await fetch('/secrets/cubesandbox_api_key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: keyVal })
      });
      if (!sRes.ok) {
        const errText = await sRes.text();
        throw new Error(`保存 API Key 失败: ${errText || sRes.statusText}`);
      }
      apiKeyInput.value = '';
    }

    // 2. 读出当前已有 kv 对象，做合并更新后整体 PUT /kv
    let currentKv = {};
    try {
      const r = await fetch('/kv');
      if (r.ok) currentKv = (await r.json()) || {};
    } catch (_) {}

    currentKv.CUBESANDBOX_API_URL = apiUrlInput.value.trim();
    currentKv.CUBESANDBOX_PROXY_URL = proxyUrlInput.value.trim();

    // 规则：/kv 必须是全局 PUT /kv 且 body 必须是 JSON Object
    const kvPutRes = await fetch('/kv', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentKv)
    });

    if (!kvPutRes.ok) {
      const errText = await kvPutRes.text();
      throw new Error(`保存配置项失败: ${errText || kvPutRes.statusText}`);
    }

    showStatus('配置已成功保存！');
    await loadConfig();
  } catch (err) {
    showStatus(err.message, true);
  } finally {
    saveBtn.disabled = false;
  }
});

// 初始化加载
loadConfig();
