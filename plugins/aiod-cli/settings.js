// plugins/aiod-cli/settings.js —— 设置页外挂交互逻辑（严格遵守 CSP）

const baseInput = document.getElementById('sandboxBase');
const keyInput = document.getElementById('sandboxKey');
const keyBadge = document.getElementById('keyBadge');
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
      const target = Array.isArray(secrets) && secrets.find(s => s.key === 'sandbox_key');
      if (target && target.saved) {
        keyBadge.style.display = 'inline-block';
        keyBadge.textContent = target.tail ? `已保存 (尾号 ${target.tail})` : '已安全保存';
        keyInput.placeholder = '••••••••••••••••（若需更换请重新输入）';
      }
    }

    // 2. 读取 /kv 配置对象
    const kvRes = await fetch('/kv');
    if (kvRes.ok) {
      const kv = await kvRes.json();
      if (kv && typeof kv === 'object' && kv.SANDBOX_BASE) {
        baseInput.value = kv.SANDBOX_BASE;
      }
    }
  } catch (e) {
    console.error('[Aiod CLI Settings] 加载配置失败', e);
  }
}

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  try {
    // 1. 存入安全凭证（如果输入了值）
    const keyVal = keyInput.value.trim();
    if (keyVal) {
      const sRes = await fetch('/secrets/sandbox_key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: keyVal })
      });
      if (!sRes.ok) {
        const errText = await sRes.text();
        throw new Error(`保存鉴权 Key 失败: ${errText || sRes.statusText}`);
      }
      keyInput.value = '';
    }

    // 2. 读取并合并 kv 对象，整体 PUT /kv
    let currentKv = {};
    try {
      const r = await fetch('/kv');
      if (r.ok) currentKv = (await r.json()) || {};
    } catch (_) {}

    currentKv.SANDBOX_BASE = baseInput.value.trim();

    const kvPutRes = await fetch('/kv', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentKv)
    });

    if (!kvPutRes.ok) {
      const errText = await kvPutRes.text();
      throw new Error(`保存网关地址失败: ${errText || kvPutRes.statusText}`);
    }

    showStatus('设置已保存！');
    await loadConfig();
  } catch (err) {
    showStatus(err.message, true);
  } finally {
    saveBtn.disabled = false;
  }
});

// 初始化加载
loadConfig();
