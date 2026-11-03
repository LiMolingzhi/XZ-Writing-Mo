'use strict';
/* 角色卡 / 物品 / 情节 */

const CARD_KIND_META = {
  characters: { title: '角色', noun: '角色', unit: '人', icon: '人' },
  items: { title: '物品', noun: '物品', unit: '件', icon: '物' },
  plots: { title: '情节', noun: '情节线', unit: '节', icon: '事' }
};

// 角色在本子里的分量，五档，索引越大越重要
const IMPORTANCE_NAMES = ['少量', '正常', '次要', '主要', '重要'];
const IMPORTANCE_TOP = IMPORTANCE_NAMES.length - 1;

let cardSaveTimer = null;

function listOf(kind) {
  if (kind === 'characters') return state.characters;
  if (kind === 'items') return state.items;
  return state.plots;
}

function setList(kind, list) {
  if (kind === 'characters') state.characters = list;
  else if (kind === 'items') state.items = list;
  else state.plots = list;
}

function currentCardId(kind) {
  if (kind === 'characters') return state.cardId;
  if (kind === 'items') return state.cardId;
  return state.plotId;
}

function setCurrentCardId(kind, id) {
  if (kind === 'plots') state.plotId = id;
  else state.cardId = id;
}

// ---------------------------------------------------------------- 列表

/** 类别卡片列表顶部的分量滑块：拖到哪一档就只看那一档，拖到最左是全部 */
function renderImpFilter(kind) {
  const bar = $('#listFilter');
  if (!bar) return;
  if (kind !== 'characters' && kind !== 'plots') {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;

  const list = listOf(kind);
  const counts = new Array(IMPORTANCE_TOP + 1).fill(0);
  for (const c of list) counts[clampImp(c.importance)]++;

  // 滑块值 0 = 全部，1..N+1 依次对应 importance 0..N：左起「少量」，右头「重要」
  const vOf = imp => (imp === null ? 0 : imp + 1);
  const impOf = v => (v === 0 ? null : v - 1);
  const startV = vOf(state.impFilter);

  const ticks = ['<button type="button" data-v="0">全部</button>']
    .concat(
      IMPORTANCE_NAMES.map((n, i) => `<button type="button" data-v="${i + 1}">${esc(n)}</button>`)
    )
    .join('');

  bar.innerHTML =
    `<div class="impHead"><span class="impLbl">分量</span><span class="impCur" id="impCur"></span></div>
     <input class="impSlider" id="impSlider" type="range" min="0" max="${IMPORTANCE_TOP + 1}" step="1" value="${startV}" aria-label="只看某一档分量">
     <div class="impTicks" id="impTicks">${ticks}</div>`;

  const slider = bar.querySelector('#impSlider');
  const cur = bar.querySelector('#impCur');
  const ticksBox = bar.querySelector('#impTicks');

  // 拖动时只刷新文字和刻度高亮，绝不重建整条——重建会让 thumb 在手底下断掉
  const unit = CARD_KIND_META[kind].unit || '个';
  const maxV = IMPORTANCE_TOP + 1;
  // 已滑过的那一段点亮：把百分比写进 CSS 变量，轨道用渐变吃掉它
  const fill = v => slider.style.setProperty('--p', (maxV ? (v / maxV) * 100 : 0) + '%');
  const paint = v => {
    const imp = impOf(v);
    cur.textContent =
      imp === null ? `全部 · ${list.length} ${unit}` : `${IMPORTANCE_NAMES[imp]} · ${counts[imp]} ${unit}`;
    ticksBox.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === v));
    fill(v);
  };
  const apply = v => {
    state.impFilter = impOf(v);
    paint(v);
    renderCardList(kind);
  };

  paint(startV);
  slider.oninput = () => apply(Number(slider.value));
  ticksBox.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    const v = Number(b.dataset.v);
    slider.value = String(v);
    apply(v);
  };
}

