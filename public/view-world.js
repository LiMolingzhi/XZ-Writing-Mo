'use strict';
/* 世界观 */

let worldSaveTimer = null;
let worldContent = '';

function worldChildren(parentId) {
  return state.world
    .filter(n => (n.parentId || null) === (parentId || null))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function flattenWorld(parentId, depth, out) {
  for (const n of worldChildren(parentId)) {
    out.push({ node: n, depth });
    if (!state.collapsed.has('w:' + n.id)) flattenWorld(n.id, depth + 1, out);
  }
  return out;
}

function renderWorldList() {
  const body = $('#listBody');
  $('#paneTitle').textContent = '世界';
  const rows = flattenWorld(null, 0, []);
  const kw = state.filter.trim().toLowerCase();

  const html = rows
    .map(({ node, depth }) => {
      if (kw && !(node.title + ' ' + (node.content || '')).toLowerCase().includes(kw)) return '';
      const hasKids = worldChildren(node.id).length > 0;
      const folded = state.collapsed.has('w:' + node.id);
      const active = node.id === state.worldId ? ' active' : '';
      const caret = hasKids
        ? `<span class="caret ${folded ? 'folded' : ''}" data-wcaret="${node.id}">${folded ? '▸' : '▾'}</span>`
        : '<span class="caret ghost"></span>';
      return `<div class="row leaf${active}" data-wid="${node.id}" style="--depth:${depth}">
        ${caret}
        <span class="rowTitle">${esc(node.title || '未命名')}</span>
        <span class="rowMeta">${(node.content || '').length ? fmtNum(countChars(node.content)) : ''}</span>
        <button class="rowMore" data-wmore="${node.id}" title="更多">⋯</button>
      </div>`;
    })
    .join('');

  body.innerHTML = html || '<div class="listEmpty">还没有词条。点右上角 + 新建。</div>';
}

function openWorldNode(id) {
  const node = state.world.find(n => n.id === id);
  if (!node) return;
  state.worldId = id;
  $('#worldTitle').value = node.title || '';
  worldContent = node.content || '';
  $('#worldEditor').value = worldContent;
  renderWorldList();
  $('#viewEditor').hidden = true;
  $('#viewCards').hidden = true;
  $('#viewPlot').hidden = true;
  $('#viewStats').hidden = true;
  $('#viewWorld').hidden = false;
  $('#viewEmpty').hidden = true;
  $('#worldEditor').focus();
}

async function createWorldNode(parentId) {
  const name = await promptDialog('新建词条', '名字', '');
  if (name === null) return;
  try {
    const r = await api('/api/world', { method: 'POST', body: { title: name.trim() || '新条目', parentId: parentId || null } });
    state.world = (await api('/api/world')).items || [];
    renderWorldList();
    openWorldNode(r.node.id);
  } catch (e) {
    toast('建不上：' + e.message, 'error');
  }
}

async function bindWorldView() {
  const body = $('#listBody');

  body.addEventListener('click', e => {
    const caret = e.target.closest('[data-wcaret]');
    if (caret) {
      const key = 'w:' + caret.dataset.wcaret;
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      listFlip(renderWorldList);
      return;
    }
    const more = e.target.closest('[data-wmore]');
    if (more) {
      e.stopPropagation();
      openWorldMenu(more.dataset.wmore, more);
      return;
    }
    const row = e.target.closest('[data-wid]');
    if (!row) return;
    openWorldNode(row.dataset.wid);
    if (innerWidth <= 900) document.body.classList.remove('listOpen');
  });

  const ed = $('#worldEditor');
  ed.addEventListener('input', () => {
    clearTimeout(worldSaveTimer);
    worldSaveTimer = setTimeout(async () => {
      if (!state.worldId) return;
      try {
        await api('/api/world/' + state.worldId, { method: 'PATCH', body: { content: ed.value } });
        const n = state.world.find(x => x.id === state.worldId);
        if (n) n.content = ed.value;
        renderWorldList();
      } catch (e) {
        toast('没存上：' + e.message, 'error');
      }
    }, 800);
  });

  $('#worldTitle').addEventListener('input', () => {
    clearTimeout(worldSaveTimer);
    worldSaveTimer = setTimeout(async () => {
      if (!state.worldId) return;
      const t = $('#worldTitle').value;
      try {
        await api('/api/world/' + state.worldId, { method: 'PATCH', body: { title: t } });
        const n = state.world.find(x => x.id === state.worldId);
        if (n) n.title = t;
        renderWorldList();
      } catch (e) {
        /* ignore */
      }
    }, 800);
  });

  $('#btnWorldDelete').onclick = async () => {
    if (!state.worldId) return;
    const node = state.world.find(n => n.id === state.worldId);
    if (!node) return;
    const ok = await confirmDialog('删除「' + node.title + '」？', '它和它的子条目都会放进 data/trash。', '删除', true);
    if (!ok) return;
    await api('/api/world/' + state.worldId, { method: 'DELETE' });
    state.world = (await api('/api/world')).items || [];
    state.worldId = null;
    $('#viewWorld').hidden = true;
    $('#viewEmpty').hidden = false;
    $('#viewEmpty').querySelector('.emptyText').textContent = '还没有词条。点右上角 + 新建。';
    renderWorldList();
  };
}

function openWorldMenu(id, anchorEl) {
  const node = state.world.find(n => n.id === id);
  if (!node) return;
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'ctxMenu';
  menu.innerHTML = `
    <button data-act="rename">重命名</button>
    <button data-act="add">新建子条目</button>
    <button data-act="indent">缩进一级</button>
    <button data-act="outdent">提升一级</button>
    <button data-act="delete" class="danger">删除</button>`;
  document.body.appendChild(menu);
  const mw = 168;
  const mh = menu.offsetHeight;
  let x = Math.max(8, rect.right - mw);
  let y = rect.bottom + 4;
  if (y + mh > innerHeight - 8) y = Math.max(8, rect.top - mh - 4);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  const close = () => menu.remove();
  setTimeout(() => {
    document.addEventListener('click', close, { once: true });
    document.addEventListener('scroll', close, { once: true, capture: true });
  }, 0);
  menu.onclick = async e => {
    const act = e.target.dataset.act;
    if (!act) return;
    close();
    if (act === 'rename') {
      const v = await promptDialog('重命名', '名字', node.title);
      if (v === null || !v.trim()) return;
      await api('/api/world/' + id, { method: 'PATCH', body: { title: v.trim() } });
    } else if (act === 'add') {
      await createWorldNode(id);
      return;
    } else if (act === 'indent') {
      const sibs = worldChildren(node.parentId);
      const i = sibs.findIndex(n => n.id === id);
      if (i <= 0) return;
      await api('/api/world/' + id, { method: 'PATCH', body: { parentId: sibs[i - 1].id } });
    } else if (act === 'outdent') {
      const p = state.world.find(n => n.id === node.parentId);
      if (!p) return;
      await api('/api/world/' + id, { method: 'PATCH', body: { parentId: p.parentId || null } });
    } else if (act === 'delete') {
      const ok = await confirmDialog('删除「' + node.title + '」？', '会放进 data/trash。', '删除', true);
      if (!ok) return;
      await api('/api/world/' + id, { method: 'DELETE' });
    }
    state.world = (await api('/api/world')).items || [];
    renderWorldList();
    if (state.worldId === id) openWorldNode(id);
  };
}

async function enterWorldView() {
  state.view = 'world';
  if (!state.world.length) await loadWorld();
  renderWorldList();
  if (!state.worldId || !state.world.find(n => n.id === state.worldId)) {
    if (state.world.length) openWorldNode(worldChildren(null)[0].id);
    else {
      $('#viewEditor').hidden = true;
      $('#viewCards').hidden = true;
      $('#viewPlot').hidden = true;
      $('#viewWorld').hidden = true;
      $('#viewStats').hidden = true;
      $('#viewEmpty').hidden = false;
      $('#viewEmpty').querySelector('.emptyText').textContent = '还没有词条。点右上角 + 新建。';
    }
  } else {
    openWorldNode(state.worldId);
  }
}
