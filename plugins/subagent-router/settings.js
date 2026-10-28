// plugins/subagent-router/settings.js —— 设置页（外部脚本；无内联事件、无内联脚本）
// 数据流：/agent-models 提供「已启用供应商的可见模型」；node worker 负责落盘。
(function () {
  'use strict';

  const state = {
    models: [],
    providers: [],
    config: { enabled: true, defaultGroupId: '', groups: [] },
    status: null,
    busy: false,
  };

  const el = (id) => document.getElementById(id);
  const toast = (text, kind) => {
    const node = el('toast');
    node.textContent = text;
    node.className = 'toast show ' + (kind || 'ok');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { node.className = 'toast'; }, 4000);
  };

  function nodeRequest(method, params) {
    return cindy.node.request({ method, params: params || {} }).then((res) => {
      if (!res || !res.ok) throw new Error((res && (res.message || res.errorCode)) || 'Node 工作进程失败');
      return res.result;
    });
  }

  async function loadModels() {
    try {
      const res = await fetch('/agent-models');
      const body = await res.json();
      const all = Array.isArray(body.models) ? body.models : [];
      state.models = all.filter((m) => m && m.agent === 'pi' && m.visible !== false && typeof m.id === 'string');
    } catch (_) {
      state.models = [];
    }
    const byProvider = new Map();
    for (const m of state.models) {
      const key = m.providerId || 'unknown';
      if (!byProvider.has(key)) byProvider.set(key, { id: key, name: m.providerName || key, models: [] });
      byProvider.get(key).models.push(m);
    }
    state.providers = [...byProvider.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function modelById(id) {
    return state.models.find((m) => m.id === id) || null;
  }

  function newGroupId() {
    let i = state.config.groups.length + 1;
    while (state.config.groups.some((g) => g.id === 'group-' + i)) i += 1;
    return 'group-' + i;
  }

  // ---------------------------------------------------------------- rendering
  function renderStatus() {
    const pill = el('status-pill');
    const detail = el('status-detail');
    const s = state.status;
    if (!s || !s.ok) {
      pill.className = 'pill off';
      pill.textContent = '未就绪';
      detail.textContent = (s && s.message) || '无法读取 Cindy 数据目录';
      return;
    }
    pill.className = 'pill ' + (s.injected && s.extensionPresent ? 'ok' : 'off');
    pill.textContent = s.injected && s.extensionPresent ? '已注入 · v' + s.extensionVersion : '未注入';
    detail.textContent = s.extDir;
  }

  function renderGroups() {
    const host = el('groups');
    host.textContent = '';
    if (!state.config.groups.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有分组，点下面的「新建分组」开始。';
      host.appendChild(empty);
      return;
    }

    state.config.groups.forEach((group, index) => {
      const card = document.createElement('div');
      card.className = 'group';
      card.dataset.groupId = group.id;
      card.dataset.index = String(index);

      const head = document.createElement('div');
      head.className = 'group-head';

      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.textContent = '⋮⋮';
      grip.setAttribute('aria-label', '拖动排序');
      makeDraggable(grip, card, host, () => commitGroupOrder(host));

      const dot = document.createElement('input');
      dot.type = 'radio';
      dot.name = 'default-group';
      dot.checked = state.config.defaultGroupId === group.id;
      dot.setAttribute('aria-label', '设为默认分组');
      dot.addEventListener('change', () => {
        state.config.defaultGroupId = group.id;
        renderGroups();
      });

      const name = document.createElement('input');
      name.type = 'text';
      name.value = group.name || group.id;
      name.setAttribute('aria-label', '分组名称');
      name.addEventListener('input', () => { group.name = name.value; });

      const del = document.createElement('button');
      del.textContent = '删除';
      del.className = 'danger';
      del.addEventListener('click', () => {
        state.config.groups = state.config.groups.filter((g) => g.id !== group.id);
        if (state.config.defaultGroupId === group.id) {
          state.config.defaultGroupId = state.config.groups[0] ? state.config.groups[0].id : '';
        }
        renderGroups();
      });

      head.append(grip, dot, name, del);

      const body = document.createElement('div');
      body.className = 'group-body';

      const desc = document.createElement('input');
      desc.type = 'text';
      desc.value = group.description || '';
      desc.placeholder = '分组描述，例如：默认使用该分组中的模型';
      desc.addEventListener('input', () => { group.description = desc.value; });

      const chips = document.createElement('div');
      chips.className = 'chips';
      if (!group.models.length) {
        const hint = document.createElement('span');
        hint.className = 'muted';
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
      for (const provider of state.providers) {
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
        const [provider, id] = picker.value.split('|');
        const found = modelById(id);
        group.models.push({ id, provider, name: (found && found.name) || id });
        renderGroups();
      });

      body.append(desc, chips, picker);
      card.append(head, body);
      host.appendChild(card);
    });
  }

  function renderProviders() {
    const host = el('providers');
    host.textContent = '';
    if (!state.providers.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '没有可用的可见模型（检查供应商是否启用）。';
      host.appendChild(empty);
      return;
    }
    for (const provider of state.providers) {
      const box = document.createElement('div');
      const head = document.createElement('div');
      head.className = 'provider-head';
      head.textContent = provider.name + ' · ' + provider.models.length + ' 个模型';
      box.appendChild(head);
      const list = document.createElement('div');
      list.className = 'model-list';
      for (const m of provider.models) {
        const row = document.createElement('div');
        row.className = 'model-row';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = m.name || m.id;
        const id = document.createElement('span');
        id.className = 'muted';
        id.textContent = m.id;
        row.append(name, id);
        list.appendChild(row);
      }
      box.appendChild(list);
      host.appendChild(box);
    }
  }

  // ------------------------------------------------------------ drag ordering
  function makeDraggable(handle, item, container, onDrop) {
    handle.addEventListener('pointerdown', (ev) => {
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
    const order = [...host.children]
      .filter((c) => c.dataset && c.dataset.groupId)
      .map((c) => c.dataset.groupId);
    state.config.groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }

  function commitModelOrder(chips, group) {
    const order = [...chips.children]
      .filter((c) => c.dataset && c.dataset.modelIndex !== undefined)
      .map((c) => Number(c.dataset.modelIndex));
    group.models = order.map((i) => group.models[i]).filter(Boolean);
  }

  // -------------------------------------------------------------------- saving
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
    try {
      await fn();
    } catch (err) {
      toast((err && err.message) || String(err), 'err');
    } finally {
      state.busy = false;
      if (button) button.disabled = false;
    }
  }

  async function save() {
    await nodeRequest('config/set', { config: buildConfig() });
    const installed = await nodeRequest('install');
    state.status = await nodeRequest('status');
    renderStatus();
    toast(installed.changed ? '已保存并注入扩展，下一个新任务生效' : '已保存（扩展无需更新）', 'ok');
  }

  // ---------------------------------------------------------------------- boot
  async function boot() {
    el('btn-add-group').addEventListener('click', () => {
      const id = newGroupId();
      state.config.groups.push({ id, name: '新分组', description: '', models: [] });
      if (!state.config.defaultGroupId) state.config.defaultGroupId = id;
      renderGroups();
    });

    el('btn-save').addEventListener('click', (e) => withBusy(e.currentTarget, save));
    el('btn-install').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      const res = await nodeRequest('install');
      state.status = await nodeRequest('status');
      renderStatus();
      toast(res.changed ? '扩展已写入并注册，下一个新任务生效' : '扩展已是最新，无需改动', 'ok');
    }));
    el('btn-uninstall').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      const res = await nodeRequest('uninstall');
      state.status = await nodeRequest('status');
      renderStatus();
      toast(res.changed ? '扩展与配置已移除，无残留' : '没有需要移除的内容', 'ok');
    }));
    el('btn-reload').addEventListener('click', (e) => withBusy(e.currentTarget, load));

    await load();
  }

  async function load() {
    await loadModels();
    try {
      state.status = await nodeRequest('status');
      if (state.status && state.status.ok && state.status.config) state.config = normalizeLocal(state.status.config);
    } catch (err) {
      state.status = { ok: false, message: (err && err.message) || String(err) };
    }
    renderStatus();
    renderGroups();
    renderProviders();
  }

  function normalizeLocal(raw) {
    return {
      enabled: raw.enabled !== false,
      defaultGroupId: raw.defaultGroupId || '',
      groups: Array.isArray(raw.groups)
        ? raw.groups.map((g) => ({
            id: g.id,
            name: g.name || g.id,
            description: g.description || '',
            models: Array.isArray(g.models) ? g.models.map((m) => ({ id: m.id, provider: m.provider, name: m.name || m.id })) : [],
          }))
        : [],
    };
  }

  boot();
})();
