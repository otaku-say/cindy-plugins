// plugins/my-env/settings.js —— 设置页外挂交互逻辑（严格遵守 CSP）

(function () {
  'use strict';

  // SVG 图标模板
  const SVG_EYE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const SVG_EYE_OFF = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';
  const SVG_COPY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const SVG_PENCIL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
  const SVG_TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

  // 状态变量
  let allVariables = {}; // key -> { value, memo, updatedAt }
  let filteredKeys = [];
  let currentPage = 1;
  const pageSize = 5;
  let editingKey = null;

  // DOM 元素
  const envKey = document.getElementById('envKey');
  const envValue = document.getElementById('envValue');
  const envMemo = document.getElementById('envMemo');
  const saveBtn = document.getElementById('saveBtn');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const formTitle = document.getElementById('formTitle');
  const toggleValBtn = document.getElementById('toggleValBtn');
  const searchInput = document.getElementById('searchInput');
  const refreshBtn = document.getElementById('refreshBtn');
  const envListContainer = document.getElementById('envListContainer');
  const pageInfo = document.getElementById('pageInfo');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const toast = document.getElementById('toast');

  let toastTimer = null;
  function showToast(msg, isError = false) {
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.className = `toast ${isError ? 'toast-error' : 'toast-success'}`;
    toast.style.display = 'block';
    toastTimer = setTimeout(() => {
      toast.style.display = 'none';
    }, 3500);
  }

  function mask(val) {
    if (!val) return '';
    if (val.length <= 6) return '••••••';
    return `${val.slice(0, 3)}••••${val.slice(-3)}`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // 读取数据
  async function loadData() {
    try {
      const res = await fetch('/kv');
      if (!res.ok) {
        allVariables = {};
      } else {
        const data = await res.json();
        allVariables = (data && data.variables) || {};
      }
      applyFilter();
    } catch (err) {
      showToast(`读取配置失败: ${err.message}`, true);
    }
  }

  // 保存数据
  async function persistData() {
    const res = await fetch('/kv', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables: allVariables })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`保存失败: ${text || res.statusText}`);
    }
  }

  // 过滤与排序
  function applyFilter() {
    const q = (searchInput.value || '').trim().toLowerCase();
    filteredKeys = Object.keys(allVariables).filter((k) => {
      if (!q) return true;
      const memo = (allVariables[k].memo || '').toLowerCase();
      return k.toLowerCase().includes(q) || memo.includes(q);
    });

    // 默认按字典序排序
    filteredKeys.sort((a, b) => a.localeCompare(b));

    // 计算分页
    const maxPage = Math.max(1, Math.ceil(filteredKeys.length / pageSize));
    if (currentPage > maxPage) currentPage = maxPage;
    if (currentPage < 1) currentPage = 1;

    renderList();
  }

  // 渲染双行列表
  function renderList() {
    envListContainer.innerHTML = '';

    if (filteredKeys.length === 0) {
      envListContainer.innerHTML = '<div class="empty-tip">暂无匹配的环境变量</div>';
      pageInfo.textContent = '第 1 / 1 页 (共 0 项)';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }

    const startIndex = (currentPage - 1) * pageSize;
    const pageKeys = filteredKeys.slice(startIndex, startIndex + pageSize);

    pageKeys.forEach((key) => {
      const item = allVariables[key];
      const itemEl = document.createElement('div');
      itemEl.className = 'env-item';

      // ── 第一行：Key + Value + 操作区 ──
      const rowMain = document.createElement('div');
      rowMain.className = 'env-row-main';

      // 左侧聚合区（Key + Value 胶囊）
      const leftCluster = document.createElement('div');
      leftCluster.className = 'env-left-cluster';

      const keySpan = document.createElement('span');
      keySpan.className = 'key-badge';
      keySpan.textContent = key;
      leftCluster.appendChild(keySpan);

      // Value 胶囊
      const valPill = document.createElement('div');
      valPill.className = 'val-pill';

      const valSpan = document.createElement('span');
      valSpan.className = 'val-text';
      valSpan.textContent = mask(item.value);
      valSpan.dataset.revealed = 'false';

      // 显隐按钮 (Eye)
      const eyeBtn = document.createElement('button');
      eyeBtn.className = 'pill-btn';
      eyeBtn.innerHTML = SVG_EYE;
      eyeBtn.title = '显示/隐藏明文';
      eyeBtn.onclick = () => {
        const isRevealed = valSpan.dataset.revealed === 'true';
        if (isRevealed) {
          valSpan.textContent = mask(item.value);
          valSpan.dataset.revealed = 'false';
          eyeBtn.innerHTML = SVG_EYE;
        } else {
          valSpan.textContent = item.value;
          valSpan.dataset.revealed = 'true';
          eyeBtn.innerHTML = SVG_EYE_OFF;
        }
      };

      // 复制按钮 (Copy)
      const copyBtn = document.createElement('button');
      copyBtn.className = 'pill-btn';
      copyBtn.innerHTML = SVG_COPY;
      copyBtn.title = '复制变量值';
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(item.value);
          showToast(`已复制 ${key} 的值`);
        } catch (_) {
          showToast('复制失败，请手动复制', true);
        }
      };

      valPill.appendChild(valSpan);
      valPill.appendChild(eyeBtn);
      valPill.appendChild(copyBtn);
      leftCluster.appendChild(valPill);
      rowMain.appendChild(leftCluster);

      // 右侧操作区（编辑 + 删除图标按钮）
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'env-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'icon-btn edit-btn';
      editBtn.innerHTML = SVG_PENCIL;
      editBtn.title = '编辑变量';
      editBtn.onclick = () => startEdit(key);

      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn del-btn';
      delBtn.innerHTML = SVG_TRASH;
      delBtn.title = '删除变量';
      delBtn.onclick = () => deleteKey(key);

      actionsDiv.appendChild(editBtn);
      actionsDiv.appendChild(delBtn);
      rowMain.appendChild(actionsDiv);

      itemEl.appendChild(rowMain);

      // ── 第二行：备注说明 ──
      const rowMemo = document.createElement('div');
      rowMemo.className = 'env-row-memo';
      rowMemo.textContent = item.memo || '无备注说明';
      itemEl.appendChild(rowMemo);

      envListContainer.appendChild(itemEl);
    });

    const totalPages = Math.ceil(filteredKeys.length / pageSize);
    pageInfo.textContent = `第 ${currentPage} / ${totalPages} 页 (共 ${filteredKeys.length} 项)`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
  }

  // 编辑模式
  function startEdit(key) {
    editingKey = key;
    const item = allVariables[key];
    envKey.value = key;
    envKey.disabled = true;
    envValue.value = item.value;
    envMemo.value = item.memo || '';
    formTitle.textContent = `编辑变量: ${key}`;
    cancelEditBtn.style.display = 'inline-block';
    envValue.focus();
  }

  function resetForm() {
    editingKey = null;
    envKey.value = '';
    envKey.disabled = false;
    envValue.value = '';
    envMemo.value = '';
    formTitle.textContent = '添加新变量';
    cancelEditBtn.style.display = 'none';
  }

  // 删除
  async function deleteKey(key) {
    if (!confirm(`确定删除环境变量 "${key}" 吗？`)) return;
    try {
      delete allVariables[key];
      await persistData();
      showToast(`已删除环境变量: ${key}`);
      if (editingKey === key) resetForm();
      applyFilter();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // 保存
  saveBtn.addEventListener('click', async () => {
    const key = envKey.value.trim();
    const value = envValue.value;
    const memo = envMemo.value.trim();

    if (!key) {
      showToast('请输入变量键名 (Key)', true);
      envKey.focus();
      return;
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      showToast('键名仅允许字母、数字和下划线，且不能以数字开头', true);
      envKey.focus();
      return;
    }

    if (value === '') {
      showToast('请输入变量键值 (Value)', true);
      envValue.focus();
      return;
    }

    saveBtn.disabled = true;
    try {
      allVariables[key] = {
        value,
        memo,
        updatedAt: Date.now()
      };
      await persistData();
      showToast(`已成功保存变量: ${key}`);
      resetForm();
      applyFilter();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  cancelEditBtn.addEventListener('click', resetForm);

  toggleValBtn.addEventListener('click', () => {
    if (envValue.type === 'password') {
      envValue.type = 'text';
      toggleValBtn.textContent = '隐藏';
    } else {
      envValue.type = 'password';
      toggleValBtn.textContent = '显示';
    }
  });

  searchInput.addEventListener('input', () => {
    currentPage = 1;
    applyFilter();
  });

  prevBtn.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderList();
    }
  });

  nextBtn.addEventListener('click', () => {
    const totalPages = Math.ceil(filteredKeys.length / pageSize);
    if (currentPage < totalPages) {
      currentPage++;
      renderList();
    }
  });

  refreshBtn.addEventListener('click', () => {
    loadData();
    showToast('已刷新数据');
  });

  // 初始化加载
  loadData();
})();
