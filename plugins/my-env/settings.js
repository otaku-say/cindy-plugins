// plugins/my-env/settings.js —— 设置页交互逻辑（严格遵守 CSP）
// 写入一律「先重读、只改自己的那一项、再整体 PUT」，避免与 Agent 并发写时丢数据。

(function () {
  'use strict';

  var SVG_EYE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var SVG_EYE_OFF = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';
  var SVG_COPY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  var SVG_PENCIL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
  var SVG_TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

  var allVariables = {};
  var filteredKeys = [];
  var currentPage = 1;
  var PAGE_SIZE = 5;
  var editingKey = null;

  var $ = function (id) { return document.getElementById(id); };
  var envKey = $('envKey'), envValue = $('envValue'), envMemo = $('envMemo'), envSensitive = $('envSensitive');
  var saveBtn = $('saveBtn'), cancelEditBtn = $('cancelEditBtn'), formTitle = $('formTitle'), toggleValBtn = $('toggleValBtn');
  var searchInput = $('searchInput'), refreshBtn = $('refreshBtn'), listEl = $('envListContainer');
  var pageInfo = $('pageInfo'), prevBtn = $('prevBtn'), nextBtn = $('nextBtn'), toast = $('toast');

  var toastTimer = null;
  function showToast(msg, isError) {
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.className = 'toast ' + (isError ? 'toast-error' : 'toast-success');
    toast.style.display = 'block';
    toastTimer = setTimeout(function () { toast.style.display = 'none'; }, 4000);
  }

  function isSensitive(entry) { return entry.sensitive !== false; }

  // 插件设置页运行在宿主的 cindy-ghost:// 沙箱 iframe 里：document 经常没有焦点、
  // 父框架也未授予 clipboard-write 权限策略，navigator.clipboard.writeText 会直接
  // 抛 NotAllowedError/SecurityError。因此必须保留 execCommand 兜底，否则按钮必然失败。
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);

    var sel = window.getSelection ? window.getSelection() : null;
    var prevRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    var ok = false;
    try {
      ta.focus({ preventScroll: true });
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    if (prevRange && sel) {
      try { sel.removeAllRanges(); sel.addRange(prevRange); } catch (e) { /* 忽略 */ }
    }
    if (!ok) throw new Error('clipboard unavailable');
    return text;
  }

  function copyToClipboard(text) {
    var value = text == null ? '' : String(text);
    var clip = navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      return clip.writeText(value).catch(function () { return legacyCopy(value); });
    }
    return new Promise(function (resolve, reject) {
      try { resolve(legacyCopy(value)); } catch (err) { reject(err); }
    });
  }

  function selectTextOf(el) {
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* 忽略 */ }
  }


  function maskOf(entry) {
    if (!entry.value) return '';
    if (isSensitive(entry)) return '••••••';
    return entry.value.length <= 6 ? '••••••' : entry.value.slice(0, 3) + '…';
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function readKv() {
    var res = await fetch('/kv');
    if (!res.ok) throw new Error('读取失败: HTTP ' + res.status);
    var data = await res.json();
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  async function loadData() {
    try {
      var kv = await readKv();
      allVariables = kv.variables && typeof kv.variables === 'object' && !Array.isArray(kv.variables) ? kv.variables : {};
      applyFilter();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // 重读-只改一项-写回，避免覆盖 Agent 在期间写入的其它键
  async function mutate(mutator) {
    var kv = await readKv();
    var vars = kv.variables && typeof kv.variables === 'object' && !Array.isArray(kv.variables) ? kv.variables : {};
    mutator(vars);
    kv.variables = vars;
    var body = JSON.stringify(kv);
    if (body.length > 60 * 1024) throw new Error('存储超限: ' + body.length + ' 字节，上限 61440 字节。请先删除或缩短部分变量。');
    var res = await fetch('/kv', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body });
    if (!res.ok) throw new Error('保存失败: HTTP ' + res.status);
    await loadData();
  }

  function applyFilter() {
    var q = (searchInput.value || '').trim().toLowerCase();
    filteredKeys = Object.keys(allVariables).filter(function (k) {
      if (!q) return true;
      return k.toLowerCase().indexOf(q) >= 0 || (allVariables[k].memo || '').toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) { return a.localeCompare(b); });

    var maxPage = Math.max(1, Math.ceil(filteredKeys.length / PAGE_SIZE));
    if (currentPage > maxPage) currentPage = maxPage;
    if (currentPage < 1) currentPage = 1;
    render();
  }

  function render() {
    listEl.innerHTML = '';
    if (filteredKeys.length === 0) {
      listEl.innerHTML = '<div class="empty-tip">暂无匹配的环境变量</div>';
      pageInfo.textContent = '第 1 / 1 页 (共 0 项)';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }

    var start = (currentPage - 1) * PAGE_SIZE;
    filteredKeys.slice(start, start + PAGE_SIZE).forEach(function (key) {
      var item = allVariables[key];
      var el = document.createElement('div');
      el.className = 'env-item';

      var rowMain = document.createElement('div');
      rowMain.className = 'env-row-main';
      var left = document.createElement('div');
      left.className = 'env-left-cluster';

      var keySpan = document.createElement('span');
      keySpan.className = 'key-badge';
      keySpan.textContent = key;
      left.appendChild(keySpan);

      if (isSensitive(item)) {
        var badge = document.createElement('span');
        badge.className = 'sens-badge';
        badge.textContent = '敏感';
        left.appendChild(badge);
      }

      var pill = document.createElement('div');
      pill.className = 'val-pill';
      var valSpan = document.createElement('span');
      valSpan.className = 'val-text';
      valSpan.textContent = maskOf(item);
      valSpan.dataset.revealed = 'false';

      var eyeBtn = document.createElement('button');
      eyeBtn.className = 'pill-btn';
      eyeBtn.innerHTML = SVG_EYE;
      eyeBtn.title = '显示/隐藏明文';
      eyeBtn.onclick = function () {
        var revealed = valSpan.dataset.revealed === 'true';
        valSpan.textContent = revealed ? maskOf(item) : item.value;
        valSpan.dataset.revealed = revealed ? 'false' : 'true';
        eyeBtn.innerHTML = revealed ? SVG_EYE : SVG_EYE_OFF;
      };

      var copyBtn = document.createElement('button');
      copyBtn.className = 'pill-btn';
      copyBtn.innerHTML = SVG_COPY;
      copyBtn.title = '复制';
      copyBtn.onclick = function () {
        copyToClipboard(item.value).then(function () {
          showToast('已复制 ' + key, false);
        }, function () {
          // 最后兜底：明文露出并自动选中，用户直接 Ctrl+C 即可
          valSpan.textContent = item.value || '';
          valSpan.dataset.revealed = 'true';
          eyeBtn.innerHTML = SVG_EYE_OFF;
          selectTextOf(valSpan);
          showToast('已选中内容，请按 Ctrl+C 复制', true);
        });
      };

      pill.appendChild(valSpan);
      pill.appendChild(eyeBtn);
      pill.appendChild(copyBtn);
      left.appendChild(pill);
      rowMain.appendChild(left);

      var actions = document.createElement('div');
      actions.className = 'env-actions';
      var editBtn = document.createElement('button');
      editBtn.className = 'icon-btn edit-btn';
      editBtn.innerHTML = SVG_PENCIL;
      editBtn.title = '编辑';
      editBtn.onclick = function () { startEdit(key); };
      var delBtn = document.createElement('button');
      delBtn.className = 'icon-btn del-btn';
      delBtn.innerHTML = SVG_TRASH;
      delBtn.title = '删除';
      delBtn.onclick = function () { removeKey(key); };
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      rowMain.appendChild(actions);

      var memoRow = document.createElement('div');
      memoRow.className = 'env-row-memo';
      memoRow.textContent = item.memo || '无备注';

      el.appendChild(rowMain);
      el.appendChild(memoRow);
      listEl.appendChild(el);
    });

    var totalPages = Math.ceil(filteredKeys.length / PAGE_SIZE);
    pageInfo.textContent = '第 ' + currentPage + ' / ' + totalPages + ' 页 (共 ' + filteredKeys.length + ' 项)';
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
  }

  function startEdit(key) {
    var item = allVariables[key];
    editingKey = key;
    envKey.value = key;
    envKey.disabled = true;
    envValue.value = item.value;
    envMemo.value = item.memo || '';
    envSensitive.checked = isSensitive(item);
    formTitle.textContent = '编辑: ' + key;
    cancelEditBtn.style.display = 'inline-block';
    envValue.focus();
  }

  function resetForm() {
    editingKey = null;
    envKey.value = '';
    envKey.disabled = false;
    envValue.value = '';
    envMemo.value = '';
    envSensitive.checked = true;
    formTitle.textContent = '添加新变量';
    cancelEditBtn.style.display = 'none';
  }

  function removeKey(key) {
    if (!confirm('确定删除 ' + key + ' 吗？')) return;
    mutate(function (vars) { delete vars[key]; }).then(function () {
      showToast('已删除 ' + key, false);
      if (editingKey === key) resetForm();
    }, function (err) { showToast(err.message, true); });
  }

  saveBtn.addEventListener('click', function () {
    var key = envKey.value.trim();
    var value = envValue.value;
    var memo = envMemo.value.trim();
    var sensitive = envSensitive.checked;

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      showToast('键名仅允许字母、数字、下划线，且不能以数字开头', true);
      envKey.focus();
      return;
    }
    if (['__proto__', 'constructor', 'prototype'].indexOf(key) >= 0) {
      showToast('键名是宿主保留名: ' + key, true);
      return;
    }
    if (value === '') {
      showToast('请输入变量值', true);
      envValue.focus();
      return;
    }

    saveBtn.disabled = true;
    mutate(function (vars) {
      vars[key] = { value: value, memo: memo, sensitive: sensitive, updatedAt: Date.now() };
    }).then(function () {
      showToast('已保存 ' + key, false);
      resetForm();
    }, function (err) {
      showToast(err.message, true);
    }).then(function () {
      saveBtn.disabled = false;
    });
  });

  cancelEditBtn.addEventListener('click', resetForm);

  toggleValBtn.addEventListener('click', function () {
    var hidden = envValue.type === 'password';
    envValue.type = hidden ? 'text' : 'password';
    toggleValBtn.textContent = hidden ? '隐藏' : '显示';
  });

  searchInput.addEventListener('input', function () { currentPage = 1; applyFilter(); });
  prevBtn.addEventListener('click', function () { if (currentPage > 1) { currentPage--; render(); } });
  nextBtn.addEventListener('click', function () {
    if (currentPage < Math.ceil(filteredKeys.length / PAGE_SIZE)) { currentPage++; render(); }
  });
  refreshBtn.addEventListener('click', function () {
    loadData().then(function () { showToast('已刷新', false); });
  });

  loadData();
})();