function renderCardList(kind) {
  const body = $('#listBody');
  const meta = CARD_KIND_META[kind];
  $('#paneTitle').textContent = meta.title;
  const list = listOf(kind).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const cur = currentCardId(kind);
  const kw = state.filter.trim().toLowerCase();

  const visible = list.filter(c => {
    const grouped = kind === 'characters' || kind === 'plots';
    if (grouped && state.impFilter !== null && clampImp(c.importance) !== state.impFilter) {
      return false;
    }
    if (!kw) return true;
    const blob = (c.name + ' ' + (c.description || '') + ' ' + (c.goal || '') + ' ' + (c.summaryFull || '')).toLowerCase();
    return blob.includes(kw);
  });

  if (!visible.length) {
    const filtered = (kind === 'characters' || kind === 'plots') && state.impFilter !== null;
    body.innerHTML = kw || filtered
      ? `<div class="listEmpty">这一档里没有${meta.noun}。<br>把上面的滑块拖回最左。</div>`
      : `<div class="listEmpty">还没有${meta.noun}。点右上角 + 新建。</div>`;
    return;
  }

  const rowOf = (c, showBadge) => {
    const active = c.id === cur ? ' active' : '';
    const imp = clampImp(c.importance);
    const dotColor = kind === 'characters' ? c.color || '#3a3630' : '#3a3630';
    return `<div class="row leaf cardRow${active}" data-card="${c.id}" data-imp="${imp}" draggable="true" data-order="${c.order || 0}">
      <span class="cardDot" style="background:${esc(dotColor)}"></span>
      <span class="rowTitle">${esc(c.name || '未命名')}</span>
      ${showBadge && imp <= 1 ? `<span class="rowBadge dim">${esc(IMPORTANCE_NAMES[imp])}</span>` : ''}
      <button class="rowMore" data-cardmore="${c.id}" title="更多">⋯</button>
    </div>`;
  };

  // 角色和情节都按分量分组：一眼看清谁是主要的、谁只是提了一嘴
  if (kind === 'characters' || kind === 'plots') {
    const groups = new Map();
    for (const c of visible) {
      const imp = clampImp(c.importance);
      if (!groups.has(imp)) groups.set(imp, []);
      groups.get(imp).push(c);
    }
    const keys = [...groups.keys()].sort((a, b) => b - a);
    body.innerHTML = keys
      .map(k => {
        const arr = groups.get(k);
        return `<div class="groupHead"><span>${esc(IMPORTANCE_NAMES[k])}</span><span class="groupCount">${arr.length}</span></div>`
          + arr.map(c => rowOf(c, false)).join('');
      })
      .join('');
    return;
  }

  body.innerHTML = visible.map(c => rowOf(c, false)).join('');
}

function clampImp(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(IMPORTANCE_TOP, Math.round(n));
}

// ---------------------------------------------------------------- 详情表单

function fieldText(label, id, value, placeholder, rows) {
  if (rows && rows > 1) {
    return `<label class="fLabel">${label}</label>
      <textarea class="mInput mArea" id="${id}" rows="${rows}" placeholder="${esc(placeholder || '')}">${esc(value || '')}</textarea>`;
  }
  return `<label class="fLabel">${label}</label>
    <input class="mInput" id="${id}" value="${esc(value || '')}" placeholder="${esc(placeholder || '')}">`;
}

function renderCharacterDetail(card) {
  const imp = Number(card.importance) || 0;
  const impOpts = IMPORTANCE_NAMES.map((n, i) => `<option value="${i}" ${i === imp ? 'selected' : ''}>${n}</option>`).join('');
  const colors = ['', '#8c3b3b', '#8c6b33', '#3b6b8c', '#3b8c5e', '#6b3b8c', '#8c3b6b', '#5a5a5a'];
  const colorChips = colors
    .map(
      c =>
        `<button class="colorChip ${(card.color || '') === c ? 'on' : ''}" data-color="${c}"
           style="background:${c || 'transparent'};${c ? '' : 'border:1px dashed #555'}"></button>`
    )
    .join('');

  $('#cardBody').innerHTML = `
    <div class="detailScroll">
      <div class="fieldGrid">
        <label class="fLabel">重要程度</label>
        <select class="mInput" id="cfImportance">${impOpts}</select>
        <label class="fLabel">视角人物</label>
        <label class="checkLine"><input type="checkbox" id="cfPov" ${card.pov ? 'checked' : ''}> 从 TA 的眼睛看故事</label>
        <label class="fLabel">标记色</label>
        <div class="colorRow">${colorChips}</div>
        ${fieldText('一句话', 'cfPhrase', card.phraseSummary, '这个人一句话就说得清的部分', 3)}
        ${fieldText('一段话', 'cfParagraph', card.paragraphSummary, '性格、来历、和别人的关系', 4)}
        ${fieldText('动机（想要什么）', 'cfMotivation', card.motivation, '驱动 TA 往前走的那个东西')}
        ${fieldText('目标（具体要做什么）', 'cfGoal', card.goal, '')}
        ${fieldText('冲突（什么挡着 TA）', 'cfConflict', card.conflict, '')}
        ${fieldText('领悟（最后明白了什么）', 'cfEpiphany', card.epiphany, '这条弧光的落点')}
        ${fieldText('详细设定', 'cfFull', card.summaryFull, '外貌、习惯、说话方式、过去……想到什么写什么', 12)}
        ${customBlock(card.custom)}
      </div>
    </div>`;
  bindCardInputs('characters', card);
}

