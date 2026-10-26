// plugins/my-env/settings.js —— 设置页外挂交互逻辑（严格遵守 CSP）

(function () {
  'use strict';

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
  const envTableBody = document.getElementById('envTableBody');
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

    renderTable();
  }

  // 渲染表格
  function renderTable() {
    envTableBody.innerHTML = '';

    if (filteredKeys.length === 0) {
      envTableBody.innerHTML = '<tr><td colspan="4" class="empty-tip">暂无匹配的环境变量</td></tr>';
      pageInfo.textContent = '第 1 / 1 页 (共 0 项)';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }

    const startIndex = (currentPage - 1) * pageSize;
    const pageKeys = filteredKeys.slice(startIndex, startIndex + pageSize);

    pageKeys.forEach((key) => {
      const item = allVariables[key];
      const tr = document.createElement('tr');

      // Key 列
      const tdKey = document.createElement('td');
      tdKey.innerHTML = `<span class="key-badge">${escapeHtml(key)}</span>`;

      // Value 列（脱敏与切换按钮）
      const tdVal = document.createElement('td');
      const valContainer = document.createElement('div');
      valContainer.className = 'val-cell';
      const valSpan = document.createElement('span');
      valSpan.textContent = mask(item.value);
      valSpan.dataset.revealed = 'false';

      const eyeBtn = document.createElement('button');
      eyeBtn.className = 'btn btn-sm';
      eyeBtn.textContent = '👁';
      eyeBtn.title = '查看/隐藏明文';
      eyeBtn.onclick = () => {
        const isRevealed = valSpan.dataset.revealed === 'true';
        if (isRevealed) {
          valSpan.textContent = mask(item.value);
          valSpan.dataset.revealed = 'false';
        } else {
          valSpan.textContent = item.value;
          valSpan.dataset.revealed = 'true';
        }
      };

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-sm';
      copyBtn.textContent = '📋';
      copyBtn.title = '复制变量值';
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(item.value);
          showToast(`已复制 ${key} 的值`);
        } catch (_) {
          showToast('复制失败，请手动复制', true);
        }
      };

      valContainer.appendChild(valSpan);
      valContainer.appendChild(eyeBtn);
      valContainer.appendChild(copyBtn);
      tdVal.appendChild(valContainer);

      // Memo 列
      const tdMemo = document.createElement('td');
      tdMemo.className = 'memo-text';
      tdMemo.textContent = item.memo || '-';

      // 操作列（编辑 / 删除）
      const tdActions = document.createElement('td');
      tdActions.style.textAlign = 'right';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm';
      editBtn.textContent = '编辑';
      editBtn.style.marginRight = '6px';
      editBtn.onclick = () => startEdit(key);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-sm btn-danger';
      delBtn.textContent = '删除';
      delBtn.onclick = () => deleteKey(key);

      tdActions.appendChild(editBtn);
      tdActions.appendChild(delBtn);

      tr.appendChild(tdKey);
      tr.appendChild(tdVal);
      tr.appendChild(tdMemo);
      tr.appendChild(tdActions);

      envTableBody.appendChild(tr);
    });

    const totalPages = Math.ceil(filteredKeys.length / pageSize);
    pageInfo.textContent = `第 ${currentPage} / ${totalPages} 页 (共 ${filteredKeys.length} 项)`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // 编辑模式
  function startEdit(key) {
    editingKey = key;
    const item = allVariables[key];
    envKey.value = key;
    envKey.disabled = true; // 编辑状态下 key 不可改
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
      renderTable();
    }
  });

  nextBtn.addEventListener('click', () => {
    const totalPages = Math.ceil(filteredKeys.length / pageSize);
    if (currentPage < totalPages) {
      currentPage++;
      renderTable();
    }
  });

  refreshBtn.addEventListener('click', () => {
    loadData();
    showToast('已刷新数据');
  });

  // 初始化加载
  loadData();
})();
