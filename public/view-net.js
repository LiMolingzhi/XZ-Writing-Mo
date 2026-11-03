/* 人物关系网：一次只看一个人。

   中间是当前人物，外圈是跟他有关系的人，线上写着关系名。
   左边点谁，就以谁为中心；右边管他这一圈关系（加、改、删）。

   上一版是整张网一起摊开、拖拽缩放全上，看着像散点图、用起来还要学。
   这一版只做一件事：把一个人的关系摆清楚。 */

(function () {
  const NET = {
    boxH: 44,       // 中心那个方框的高度
    boxMinW: 96,    // 中心方框最小宽度
    ringR: 178,     // 关系环的半径
    chipW: 104,     // 外圈方框的宽度
    chipH: 40       // 外圈方框的高度
  };

  let netChars = [];     // 全部角色
  let netEdges = [];     // 全部关系 [{id, from, to, label, color, note}]
  let netTypes = [];     // 用户自己定的「关系名 → 颜色」
  let netTypeDefaults = []; // 服务端给的默认颜色表
  let netCenter = '';    // 当前中心角色 id
  let netFind = '';      // 左栏搜索词
  let netRelFind = '';   // 右栏搜索词
  let netPos = new Map(); // 拖过的位置：角色 id -> { x, y }（换中心也记着）
  let netDrag = null;     // 正在拖的那个节点
  let netDragMoved = false; // 刚拖完，别把这一下当成「点我想看他的关系」
  // 左栏自己排的顺序（谁在前谁在后）。没排过的按分量从重到轻。
  let netOrder = [];
  try { netOrder = JSON.parse(localStorage.getItem('mo:netOrder') || '[]') || []; } catch (err) { netOrder = []; }
  function saveNetOrder() {
    try { localStorage.setItem('mo:netOrder', JSON.stringify(netOrder)); } catch (err) {}
  }

  // 画布的缩放与平移：滚轮缩放、空白处拖动
  let netView = { k: 1, x: 0, y: 0 };

  // 拖过的位置存本机，刷新还在
  function loadNetPos() {
    try {
      const obj = JSON.parse(localStorage.getItem('mo:netPos') || '{}') || {};
      Object.keys(obj).forEach((id) => {
        const v = obj[id];
        if (v && typeof v.x === 'number' && typeof v.y === 'number') netPos.set(id, { x: v.x, y: v.y });
      });
    } catch (err) {}
  }
  function saveNetPos() {
    try {
      const obj = {};
      netPos.forEach((v, id) => { obj[id] = v; });
      localStorage.setItem('mo:netPos', JSON.stringify(obj));
    } catch (err) {}
  }
  loadNetPos();

  // 画布的缩放和位移也存本机，刷新回来还是你摆的那个视角
  function loadNetView() {
    try {
      const v = JSON.parse(localStorage.getItem('mo:netView') || 'null');
      if (v && typeof v.k === 'number' && typeof v.x === 'number' && typeof v.y === 'number') {
        netView = { k: Math.min(2.6, Math.max(0.35, v.k)), x: v.x, y: v.y };
      }
    } catch (err) {}
  }
  function saveNetView() {
    try { localStorage.setItem('mo:netView', JSON.stringify(netView)); } catch (err) {}
  }
  loadNetView();

  const $list = () => $('#netList');
  const $g = () => $('#netG');
  const $svg = () => $('#netSvg');

  const charOf = (id) => netChars.find((x) => x.id === id);
  const nameOf = (id) => {
    const c = charOf(id);
    return c ? (c.name || '无名') : '（已删除）';
  };

  // 跟某个人直接相连的关系
  function linksOf(id) {
    return netEdges
      .filter((e) => e.from === id || e.to === id)
      .map((e) => ({ edge: e, other: e.from === id ? e.to : e.from, label: e.label || '关系' }));
  }

  /* ---------------- 数据 ---------------- */

  async function netLoad() {
    const [chars, rel] = await Promise.all([
      api('/api/cards/characters').catch(() => ({ items: [] })),
      api('/api/net').catch(() => ({ edges: [] }))
    ]);
    netChars = (chars && chars.items) || [];
    state.characters = netChars;
    netEdges = (rel && Array.isArray(rel.edges)) ? rel.edges.slice() : [];
    netTypes = (rel && Array.isArray(rel.types)) ? rel.types.slice() : [];
    netTypeDefaults = (rel && Array.isArray(rel.defaultTypes)) ? rel.defaultTypes.slice() : [];

    if (!netCenter || !charOf(netCenter)) {
      // 默认停在分量最高的那位身上
      const top = netChars.slice().sort(
        (a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0)
      )[0];
      netCenter = top ? top.id : '';
    }
  }

  async function netSave(next, nextTypes) {
    const body = { edges: next };
    // 不传 types 就沿用现有的，别因为省参数把用户的颜色表冲掉
    body.types = Array.isArray(nextTypes) ? nextTypes : netTypes;
    const r = await api('/api/net', { method: 'PUT', body });
    if (r && Array.isArray(r.edges)) {
      netEdges = r.edges;
      if (Array.isArray(r.types)) netTypes = r.types;
      return true;
    }
    return false;
  }

  // ---- 关系类型的颜色表 ----
  // 一个名字配一个颜色；用户改了这个表，所有同名的线一起变色。
  function typeList() {
    return netTypes.length ? netTypes : netTypeDefaults;
  }

  function colorOfLabel(label) {
    const key = String(label || '').trim();
    const hit = typeList().find((t) => t.name === key);
    return hit ? hit.color : '#7a736a';
  }

  function colorOfEdge(e) {
    return (e && e.color) || colorOfLabel(e && e.label);
  }

  /* ---------------- 左栏：角色列表 ---------------- */

  function renderNetList() {
    const box = $list();
    if (!box) return;
    const kw = netFind.trim().toLowerCase();
    // 每个角色连着几个人，先数好，别在比较函数里反复算
    const degree = new Map();
    netEdges.forEach((e) => {
      degree.set(e.from, (degree.get(e.from) || 0) + 1);
      degree.set(e.to, (degree.get(e.to) || 0) + 1);
    });
    // 排过序的按排的顺序来；没排过的那些按「关系条数多的在前」，
    // 条数一样再按故事里的分量，最后按名字。
    const rank = (c) => {
      const i = netOrder.indexOf(c.id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const rows = netChars
      .slice()
      .sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        const da = degree.get(a.id) || 0;
        const db = degree.get(b.id) || 0;
        if (da !== db) return db - da;
        const ia = Number(a.importance) || 0;
        const ib = Number(b.importance) || 0;
        if (ia !== ib) return ib - ia;
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
      })
      .filter((c) => !kw || String(c.name || '').toLowerCase().includes(kw));

    box.innerHTML = rows.length
      ? rows.map((c) => {
        const n = degree.get(c.id) || 0;
        return `
          <div class="netRow${c.id === netCenter ? ' on' : ''}" data-char="${esc(c.id)}" draggable="true" title="按住上下拖，可以调顺序">
            <span class="netDot" style="background:${esc(c.color || '#5d5850')}"></span>
            <span class="netRowName">${esc(c.name || '无名')}</span>
            ${n ? `<span class="netRowNum">${n}</span>` : ''}
          </div>`;
      }).join('')
      : `<div class="netEmpty">没有找到「${esc(netFind)}」</div>`;
  }

  /* 左栏拖一下换顺序 */
  function bindNetListDrag() {
    const list = $list();
    if (!list) return;
    let fromId = '';
    const clearMarks = () => {
      list.querySelectorAll('.netRow').forEach((r) => {
        r.classList.remove('dragging', 'dropAbove', 'dropBelow');
      });
    };

    list.ondragstart = (e) => {
      const row = e.target.closest('.netRow');
      if (!row) return;
      fromId = row.dataset.char;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', fromId); } catch (err) {}
    };

    list.ondragend = () => {
      fromId = '';
      clearMarks();
    };

    list.ondragover = (e) => {
      if (!fromId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const row = e.target.closest('.netRow');
      if (!row || row.dataset.char === fromId) return;
      clearMarks();
      const r = row.getBoundingClientRect();
      row.classList.add((e.clientY - r.top) > r.height / 2 ? 'dropBelow' : 'dropAbove');
    };

    list.ondrop = (e) => {
      if (!fromId) return;
      e.preventDefault();
      const row = e.target.closest('.netRow');
      if (!row) return;
      const toId = row.dataset.char;
      if (!toId || toId === fromId) { clearMarks(); return; }
      const r = row.getBoundingClientRect();
      const below = (e.clientY - r.top) > r.height / 2;

      // 当前屏幕上看到的顺序（这样不管原来是怎么排的，都以眼见的为准）
      const shown = Array.from(list.querySelectorAll('.netRow')).map((x) => x.dataset.char);
      const from = shown.indexOf(fromId);
      const to = shown.indexOf(toId);
      if (from < 0 || to < 0) { clearMarks(); return; }
      shown.splice(from, 1);
      const at = shown.indexOf(toId);
      shown.splice(below ? at + 1 : at, 0, fromId);

      netOrder = shown;
      saveNetOrder();
      fromId = '';
      clearMarks();
      renderNetList();
      bindNetListDrag();
    };
  }

  /* ---------------- 中栏：星图 ---------------- */

  // 估算一段字在 SVG 里占多宽：汉字按字号算，半角按 0.55
  function textW(str, fs) {
    let n = 0;
    for (const ch of String(str || '')) {
      n += /[\x00-\xff]/.test(ch) ? fs * 0.55 : fs;
    }
    return n;
  }

  // 名字太长就把尾巴收成「…」，免得撑破方框
  function fitText(str, maxW, fs) {
    const s = String(str || '');
    if (textW(s, fs) <= maxW) return s;
    let out = '';
    let used = 0;
    for (const ch of s) {
      const cw = /[\x00-\xff]/.test(ch) ? fs * 0.55 : fs;
      if (used + cw > maxW - fs) break;
      out += ch;
      used += cw;
    }
    return out + '…';
  }

  function renderNetGraph() {
    const svg = $svg();
    const g = $g();
    if (!svg || !g) return;

    const box = svg.getBoundingClientRect();
    const w = Math.max(320, box.width || 640);
    const h = Math.max(320, box.height || 480);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const cx = w / 2;
    const cy = h / 2;

    if (!netCenter) {
      g.innerHTML = `<text x="${cx}" y="${cy}" class="netHintText" text-anchor="middle">还没有角色</text>`;
      return;
    }

    const center = charOf(netCenter);
    const links = linksOf(netCenter);
    // 外圈超过 12 个就往里挤一点，免得画到框外
    const ringR = Math.min(NET.ringR, Math.max(120, Math.min(w, h) / 2 - NET.chipH - 32));

    const n = links.length;
    const parts = [];

    // 先按「关系名」把外圈的人分组——同一色的必须挤在同一片扇区里，
    // 否则主干从中心伸出去还要横穿全图，看着就是一锅乱麻。
    const byColor = new Map();
    links.forEach((L) => {
      const col = colorOfEdge(L.edge);
      if (!byColor.has(col)) byColor.set(col, []);
      byColor.get(col).push(L);
    });
    // 组大的先排在前面（占的扇区宽一点）
    const groups = Array.from(byColor.entries())
      .sort((a, b) => b[1].length - a[1].length);

    // 每个颜色分一片扇区，扇区大小按组里人数分——人多的组占得宽，
    // 不然 4 个「朋友」会挤在 90° 里互相压住。
    const totalLinks = Math.max(1, links.length);
    let cursor = -Math.PI / 2;
    groups.forEach(([col, arr]) => {
      const sector = (Math.PI * 2) * (arr.length / totalLinks);
      const centerA = cursor + sector / 2;
      cursor += sector;
      const spread = sector * (arr.length > 1 ? 0.74 : 0);
      arr.forEach((L, k) => {
        const t = arr.length > 1 ? (k / (arr.length - 1) - 0.5) : 0;
        const a = centerA + t * spread;
        const moved = netPos.get(L.other);
        L._x = moved ? moved.x : cx + Math.cos(a) * ringR;
        L._y = moved ? moved.y : cy + Math.sin(a) * ringR;
        L._a = a;
        L._groupA = centerA;
        L._color = col;
      });
    });

    // 关系线：每个颜色一条主干，从中心朝该色的扇区伸出去，再像菌丝一样分叉
    const trunkLen = ringR * 0.48;

    groups.forEach(([col, arr]) => {
      const baseA = arr[0]._groupA;
      // 组里只有一个人：一条线拉过去就完
      if (arr.length === 1) {
        const L = arr[0];
        const mx = (cx + L._x) / 2;
        const my = (cy + L._y) / 2;
        const qx = mx + Math.cos(baseA + Math.PI / 2) * 16;
        const qy = my + Math.sin(baseA + Math.PI / 2) * 16;
        parts.push(`<path class="netLink" d="M${cx} ${cy} Q${qx} ${qy} ${L._x} ${L._y}" style="stroke:${col}"/>`);
        return;
      }

      const tx = cx + Math.cos(baseA) * trunkLen;
      const ty = cy + Math.sin(baseA) * trunkLen;
      parts.push(`<path class="netLink netTrunk" d="M${cx} ${cy} L${tx} ${ty}" style="stroke:${col}"/>`);

      // 从主干末端往各人拐，越靠边的弯得越开，看着才像一把散开的菌丝
      arr.forEach((L) => {
        const dx = L._x - tx;
        const dy = L._y - ty;
        const dist = Math.hypot(dx, dy) || 1;
        const off = Math.sin(L._a - baseA) * 26;
        const nx = -dy / dist;
        const ny = dx / dist;
        const qx = tx + dx * 0.5 + nx * off;
        const qy = ty + dy * 0.5 + ny * off;
        parts.push(`<path class="netLink" d="M${tx} ${ty} Q${qx} ${qy} ${L._x} ${L._y}" style="stroke:${col}"/>`);
      });
    });

    // 中心：一个方框，名字写在框里
    const centerName = center ? (center.name || '无名') : '';
    const cw = Math.max(NET.boxMinW, textW(centerName, 16) + 34);
    const chh = NET.boxH;
    parts.push(`<g class="netCenterBox">`);
    parts.push(`<rect class="netCenterRect" x="${cx - cw / 2}" y="${cy - chh / 2}" width="${cw}" height="${chh}" rx="10"/>`);
    parts.push(`<text class="netCenterText" x="${cx}" y="${cy + 6}">${esc(fitText(centerName, cw - 20, 16))}</text>`);
    parts.push(`</g>`);

    // 外圈的人：也是方框，名字在框里
    links.forEach((L) => {
      const c = charOf(L.other);
      const nm = c ? (c.name || '无名') : '（已删除）';
      const bw = NET.chipW;
      const bh = NET.chipH;
      const col = colorOfEdge(L.edge);
      parts.push(`<g class="netNode" data-char="${esc(L.other)}" data-x="${L._x}" data-y="${L._y}">`);
      parts.push(`<rect x="${L._x - bw / 2}" y="${L._y - bh / 2}" width="${bw}" height="${bh}" rx="9" style="stroke:${col}"/>`);
      parts.push(`<text class="netName" x="${L._x}" y="${L._y + 5}">${esc(fitText(nm, bw - 16, 12.5))}</text>`);
      parts.push(`</g>`);
    });

    if (!links.length) {
      parts.push(`<text class="netHintText" x="${cx}" y="${cy + chh / 2 + 46}" text-anchor="middle">他还没有任何关系，点右边「加一条关系」</text>`);
    }

    g.innerHTML = parts.join('');
    applyNetView();
  }

  // 把当前缩放/平移套到这层 <g> 上
  function applyNetView() {
    const g = $g();
    if (!g) return;
    g.setAttribute('transform', `translate(${netView.x} ${netView.y}) scale(${netView.k})`);
    saveNetView();
  }

  /* ---------------- 右栏：这个人的关系 ---------------- */

  function renderNetPanel() {
    const nameEl = $('#netCenterName');
    const metaEl = $('#netCenterMeta');
    const box = $('#netRels');
    if (!box) return;

    const c = charOf(netCenter);
    if (!c) {
      nameEl.textContent = '—';
      metaEl.textContent = '';
      box.innerHTML = '';
      return;
    }
    nameEl.textContent = c.name || '无名';
    const allLinks = linksOf(netCenter);
    // 右栏搜索：只按「对方名字」和「关系名」筛，不动底下的数据
    const q = String(netRelFind || '').trim().toLowerCase();
    const picked = q
      ? allLinks.filter((L) => {
        const nm = String(nameOf(L.other) || '').toLowerCase();
        const lb = String(L.label || '').toLowerCase();
        const nt = String(L.edge.note || '').toLowerCase();
        return nm.includes(q) || lb.includes(q) || nt.includes(q);
      })
      : allLinks;
    // 同一种关系的排在一起（上下贴着），别让「朋友」和「家人」交错着排——
    // 那样一眼扫下去根本数不清有几个人。大组在前，同组内保持原有先后。
    const links = (() => {
      const order = [];
      const bucket = new Map();
      picked.forEach((L) => {
        const k = String(L.label || '').trim() || '未标注';
        if (!bucket.has(k)) { bucket.set(k, []); order.push(k); }
        bucket.get(k).push(L);
      });
      order.sort((a, b) => bucket.get(b).length - bucket.get(a).length);
      const out = [];
      order.forEach((k) => out.push(...bucket.get(k)));
      return out;
    })();
    metaEl.textContent = q
      ? `${links.length} / ${allLinks.length} 条关系`
      : (allLinks.length ? `${allLinks.length} 条关系` : '还没有关系');

    if (!allLinks.length) {
      box.innerHTML = `<div class="netEmpty">这个人目前是座孤岛。</div>`;
      return;
    }
    box.innerHTML = links.length
      ? links.map((L, i) => {
        const col = colorOfEdge(L.edge);
        const hasNote = !!(L.edge.note && String(L.edge.note).trim());
        // 是不是这一组的第一条：是就插一行组标题，把同类的圈在一起
        const lab = String(L.label || '').trim() || '未标注';
        const prevLab = i > 0 ? (String(links[i - 1].label || '').trim() || '未标注') : '';
        const head = (i === 0 || lab !== prevLab)
          ? `<div class="netRelGroup" style="color:${esc(col)}"><span class="netRelGroupDot" style="background:${esc(col)}"></span>${esc(lab)}<span class="netRelGroupNum">${links.filter((x) => (String(x.label || '').trim() || '未标注') === lab).length}</span></div>`
          : '';
        return `${head}
        <div class="netRel" data-edge="${esc(L.edge.id)}">
          <div class="netRelHead">
            <span class="netRelDot" style="background:${esc(col)}"></span>
            <span class="netRelWho">${esc(nameOf(L.other))}</span>
            <span class="netRelTag" style="color:${esc(col)};border-color:${esc(col)}">${esc(L.label)}</span>
            <button class="netRelNote${hasNote ? ' has' : ''}" data-note="${esc(L.edge.id)}" title="写这段关系的详情">✎</button>
            <button class="netRelDel" data-edge="${esc(L.edge.id)}" title="删掉这条关系">×</button>
          </div>
          <div class="netRelBody" data-body="${esc(L.edge.id)}" hidden>
            <textarea class="netRelText" data-text="${esc(L.edge.id)}" rows="3"
              placeholder="这段关系发生了什么？有什么前因、秘密、还没说出口的话…">${esc(L.edge.note || '')}</textarea>
          </div>
        </div>`;
      }).join('')
      : `<div class="netEmpty">这里面没有叫「${esc(netRelFind.trim())}」的。</div>`;
  }

  // 存某条关系的详情文字
  async function saveEdgeNote(edgeId, text) {
    const next = netEdges.map((e) => (e.id === edgeId ? { ...e, note: String(text || '').slice(0, 2000) } : e));
    const ok = await netSave(next);
    if (!ok) { toast('没保存上', 'err'); return false; }
    const btn = document.querySelector(`.netRelNote[data-note="${edgeId}"]`);
    if (btn) btn.classList.toggle('has', !!String(text || '').trim());
    return true;
  }

  /* ---------------- 操作 ---------------- */

  function setCenter(id) {
    if (!id || id === netCenter) return;
    netCenter = id;
    // 注意：这里绝对不能 netPos.clear()。
    // 位置是按角色 id 记的，换中心、刷新都该留着——清一次，用户辛苦摆的图就白摆了。
    renderNetList();
    renderNetGraph();
    renderNetPanel();
    updateStat();
  }

  function updateStat() {
    const el = $('#netStat');
    if (!el) return;
    el.textContent = `${netChars.length} 人 · ${netEdges.length} 条关系`;
  }

  async function deleteEdge(edgeId) {
    const ok = await confirmDialog('拆掉这条关系？', '只删这一条，两个人都在，别的都不动。', '拆掉', true);
    if (!ok) return;
    const next = netEdges.filter((e) => e.id !== edgeId);
    const done = await netSave(next);
    if (!done) { toast('没保存上', 'err'); return; }
    toast('拆掉了');
    renderNetGraph();
    renderNetPanel();
    renderNetList();
    updateStat();
  }

  async function addRelation() {
    if (!netCenter) return;
    const c = charOf(netCenter);
    const taken = new Set(linksOf(netCenter).map((L) => L.other));
    const others = netChars
      .filter((x) => x.id !== netCenter)
      .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));

    if (!others.length) { toast('没有别人可以连', 'err'); return; }

    const rows = others.map((x) => `
      <button type="button" class="netPickItem${taken.has(x.id) ? ' taken' : ''}" data-id="${esc(x.id)}" data-name="${esc(String(x.name || '').toLowerCase())}">
        <span class="netPickName">${esc(x.name || '无名')}</span>
        ${taken.has(x.id) ? '<span class="netPickBadge">已连着</span>' : ''}
      </button>`).join('');
    // 关系名从「颜色表」里挑，挑到了就带上对应的颜色；想现编也行
    const typeOpts = typeList()
      .map((t) => `<option value="${esc(t.name)}" data-color="${esc(t.color)}">${esc(t.name)}</option>`)
      .join('');

    openOverlay(`
      <h3 class="ovTitle">给「${esc(c ? c.name : '')}」连一个人</h3>
      <label class="fLabel">跟谁</label>
      <input class="mInput" id="relWhoSearch" type="search" autocomplete="off" placeholder="搜名字…（共 ${others.length} 人）">
      <div class="netPickList" id="relWhoList">${rows}</div>
      <input type="hidden" id="relWho">
      <label class="fLabel" style="margin-top:12px">什么关系</label>
      <select class="mInput" id="relKind">${typeOpts}</select>
      <input class="mInput" id="relName" placeholder="也可以自己写：师徒 / 宿敌 / 兄妹…" maxlength="20" style="margin-top:8px">
      <div class="modalBtns row2">
        <button class="mBtn primary" data-act="ok">连上</button>
        <button class="mBtn" data-act="cancel">取消</button>
      </div>`, (card) => {
      const who = card.querySelector('#relWho');
      const list = card.querySelector('#relWhoList');
      const search = card.querySelector('#relWhoSearch');
      const kind = card.querySelector('#relKind');
      const nm = card.querySelector('#relName');
      const items = Array.from(list.querySelectorAll('.netPickItem'));

      const selectWho = (id) => {
        who.value = id;
        items.forEach((it) => it.classList.toggle('on', it.dataset.id === id));
      };
      items.forEach((it) => { it.onclick = () => selectWho(it.dataset.id); });
      if (items[0]) selectWho(items[0].dataset.id);

      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        let first = null;
        items.forEach((it) => {
          const hit = !q || (it.dataset.name || '').includes(q);
          it.style.display = hit ? '' : 'none';
          if (hit && !first) first = it;
        });
        if (q && first) selectWho(first.dataset.id);
      };
      search.focus();

      const pick = () => {
        const o = kind.options[kind.selectedIndex];
        if (o && !nm.value.trim()) nm.placeholder = `也可以自己写（留空就用「${o.value}」）`;
      };
      kind.onchange = pick;
      pick();
      const submit = async () => {
        const to = who.value;
        const custom = (nm.value || '').trim();
        const label = custom || (kind.value || '').trim() || '关系';
        if (!to) { toast('先选一个人', 'err'); return; }
        // 已连着就改成新名字，不重复加一条
        const exist = netEdges.find(
          (e) => (e.from === netCenter && e.to === to) || (e.to === netCenter && e.from === to)
        );
        let next;
        if (exist) {
          next = netEdges.map((e) => (e.id === exist.id ? { ...e, label, color: '' } : e));
        } else {
          next = netEdges.concat([{ from: netCenter, to, label, color: '', note: '' }]);
        }
        const ok = await netSave(next);
        if (!ok) { toast('没保存上', 'err'); return; }
        closeOverlay();
        toast(exist ? '改好了' : '连上了');
        renderNetGraph();
        renderNetPanel();
        renderNetList();
        updateStat();
      };
      card.querySelector('[data-act="ok"]').onclick = submit;
      card.querySelector('[data-act="cancel"]').onclick = closeOverlay;
      nm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); nm.focus(); }
      });
    });
  }

  /* ---------------- 关系类型（颜色 = 含义） ---------------- */

  // 一张表：每行「名字 + 颜色」。改完点保存，所有同名的线一起变色。
  function openTypeEditor() {
    const list = typeList();
    const rowsHtml = (arr) => arr.map((t, i) => `
      <div class="typeRow" data-i="${i}">
        <input class="mInput typeName" value="${esc(t.name)}" maxlength="20" placeholder="关系名">
        <input class="typeColor" type="color" value="${esc(t.color || '#7a736a')}">
        <button class="typeDel" title="删掉这一种">×</button>
      </div>`).join('');

    openOverlay(`
      <h3 class="ovTitle">关系类型与颜色</h3>
      <div class="ovHint">每种关系配一个颜色，线就按这个颜色画。改完点保存，所有同名的线一起变。</div>
      <div class="typeRows" id="typeRows">${rowsHtml(list)}</div>
      <button class="mBtn" id="typeAdd" style="margin-top:10px;width:100%">+ 再加一种</button>
      <div class="modalBtns row2">
        <button class="mBtn primary" data-act="ok">保存</button>
        <button class="mBtn" data-act="cancel">取消</button>
      </div>`, (card) => {
      const box = card.querySelector('#typeRows');
      const bindDel = () => {
        box.querySelectorAll('.typeDel').forEach((b) => {
          b.onclick = () => { b.closest('.typeRow').remove(); };
        });
      };
      bindDel();
      card.querySelector('#typeAdd').onclick = () => {
        const div = document.createElement('div');
        div.className = 'typeRow';
        div.innerHTML = `<input class="mInput typeName" maxlength="20" placeholder="关系名">
          <input class="typeColor" type="color" value="#7a736a">
          <button class="typeDel" title="删掉这一种">×</button>`;
        box.appendChild(div);
        bindDel();
        div.querySelector('.typeName').focus();
      };
      card.querySelector('[data-act="ok"]').onclick = async () => {
        const next = [...box.querySelectorAll('.typeRow')].map((r) => ({
          name: (r.querySelector('.typeName').value || '').trim(),
          color: r.querySelector('.typeColor').value || '#7a736a'
        })).filter((t) => t.name);
        // 边上的颜色留空，全部按新表重算；显式改过色的那几条保留
        const ok = await netSave(netEdges, next);
        if (!ok) { toast('没保存上', 'err'); return; }
        closeOverlay();
        toast('颜色表存好了');
        renderNetGraph();
        renderNetPanel();
      };
      card.querySelector('[data-act="cancel"]').onclick = closeOverlay;
    });
  }

  /* ---------------- 小工具 ---------------- */

  function firstChar(name, r) {
    const s = String(name || '·').replace(/^[+＋\s]+/, '');
    const ch = [...s][0] || '·';
    return ch;
  }

  function shortName(name) {
    const s = String(name || '无名');
    return [...s].length > 8 ? [...s].slice(0, 7).join('') + '…' : s;
  }

  /* ---------------- 绑定 ---------------- */

  function bindNetView() {
    const list = $list();
    if (list) {
      list.onclick = (e) => {
        const row = e.target.closest('[data-char]');
        if (row) setCenter(row.dataset.char);
      };
      bindNetListDrag();
    }

    const find = $('#netFind');
    if (find) {
      find.oninput = () => {
        netFind = find.value || '';
        renderNetList();
      };
    }

    const g = $g();
    if (g) {
      g.onclick = (e) => {
        // 刚拖完手的那一下不算点击，否则一松手就跳去别人的关系了
        if (netDragMoved) { netDragMoved = false; return; }
        const node = e.target.closest('[data-char]');
        if (node) setCenter(node.dataset.char);
      };

      // 拖动外圈方框自己摆位置；空白处按下则平移整张图
      // 两个关键点：① 量坐标只在按下时做一次（每帧量会强制重排，卡）
      //           ② 指针捕获要抓在 g 自己身上（抓在 svg 上，事件就绕过 g 了）
      let rect0 = null;

      const svgPt = (e) => {
        // 把屏幕坐标换算回「没缩放没平移」时的画布坐标
        return {
          x: (e.clientX - rect0.left - netView.x) / netView.k,
          y: (e.clientY - rect0.top - netView.y) / netView.k
        };
      };

      let pan = null;

      // 监听挂在外层的 #netStage 上，而不是 SVG 里的 <g>：
      // <g> 只有它画出来的图形才算「命中了它」，空白处的点击目标是 <svg>/<div>，
      // 压根冒泡不到 <g>——所以之前只有拖方框有用，拖背景没反应。
      const canvas = $('#netStage');

      canvas.onpointerdown = (e) => {
        rect0 = $svg().getBoundingClientRect();
        const node = e.target.closest('[data-char]');
        if (!node) {
          // 没点到方框 → 拖动画布
          pan = { x0: e.clientX, y0: e.clientY, vx: netView.x, vy: netView.y };
          try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
          canvas.classList.add('panning');
          return;
        }
        const p = svgPt(e);
        netDrag = { el: node, id: node.dataset.char, x0: p.x, y0: p.y, moved: false };
        netDragMoved = false;
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
      };

      canvas.onpointermove = (e) => {
        if (pan) {
          netView.x = pan.vx + (e.clientX - pan.x0);
          netView.y = pan.vy + (e.clientY - pan.y0);
          applyNetView();
          return;
        }
        if (!netDrag) return;
        const p = svgPt(e);
        const dx = p.x - netDrag.x0;
        const dy = p.y - netDrag.y0;
        if (!netDrag.moved && Math.hypot(dx, dy) * netView.k < 3) return;  // 抖一下不算拖
        netDrag.moved = true;
        netDrag.el.setAttribute('transform', `translate(${dx} ${dy})`);
      };

      const endDrag = (e) => {
        if (pan) {
          pan = null;
          try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
          canvas.classList.remove('panning');
          return;
        }
        if (!netDrag) return;
        const d = netDrag;
        netDrag = null;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
        if (!d.moved) return;  // 没真拖，交回给 click 去换中心
        const bx = Number(d.el.dataset.x) || 0;
        const by = Number(d.el.dataset.y) || 0;
        const m = /translate\(([-\d.]+)\s+([-\d.]+)\)/.exec(d.el.getAttribute('transform') || '');
        const dx = m ? Number(m[1]) : 0;
        const dy = m ? Number(m[2]) : 0;
        netPos.set(d.id, { x: bx + dx, y: by + dy });
        saveNetPos();          // 记在本机，刷新也还在
        netDragMoved = true;   // 紧接着的那次 click 要吞掉
        renderNetGraph();
      };
      canvas.onpointerup = endDrag;
      canvas.onpointercancel = endDrag;

      // 滚轮缩放：以鼠标所指的位置为中心
      canvas.onwheel = (e) => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const old = netView.k;
        const next = Math.min(2.6, Math.max(0.35, old * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        if (next === old) return;
        netView.x = px - (px - netView.x) * (next / old);
        netView.y = py - (py - netView.y) * (next / old);
        netView.k = next;
        applyNetView();
      };
    }

    const rels = $('#netRels');
    if (rels) {
      // 右栏搜索：输入即筛，只过滤显示，不动数据
      const relSearch = $('#netRelSearch');
      if (relSearch) {
        relSearch.oninput = () => {
          netRelFind = relSearch.value || '';
          renderNetPanel();
        };
        relSearch.onkeydown = (e) => {
          if (e.key === 'Escape') { relSearch.value = ''; netRelFind = ''; renderNetPanel(); }
        };
      }
      // 点 ✎ 展开/收起这段关系的详情输入框；× 删关系
      rels.onclick = (e) => {
        const noteBtn = e.target.closest('[data-note]');
        if (noteBtn) {
          const id = noteBtn.dataset.note;
          const body = rels.querySelector(`[data-body="${id}"]`);
          if (body) {
            body.hidden = !body.hidden;
            if (!body.hidden) {
              const ta = body.querySelector('textarea');
              if (ta) setTimeout(() => ta.focus(), 30);
            }
          }
          return;
        }
        const del = e.target.closest('.netRelDel');
        if (del) deleteEdge(del.dataset.edge);
      };
      // 失焦就存：不打断写，也不会忘
      rels.addEventListener('focusout', (e) => {
        const ta = e.target.closest('.netRelText');
        if (!ta) return;
        const id = ta.dataset.text;
        const old = (netEdges.find((x) => x.id === id) || {}).note || '';
        if (String(ta.value || '') === String(old || '')) return;
        saveEdgeNote(id, ta.value);
      });
    }

    const typeBtn = $('#netTypes');
    if (typeBtn) typeBtn.onclick = () => openTypeEditor();

    const add = $('#netAddRel');
    if (add) add.onclick = () => addRelation();

    const back = $('#netBack');
    if (back) back.onclick = () => switchView('characters');
  }

  /* ---------------- 入口 ---------------- */

  async function enterNetView() {
    $('#netTitle').textContent = '人物关系网';
    await netLoad();
    renderNetList();
    renderNetGraph();
    renderNetPanel();
    updateStat();
  }

  window.enterNetView = enterNetView;
  window.bindNetView = bindNetView;
})();