/** Manuskript 里用户自己加的那些栏位，一个都不能丢 */
function customBlock(custom) {
  const pairs = Object.entries(custom || {});
  const rows = pairs
    .map(
      ([k, v]) => `<div class="customRow">
        <input class="mInput cKey" value="${esc(k)}" placeholder="栏位名">
        <textarea class="mInput mArea cVal" rows="2" placeholder="内容">${esc(v)}</textarea>
        <button class="rowMore cDel" title="删掉这一栏">×</button>
      </div>`
    )
    .join('');
  return `<div class="fLabel">自定义栏位
      <button class="miniAdd" id="customAdd">+ 加一栏</button>
    </div>
    <div class="customList" id="customList">${rows || ''}</div>`;
}

function renderItemDetail(card) {
  $('#cardBody').innerHTML = `
    <div class="detailScroll">
      <div class="fieldGrid">
        ${fieldText('简短说明', 'ifDesc', card.description, '这件东西是什么')}
        ${fieldText('数量 / 分量', 'ifQuantity', card.quantity, '')}
        ${fieldText('持有人', 'ifOwner', card.owner, '')}
        ${fieldText('详细设定', 'ifFull', card.summaryFull, '来历、样子、用处、代价……', 12)}
      </div>
    </div>`;
  bindCardInputs('items', card);
}

