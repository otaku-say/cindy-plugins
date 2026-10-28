// plugins/subagent-router/settings.js
// 设置页只有同源 fetch 与 BroadcastChannel（没有 cindy 桥）：配置存 /kv，
// 由常驻的 main.js 收到广播后交给 node worker 落盘。
(function () {
  'use strict';

  const CHANNEL = 'subagent-router';
  const KV_LIMIT = 60 * 1024;
  const state = { models: [], config: { enabled: true, defaultGroupId: '', groups: [] }, busy: false };
  const el = (id) => document.getElementById(id);

  function showError(text) {
    const box = el('error');
    box.textContent = '⚠ ' + text;
    box.className = 'show';
    el('notice').className = '';
  }
  function showNotice(text) {
    const box = el('notice');
    box.textContent = text;
    box.className = 'show';
    el('error').className = '';
  }
  function clearBanners() {
    el('error').className = '';
    el('notice').className = '';
  }

  window.addEventListener('error', (e) => showError(e.message || String(e.error)));
  window.addEventListener('unhandledrejection', (e) => showError((e.reason && e.reason.message) || String(e.reason)));

  // ------------------------------------------------------------------ storage
  async function readKv() {
    const res = await fetch('/kv');
    if (!res.ok) throw new Error('读取 /kv 失败: HTTP ' + res.status);
    const text = await res.text();
    if (!text.trim()) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      throw new Error('/kv 内容不是 JSON，已中止以免覆盖：' + err.message);
    }
  }

  async function writeKv(patch) {
    const current = await readKv();
    const next = Object.assign({}, current, patch);
    const body = JSON.stringify(next);
    if (body.length > KV_LIMIT) throw new Error('配置超出 /kv 上限（' + body.length + ' > ' + KV_LIMIT + ' 字节），请减少分组或模型。');
    const res = await fetch('/kv', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) throw new Error('写入 /kv 失败: HTTP ' + res.status);
  }

  // --------------------------------------------------------- main.js handshake
  function ask(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      let ch;
      try {
        ch = new BroadcastChannel(CHANNEL);
      } catch (err) {
        reject(new Error('当前客户端不支持 BroadcastChannel'));
        return;
      }
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        ch.close();
        reject(new Error('插件主进程没有响应（' + payload.type + '）。请重新打开插件，或在任务里让 Agent 调用 router_install。'));
      }, timeoutMs || 15000);
      ch.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg || msg.id !== id) return;
        clearTimeout(timer);
        ch.close();
        resolve(msg);
      };
      ch.postMessage(Object.assign({ id }, payload));
    });
  }

  async function applyConfig(config) {
    await writeKv({ config });
    const reply = await ask({ type: 'apply', config });
    if (!reply.ok) throw new Error(reply.message || '应用配置失败');
    state.status = reply.status || state.status;
    renderStatus();
    showNotice(reply.changed ? '已保存并生效（下一个新任务起用新模型链）' : '已保存（无需改动扩展文件）');
  }

  // ------------------------------------------------------------------ models
  async function loadModels() {
    try {
      const res = await fetch('/agent-models');
      const body = await res.json();
      const all = Array.isArray(body.models) ? body.models : [];
      state.models = all.filter((m) => m && m.agent === 'pi' && m.visible !== false && typeof m.id === 'string');
    } catch (err) {
      state.models = [];
      showError('读取 /agent-models 失败：' + ((err && err.message) || err));
    }
    return state.models;
  }

  function namesByProvider() {
    const map = new Map();
    for (const m of state.models) {
      const key = m.providerId || 'unknown';
      if (!map.has(key)) map.set(key, { id: key, name: m.providerName || key, models: [] });
      map.get(key).models.push(m);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // --------------------------------------------------------------- rendering
  function renderStatus() {
    const pill = el('status-pill');
    const detail = el('status-detail');
    const s = state.status;
    if (!s || !s.ok) {
      pill.className = 'pill off';
      pill.textContent = '未就绪';
      detail.textContent = (s && s.message) || '读取状态失败';
      return;
    }
    const live = s.injected && s.extensionPresent;
    pill.className = 'pill ' + (live ? 'ok' : 'off');
    pill.textContent = live ? '已注入 · v' + s.extensionVersion : '未注入';
    detail.textContent = s.extDir || '';
  }

  const ICON = {
    grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m5 12 5 5L20 7"/></svg>',
    del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>',
  };

  function iconButton(svg, title, onClick, cls) {
    const b = document.createElement('button');
    b.innerHTML = svg;
    b.title = title;
    b.setAttribute('aria-label', title);
    if (cls) b.className = cls;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderGroups() {
    const host = el('groups');
    host.textContent = '';
    if (!state.config.groups.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '还没有分组。点右上角的「+」新建一个。';
      host.appendChild(empty);
      return;
    }

    state.config.groups.forEach((group) => {
      const card = document.createElement('div');
      card.className = 'group';
      card.dataset.groupId = group.id;

      const head = document.createElement('div');
      head.className = 'group-head';

      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.innerHTML = ICON.grip;
      grip.setAttribute('aria-label', '拖动排序');
      makeDraggable(grip, card, host, () => commitGroupOrder(host));

      const dot = document.createElement('input');
      dot.type = 'radio';
      dot.name = 'default-group';
      dot.checked = state.config.defaultGroupId === group.id;
      dot.title = '设为默认分组';
      dot.setAttribute('aria-label', '设为默认分组');
      dot.addEventListener('change', () => {
        state.config.defaultGroupId = group.id;
        renderGroups();
      });

      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'group-name';
      name.value = group.name || group.id;
      name.setAttribute('aria-label', '分组名称');
      name.addEventListener('input', () => { group.name = name.value; });

      const saveBtn = iconButton(ICON.save, '保存并应用', (e) => withBusy(e.currentTarget, () => applyConfig(buildConfig())), 'primary');
      const delBtn = iconButton(ICON.del, '删除分组', () => {
        state.config.groups = state.config.groups.filter((g) => g.id !== group.id);
        if (state.config.defaultGroupId === group.id) state.config.defaultGroupId = state.config.groups[0] ? state.config.groups[0].id : '';
        renderGroups();
      }, 'danger');

      head.append(grip, dot, name, saveBtn, delBtn);

      const body = document.createElement('div');
      body.className = 'group-body';

      const desc = document.createElement('input');
      desc.type = 'text';
      desc.value = group.description || '';
      desc.placeholder = '分组描述，例如：默认使用该分组中的模型';
      desc.setAttribute('aria-label', '分组描述');
      desc.addEventListener('input', () => { group.description = desc.value; });

      const chips = document.createElement('div');
      chips.className = 'chips';
      if (!group.models.length) {
        const hint = document.createElement('span');
        hint.className = 'empty';
        hint.textContent = '还没有模型，用下面的下拉框添加。';
        chips.appendChild(hint);
      }
      group.models.forEach((model, mi) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.dataset.modelIndex = String(mi);
        const label = document.createElement('span');
        label.textContent = model.name || model.id;
        const x = document.createElement('span');
        x.className = 'x';
        x.textContent = '✕';
        x.title = '移除';
        x.addEventListener('click', () => {
          group.models.splice(mi, 1);
          renderGroups();
        });
        chip.append(label, x);
        makeDraggable(chip, chip, chips, () => commitModelOrder(chips, group));
        chips.appendChild(chip);
      });

      const picker = document.createElement('select');
      picker.setAttribute('aria-label', '添加模型');
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '＋ 添加模型…';
      picker.appendChild(placeholder);
      for (const provider of namesByProvider()) {
        const og = document.createElement('optgroup');
        og.label = provider.name;
        for (const m of provider.models) {
          if (group.models.some((x) => x.id === m.id)) continue;
          const opt = document.createElement('option');
          opt.value = m.providerId + '|' + m.id;
          opt.textContent = m.name || m.id;
          og.appendChild(opt);
        }
        if (og.children.length) picker.appendChild(og);
      }
      picker.addEventListener('change', () => {
        if (!picker.value) return;
        const sep = picker.value.indexOf('|');
        const provider = picker.value.slice(0, sep);
        const id = picker.value.slice(sep + 1);
        const found = state.models.find((m) => m.id === id);
        group.models.push({ id, provider, name: (found && found.name) || id });
        renderGroups();
      });

      body.append(desc, chips, picker);
      card.append(head, body);
      host.appendChild(card);
    });
  }

  // ------------------------------------------------------------ drag ordering
  function makeDraggable(handle, item, container, onDrop) {
    handle.addEventListener('pointerdown', (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest('.x')) return; // 删除按钮不走拖拽
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      item.classList.add('dragging');
      const move = (e) => {
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const over = target && target.closest('[data-group-id], .chip');
        if (!over || over === item || !container.contains(over)) return;
        const siblings = [...container.children].filter((c) => c.dataset.groupId || c.classList.contains('chip'));
        const a = siblings.indexOf(item);
        const b = siblings.indexOf(over);
        if (a < 0 || b < 0 || a === b) return;
        if (a < b) over.after(item);
        else over.before(item);
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        item.classList.remove('dragging');
        onDrop();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
  }

  function commitGroupOrder(host) {
    const order = [...host.children].filter((c) => c.dataset && c.dataset.groupId).map((c) => c.dataset.groupId);
    state.config.groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }

  function commitModelOrder(chips, group) {
    const order = [...chips.children]
      .filter((c) => c.dataset && c.dataset.modelIndex !== undefined)
      .map((c) => Number(c.dataset.modelIndex));
    group.models = order.map((i) => group.models[i]).filter(Boolean);
  }

  // ------------------------------------------------------------------- actions
  function buildConfig() {
    return {
      enabled: true,
      defaultGroupId: state.config.defaultGroupId || (state.config.groups[0] ? state.config.groups[0].id : ''),
      groups: state.config.groups.map((g) => ({
        id: g.id,
        name: g.name || g.id,
        description: g.description || '',
        models: g.models.map((m) => ({ id: m.id, provider: m.provider, name: m.name || m.id })),
      })),
    };
  }

  async function withBusy(button, fn) {
    if (state.busy) return;
    state.busy = true;
    if (button) button.disabled = true;
    clearBanners();
    try {
      await fn();
    } catch (err) {
      showError((err && err.message) || String(err));
    } finally {
      state.busy = false;
      if (button) button.disabled = false;
    }
  }

  function newGroupId() {
    let i = state.config.groups.length + 1;
    while (state.config.groups.some((g) => g.id === 'group-' + i)) i += 1;
    return 'group-' + i;
  }

  // ---------------------------------------------------------------------- boot
  async function boot() {
    el('btn-add-group').addEventListener('click', () => {
      const id = newGroupId();
      state.config.groups.push({ id, name: '新分组', description: '', models: [] });
      if (!state.config.defaultGroupId) state.config.defaultGroupId = id;
      renderGroups();
    });

    el('btn-install').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      const reply = await ask({ type: 'install' });
      if (!reply.ok) throw new Error(reply.message || '安装失败');
      state.status = reply.status || state.status;
      renderStatus();
      showNotice(reply.changed ? '扩展已写入并注册，下一个新任务生效' : '扩展已是最新，无需改动');
    }));

    el('btn-uninstall').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      const reply = await ask({ type: 'uninstall' });
      if (!reply.ok) throw new Error(reply.message || '卸载失败');
      state.status = reply.status || state.status;
      renderStatus();
      showNotice(reply.changed ? '扩展与配置已移除，无残留' : '没有需要移除的内容');
    }));

    el('btn-reload').addEventListener('click', (e) => withBusy(e.currentTarget, load));

    await load();
  }

  async function load() {
    const kv = await readKv();
    const fromKv = kv.config && Array.isArray(kv.config.groups) ? normalize(kv.config) : null;
    await loadModels();
    const reply = await ask({ type: 'status' });
    state.status = reply.ok ? reply.status : { ok: false, message: reply.message };
    // 首次打开（kv 还没有配置）以磁盘上的 config.json 为准，避免把已有分组显示成空
    const seeded = fromKv || (reply.status && reply.status.config ? normalize(reply.status.config) : null);
    if (seeded) {
      state.config = seeded;
      if (!fromKv) await writeKv({ config: seeded }).catch(() => {});
    }
    renderStatus();
    renderGroups();
  }

  function normalize(raw) {
    return {
      enabled: raw.enabled !== false,
      defaultGroupId: raw.defaultGroupId || '',
      groups: (Array.isArray(raw.groups) ? raw.groups : []).map((g) => ({
        id: String(g.id || ''),
        name: g.name || g.id,
        description: g.description || '',
        models: (Array.isArray(g.models) ? g.models : []).map((m) => ({ id: m.id, provider: m.provider, name: m.name || m.id })),
      })),
    };
  }

  boot();
})();