function renderPlotDetail(card) {
  const chars = state.characters || [];
  const picked = card.characters || [];
  const charChips = chars
    .map(
      c =>
        `<button class="chip ${picked.includes(c.name) ? 'on' : ''}" data-char="${esc(c.name)}"
           style="--chip:${esc(c.color || '#6b6459')}">${esc(c.name)}</button>`
    )
    .join('');
  const imp = Number(card.importance) || 0;
  const impOpts = IMPORTANCE_NAMES.slice(0, 7)
    .map((n, i) => `<option value="${i}" ${i === imp ? 'selected' : ''}>${n}</option>`)
    .join('');

  // 关联章节。原来是个把所有节点塞进去的 <select>——书上几百章还凑合，
  // 几千章就变成一条拉不到底的名单。改成「点开 → 搜索 → 选中」，
  // 只有点了才建列表，平时这里只是一个按钮。
  const boundNode = card.nodeId ? nodeById(card.nodeId) : null;

  $('#plotBody').innerHTML = `
    <div class="detailScroll">
      <div class="fieldGrid">
        <label class="fLabel">重要程度</label>
        <select class="mInput" id="pfImportance">${impOpts}</select>
        <label class="fLabel">关联章节</label>
        <div class="nodePick">
          <button class="mInput nodePickBtn" id="pfNodeBtn" type="button">
            <span class="npText${boundNode ? '' : ' dim'}" id="pfNodeText">${boundNode ? esc(boundNode.title || '未命名') : '— 没绑定 —'}</span>
            <span class="npCaret">▾</span>
          </button>
          <input type="hidden" id="pfNode" value="${esc(card.nodeId || '')}">
          <button class="mBtn sm" id="pfGoto" type="button">跳过去</button>
        </div>
        <div class="fLabel fLabelRow">涉及角色
          <span class="fCount" id="pfCharCount"></span>
          <button class="foldBtn" id="pfCharFold" type="button">展开</button>
        </div>
        <input class="mInput charSearch" id="pfCharFilter" placeholder="找角色…" autocomplete="off" hidden>
        <div class="chips" id="pfChars">${charChips || '<span class="dim">还没有角色卡</span>'}</div>
        <div class="charHint" id="pfCharHint"></div>
        ${fieldText('发生了什么', 'pfDesc', card.description, '起因、经过', 6)}
        ${fieldText('结果 / 影响', 'pfResult', card.result, '这件事改变了什么', 4)}
        ${fieldText('详细设定', 'pfFull', card.summaryFull, '', 10)}
      </div>
    </div>`;
  bindCardInputs('plots', card);

  // 角色一多，平铺的 chips 就找不着人：默认折叠，只露出已经选上的；
  // 展开之后才给搜索框。藏起来的 chip 仍然带 .on，保存时不会把选中的人丢掉
  const charsBox = $('#pfChars');
  const charFilter = $('#pfCharFilter');
  const charCount = $('#pfCharCount');
  const foldBtn = $('#pfCharFold');
  const charHint = $('#pfCharHint');
  let charsOpen = false;

  const applyFold = () => {
    if (!charsBox) return;
    const n = charsBox.querySelectorAll('.chip.on').length;
    if (charCount) charCount.textContent = n ? `已选 ${n}` : '';
    if (foldBtn) foldBtn.textContent = charsOpen ? '收起' : `展开 ${chars.length}`;
    if (charFilter) {
      charFilter.hidden = !charsOpen;
      if (!charsOpen) charFilter.value = '';
    }
    const kw = charsOpen && charFilter ? charFilter.value.trim().toLowerCase() : '';
    charsBox.querySelectorAll('.chip').forEach(el => {
      const on = el.classList.contains('on');
      const hit = charsOpen ? !kw || String(el.dataset.char || '').toLowerCase().includes(kw) : on;
      el.style.display = hit ? '' : 'none';
    });
    if (charHint) {
      charHint.textContent = !charsOpen && n === 0 ? '还没选人，点上面的「展开」挑一个。' : '';
    }
  };

  applyFold();
  if (foldBtn) {
    foldBtn.onclick = () => {
      charsOpen = !charsOpen;
      applyFold();
    };
  }
  if (charFilter) charFilter.addEventListener('input', applyFold);
  if (charsBox) charsBox.addEventListener('click', () => setTimeout(applyFold, 0));

  const nodeInput = $('#pfNode');
  const nodeBtn = $('#pfNodeBtn');
  const nodeText = $('#pfNodeText');
  const gotoBtn = $('#pfGoto');

  const paintNode = () => {
    const id = nodeInput ? nodeInput.value : '';
    const n = id ? nodeById(id) : null;
    if (nodeText) {
      nodeText.textContent = n ? n.title || '未命名' : '— 没绑定 —';
      nodeText.classList.toggle('dim', !n);
    }
    if (gotoBtn) gotoBtn.disabled = !id;
  };
  paintNode();

  if (nodeBtn && nodeInput) {
    nodeBtn.onclick = () => {
      openNodePicker(nodeBtn, nodeInput.value, (id) => {
        nodeInput.value = id || '';
        paintNode();
        // 触一次 change，走 bindCardInputs 的自动保存
        nodeInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
  }
  if (gotoBtn) {
    gotoBtn.onclick = () => {
      const id = nodeInput && nodeInput.value;
      if (!id) return;
      jumpToNode(id);
    };
  }
}

/** 从任何地方跳到大纲里的某个节点 */
function jumpToNode(id) {
  const node = nodeById(id);
  if (!node) {
    toast('这个节点找不到了', 'error');
    return;
  }
  switchView('tree');
  setTimeout(() => {
    for (const p of pathOf(id)) state.collapsed.delete(p.id);
    renderTreeList();
    if (node.type === 'folder') showNodeInfo(id);
    else openNode(id);
  }, 60);
}

/** 整棵树按显示顺序拉平（不管折叠状态），给下拉框用 */
function allNodesFlat() {
  const out = [];
  const walk = (pid, depth) => {
    for (const n of childrenOf(pid)) {
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * 整棵树拉平，每条顺带记下它的完整路径（「卷一 · 001·020 · 总结」）。
 * 这样搜索时可以按路径里的任意一段命中——几万章的时候，
 * 光靠标题已经找不着了，人记得的往往是「那卷里的第三章」。
 */
function nodesIndexed() {
  const out = [];
  const walk = (pid, depth, trail) => {
    for (const n of childrenOf(pid)) {
      const title = n.title || '未命名';
      const full = trail ? trail + ' · ' + title : title;
      out.push({ node: n, depth, trail: full, parentTrail: trail });
      walk(n.id, depth + 1, full);
    }
  };
  walk(null, 0, '');
  return out;
}

let npCleanup = null;

function closeNodePicker() {
  const pop = document.getElementById('npPop');
  if (pop) pop.remove();
  if (npCleanup) {
    try {
      npCleanup();
    } catch (e) {
      /* 忽略 */
    }
    npCleanup = null;
  }
}

/** 选一个章节来关联：点开是一个可搜索的浮层，不再是一条拉不到底的名单 */
function openNodePicker(anchor, currentId, onPick) {
  closeNodePicker();
  const all = nodesIndexed();

  const pop = document.createElement('div');
  pop.className = 'npPop';
  pop.id = 'npPop';
  pop.innerHTML = `
    <input class="mInput npSearch" id="npSearch" placeholder="搜标题，或路径里的任意一段…" autocomplete="off" spellcheck="false">
    <div class="npList" id="npList"></div>
    <div class="npFoot" id="npFoot"></div>`;
  document.body.appendChild(pop);

  const search = pop.querySelector('#npSearch');
  const list = pop.querySelector('#npList');
  const foot = pop.querySelector('#npFoot');

  // 定位：贴在按钮下面；下面放不下就翻到上面去
  const r = anchor.getBoundingClientRect();
  const w = Math.max(300, Math.min(460, r.width + 160));
  pop.style.width = w + 'px';
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 12)) + 'px';
  pop.style.maxHeight = Math.min(380, window.innerHeight - 80) + 'px';
  const ph = pop.getBoundingClientRect().height;
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 10) top = Math.max(10, r.top - ph - 6);
  pop.style.top = top + 'px';

  const LIMIT = 120;
  const items = () => [...list.querySelectorAll('.npItem')];
  let active = 0;

  const setActive = (i) => {
    const arr = items();
    if (!arr.length) return;
    active = Math.max(0, Math.min(arr.length - 1, i));
    arr.forEach((el, j) => el.classList.toggle('on', j === active));
    arr[active].scrollIntoView({ block: 'nearest' });
  };

  const choose = (id) => {
    closeNodePicker();
    onPick(id);
  };

  const render = () => {
    const kw = search.value.trim().toLowerCase();
    const hit = kw ? all.filter((x) => x.trail.toLowerCase().includes(kw)) : all;
    const part = hit.slice(0, LIMIT);

    let html = `<button class="npItem" data-id="" type="button"><span class="npTitle dim">— 不绑定 —</span></button>`;
    html += part
      .map((x) => {
        const pad = 8 + Math.min(x.depth, 6) * 12;
        return `<button class="npItem" data-id="${x.node.id}" type="button" style="padding-left:${pad}px">
          <span class="npTitle">${esc(x.node.title || '未命名')}</span>
          ${x.parentTrail ? `<span class="npPath">${esc(x.parentTrail)}</span>` : ''}
        </button>`;
      })
      .join('');
    list.innerHTML = html;

    foot.textContent = kw
      ? `匹配 ${hit.length} 条` + (hit.length > LIMIT ? `，只显示前 ${LIMIT} 条` : '')
      : `共 ${all.length} 个节点 · 直接输入就能筛`;

    // 光标默认停在当前绑定的那一章上
    const cur = items().findIndex((el) => el.dataset.id === currentId);
    setActive(cur >= 0 ? cur : 0);
  };

  list.onclick = (e) => {
    const b = e.target.closest('.npItem');
    if (!b) return;
    choose(b.dataset.id || '');
  };

  search.addEventListener('input', render);
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const el = items()[active];
      if (el) choose(el.dataset.id || '');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeNodePicker();
    }
  });

  // 点/滚到别处就收起
  const onDocDown = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) closeNodePicker();
  };
  const onScroll = (e) => {
    if (!pop.contains(e.target)) closeNodePicker();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('scroll', onScroll, true);
  }, 0);
  npCleanup = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('scroll', onScroll, true);
  };

  render();
  search.focus();
}

function bindCardInputs(kind, card) {
  const root = kind === 'plots' ? $('#plotBody') : $('#cardBody');

  const gather = () => {
    const patch = {};
    const inp = root.querySelectorAll('input[id], textarea[id], select[id]');
    for (const el of inp) {
      if (el.type === 'checkbox') {
        if (el.id === 'cfPov') patch.pov = el.checked;
        continue;
      }
      const map = {
        cfPhrase: 'phraseSummary',
        cfParagraph: 'paragraphSummary',
        cfMotivation: 'motivation',
        cfGoal: 'goal',
        cfConflict: 'conflict',
        cfEpiphany: 'epiphany',
        cfFull: 'summaryFull',
        ifDesc: 'description',
        ifQuantity: 'quantity',
        ifOwner: 'owner',
        ifFull: 'summaryFull',
        pfDesc: 'description',
        pfResult: 'result',
        pfFull: 'summaryFull',
        pfNode: 'nodeId'
      };
      if (el.id === 'cfImportance' || el.id === 'pfImportance') {
        patch.importance = Number(el.value) || 0;
      } else if (map[el.id]) {
        patch[map[el.id]] = el.value;
      }
    }
    const chips = Array.from(root.querySelectorAll('.chip.on')).map(el => el.dataset.char);
    if (kind === 'plots' && root.querySelector('#pfChars')) patch.characters = chips;
    const color = root.querySelector('.colorChip.on');
    if (kind === 'characters' && root.querySelector('.colorRow')) patch.color = color ? color.dataset.color : '';

    // 自定义栏位：空名不留；同名后者覆盖前者
    const customList = root.querySelector('#customList');
    if (customList) {
      const custom = {};
      customList.querySelectorAll('.customRow').forEach(row => {
        const k = row.querySelector('.cKey').value.trim();
        const v = row.querySelector('.cVal').value;
        if (k) custom[k] = v;
      });
      patch.custom = custom;
    }
    return patch;
  };

  const schedule = () => {
    Object.assign(card, gather());
    renderCardList(kind);
    clearTimeout(cardSaveTimer);
    cardSaveTimer = setTimeout(async () => {
      try {
        await api('/api/cards/' + kind + '/' + card.id, { method: 'PATCH', body: gather() });
      } catch (e) {
        toast('没存上：' + e.message, 'error');
      }
    }, 700);
  };

  root.addEventListener('input', schedule);
  root.addEventListener('change', schedule);
  root.querySelectorAll('.colorChip').forEach(el => {
    el.onclick = () => {
      root.querySelectorAll('.colorChip').forEach(x => x.classList.remove('on'));
      el.classList.add('on');
      schedule();
    };
  });
  root.querySelectorAll('.chip').forEach(el => {
    el.onclick = () => {
      el.classList.toggle('on');
      schedule();
    };
  });

  // 自定义栏位的增删
  const customList = root.querySelector('#customList');
  if (customList) {
    const addBtn = root.querySelector('#customAdd');
    if (addBtn) {
      addBtn.onclick = () => {
        const div = document.createElement('div');
        div.className = 'customRow';
        div.innerHTML = `<input class="mInput cKey" placeholder="栏位名">
          <textarea class="mInput mArea cVal" rows="2" placeholder="内容"></textarea>
          <button class="rowMore cDel" title="删掉这一栏">×</button>`;
        customList.appendChild(div);
        div.querySelector('.cKey').focus();
      };
    }
    customList.addEventListener('click', e => {
      const del = e.target.closest('.cDel');
      if (!del) return;
      del.closest('.customRow').remove();
      schedule();
    });
  }
}

// ---------------------------------------------------------------- 打开

function openCard(kind, id) {
  const card = listOf(kind).find(c => c.id === id);
  if (!card) return;
  setCurrentCardId(kind, id);
  if (kind === 'plots') {
    $('#plotName').value = card.name || '';
    renderPlotDetail(card);
    $('#viewCards').hidden = true;
    $('#viewPlot').hidden = false;
  } else {
    $('#cardName').value = card.name || '';
    if (kind === 'characters') renderCharacterDetail(card);
    else renderItemDetail(card);
    $('#viewCards').hidden = false;
    $('#viewPlot').hidden = true;
  }
  $('#viewEditor').hidden = true;
  $('#viewWorld').hidden = true;
  $('#viewStats').hidden = true;
  $('#viewEmpty').hidden = true;
  renderCardList(kind);
}

async function createCard(kind) {
  // 角色和情节：名字和分量一起问，省得建完还要点进去改
  if (kind === 'characters' || kind === 'plots') {
    const picked = await newCardDialog(kind);
    if (!picked) return;
    try {
      const r = await api('/api/cards/' + kind, {
        method: 'POST',
        body: { name: picked.name, importance: picked.importance }
      });
      const list = await loadCards(kind);
      setList(kind, list);
      state.impFilter = null;
      renderImpFilter(kind);
      openCard(kind, r.card.id);
    } catch (e) {
      toast('建不上：' + e.message, 'error');
    }
    return;
  }

  const name = await promptDialog('新建' + CARD_KIND_META[kind].noun, '名字', '');
  if (name === null) return;
  try {
    const r = await api('/api/cards/' + kind, { method: 'POST', body: { name: name.trim() || '未命名' } });
    const list = await loadCards(kind);
    setList(kind, list);
    openCard(kind, r.card.id);
  } catch (e) {
    toast('建不上：' + e.message, 'error');
  }
}

/** 新建角色 / 情节：名字 + 分量，一次性问完 */
function newCardDialog(kind) {
  return new Promise(resolve => {
    const isChar = kind === 'characters';
    const noun = CARD_KIND_META[kind].noun;
    // 角色默认「重要」，情节默认「次要」——新加的情节一般是支线
    let imp = isChar ? 4 : 2;
    openOverlay(
      `<div class="modalTitle">新建${esc(noun)}</div>
       <div class="fLabel">名字</div>
       <input class="mInput" id="mNewCharName" value="" placeholder="之后随时能改">
       <div class="fLabel" style="margin-top:18px">在这个故事里的分量</div>
       <div class="impPick" id="mNewCharImp">
         ${Array.from({ length: IMPORTANCE_TOP + 1 }, (_, i) => IMPORTANCE_TOP - i)
           .map(i => `<button data-imp="${i}" class="${i === imp ? 'on' : ''}">${esc(IMPORTANCE_NAMES[i])}</button>`)
           .join('')}
       </div>
       <div class="modalBtns">
         <button class="mBtn primary" data-act="ok">建好</button>
         <button class="mBtn" data-act="cancel">取消</button>
       </div>`,
      card => {
        const input = card.querySelector('#mNewCharName');
        const pick = card.querySelector('#mNewCharImp');
        setTimeout(() => input.focus(), 60);
        pick.onclick = e => {
          const b = e.target.closest('[data-imp]');
          if (!b) return;
          imp = Number(b.dataset.imp);
          Array.from(pick.querySelectorAll('button')).forEach(x => x.classList.toggle('on', x === b));
        };
        const ok = () => {
          const name = input.value.trim();
          if (!name) {
            input.focus();
            return;
          }
          closeOverlay();
          resolve({ name, importance: imp });
        };
        card.querySelector('[data-act="ok"]').onclick = ok;
        card.querySelector('[data-act="cancel"]').onclick = () => {
          closeOverlay();
          resolve(null);
        };
        input.onkeydown = e => {
          if (e.key === 'Enter') ok();
        };
      }
    );
  });
}

async function deleteCard(kind, targetId) {
  const id = targetId || currentCardId(kind);
  const card = listOf(kind).find(c => c.id === id);
  if (!card) return;
  const ok = await confirmDialog('删除「' + card.name + '」？', '会放进 data/trash，不会真的消失。', '删除', true);
  if (!ok) return;
  await api('/api/cards/' + kind + '/' + id, { method: 'DELETE' });
  const list = await loadCards(kind);
  setList(kind, list);
  const wasOpen = currentCardId(kind) === id;
  if (wasOpen) setCurrentCardId(kind, '');
  renderCardList(kind);
  if (!wasOpen) return;
  const first = list[0];
  if (first) openCard(kind, first.id);
  else enterCardsView(kind);
}

/** 列表行上的 ⋯：重命名 / 删除。以前这里只弹一个改名框，想删只能进详情再找那个灰 ✕ */
function openCardMenu(kind, id, anchorEl) {
  const card = listOf(kind).find(c => c.id === id);
  if (!card) return;
  // 先清掉上一个：手机上点完 ⋯ 再点另一个 ⋯ 时，上一次的关闭监听
  // 会先把新菜单 remove 掉（同一个点击事件里发生），于是屏幕上留下一个关不掉的孤儿
  document.querySelectorAll('.ctxMenu').forEach(m => m.remove());
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'ctxMenu';
  menu.innerHTML = `
    <button data-act="rename">重命名</button>
    <button data-act="open">打开</button>
    <button data-act="delete" class="danger">删除</button>`;
  document.body.appendChild(menu);
  const mw = 168;
  const mh = menu.offsetHeight;
  let x = rect.right - mw;
  let y = rect.bottom + 4;
  if (x < 8) x = 8;
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
    if (act === 'open') return openCard(kind, id);
    if (act === 'delete') return deleteCard(kind, id);
    if (act === 'rename') {
      const v = await promptDialog('重命名', '名字', card.name);
      if (v === null || !v.trim()) return;
      await api('/api/cards/' + kind + '/' + id, { method: 'PATCH', body: { name: v.trim() } });
      card.name = v.trim();
      renderCardList(kind);
      if (currentCardId(kind) === id) openCard(kind, id);
    }
  };
}

function bindCardsView(kind) {
  const body = $('#listBody');
  // 用 onclick 赋值而不是 addEventListener：每次进视图都会重新绑一次，
  // 用监听器会越垒越多（切十次就十个回调同时在跑），赋值天然幂等。
  body.onclick = e => {
    const more = e.target.closest('[data-cardmore]');
    if (more) {
      e.stopPropagation();
      openCardMenu(kind, more.dataset.cardmore, more);
      return;
    }
    const row = e.target.closest('[data-card]');
    if (!row) return;
    openCard(kind, row.dataset.card);
    if (innerWidth <= 900) document.body.classList.remove('listOpen');
  };

  const nameInput = kind === 'plots' ? $('#plotName') : $('#cardName');
  if (nameInput && !nameInput.dataset.bound) {
    nameInput.dataset.bound = '1';
    nameInput.addEventListener('input', () => {
      const id = currentCardId(kind);
      const card = listOf(kind).find(c => c.id === id);
      if (!card) return;
      card.name = nameInput.value;
      renderCardList(kind);
      clearTimeout(cardSaveTimer);
      cardSaveTimer = setTimeout(async () => {
        try {
          await api('/api/cards/' + kind + '/' + card.id, { method: 'PATCH', body: { name: card.name } });
        } catch (e) {
          /* ignore */
        }
      }, 700);
    });
  }

  const delBtn = kind === 'plots' ? $('#btnPlotDelete') : $('#btnCardDelete');
  if (delBtn) delBtn.onclick = () => deleteCard(kind);

  // 拖拽排序：拖到某一行的上半 = 插到它前面，下半 = 插到它后面。
  // 角色是分组的，拖到哪个组就跟着变成那个分量——比先去改下拉再拖直观。
  let dragCardId = null;
  const clearHints = () =>
    $$('.cardRow.dropAbove,.cardRow.dropBelow').forEach(el => el.classList.remove('dropAbove', 'dropBelow'));

  body.ondragstart = e => {
    const row = e.target.closest('[data-card]');
    if (!row) return;
    dragCardId = row.dataset.card;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragCardId);
    setTimeout(() => row.classList.add('dragging'), 0);
  };
  body.ondragend = () => {
    $$('.cardRow.dragging').forEach(el => el.classList.remove('dragging'));
    clearHints();
    dragCardId = null;
  };
  body.ondragover = e => {
    if (!dragCardId) return;
    const row = e.target.closest('[data-card]');
    clearHints();
    if (!row || row.dataset.card === dragCardId) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const below = e.clientY - rect.top > rect.height / 2;
    row.dataset.dropSide = below ? 'below' : 'above';
    row.classList.add(below ? 'dropBelow' : 'dropAbove');
  };
  body.ondrop = async e => {
    e.preventDefault();
    const row = e.target.closest('[data-card]');
    const src = dragCardId;
    const side = row ? row.dataset.dropSide : '';
    clearHints();
    dragCardId = null;
    if (!row || !src || row.dataset.card === src) return;
    try {
      await moveCard(kind, src, row.dataset.card, side === 'below');
    } catch (err) {
      toast('挪不动：' + err.message, 'error');
    }
  };
}

/** 把一张卡挪到另一张卡的上面/下面，跨组时顺带改成目标那组的分量 */
async function moveCard(kind, srcId, dstId, below) {
  const list = listOf(kind);
  const src = list.find(c => c.id === srcId);
  const dst = list.find(c => c.id === dstId);
  if (!src || !dst) return;

  // 分量单独改，顺序单独排。两件事分开走，
  // 免得旧版页面缓存把一整个分量的映射表一起上传，把别人全改成 0。
  const targetImp = clampImp(dst.importance);
  if (clampImp(src.importance) !== targetImp) {
    await api('/api/cards/' + kind + '/' + srcId, {
      method: 'PATCH',
      body: { importance: targetImp }
    });
    src.importance = targetImp;
  }

  const cmp =
    kind === 'characters'
      ? (a, b) => clampImp(b.importance) - clampImp(a.importance) || (a.order || 0) - (b.order || 0)
      : (a, b) => (a.order || 0) - (b.order || 0);

  const arranged = list.filter(c => c.id !== srcId).sort(cmp);
  const i = arranged.findIndex(c => c.id === dstId);
  arranged.splice(below ? i + 1 : i, 0, src);

  const ids = arranged.map(c => c.id);
  await api('/api/cards/' + kind + '/reorder', { method: 'POST', body: { ids } });

  ids.forEach((id, ix) => {
    const c = list.find(x => x.id === id);
    if (!c) return;
    c.order = ix + 1;
  });
  renderCardList(kind);
  if (currentCardId(kind) === srcId) openCard(kind, srcId);
}

async function enterCardsView(kind) {
  state.view = kind;
  let list;
  if (listOf(kind).length) list = listOf(kind);
  else list = await loadCards(kind);
  setList(kind, list);
  if (kind === 'plots') await ensureCharacters();
  bindCardsView(kind);
  renderImpFilter(kind);
  renderCardList(kind);
  const cur = currentCardId(kind);
  if (!cur || !list.find(c => c.id === cur)) {
    if (list.length) openCard(kind, list[0].id);
    else {
      $('#viewEditor').hidden = true;
      $('#viewCards').hidden = true;
      $('#viewPlot').hidden = true;
      $('#viewWorld').hidden = true;
      $('#viewStats').hidden = true;
      showEmpty(
        CARD_KIND_META[kind].title,
        '还没有' + CARD_KIND_META[kind].noun + '。点右上角 + 新建。'
      );
    }
  } else {
    openCard(kind, cur);
  }
}

async function ensureCharacters() {
  if (!state.characters.length) await loadCards('characters');
}

/** 大纲那边要显示「这一章挂了哪些情节」，所以要确保情节已经拉下来 */
async function ensurePlots() {
  if (!state.plots.length) {
    try {
      setList('plots', await loadCards('plots'));
    } catch (e) {
      /* 拉不到就算了，节点信息面板里显示成空的 */
    }
  }
}
