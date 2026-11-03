// ═══════════════════════════════════════════════════════════
// 「树」视图：把世界树画成一张思维导图
//
// 世界那边的列表是「一条一条看」，这里是「一眼看全貌」。
// 同一个 world.json，两套读法。
// ═══════════════════════════════════════════════════════════

const MIND = {
  colW: 210,        // 层与层之间的横向距离
  rowH: 34,         // 一个节点占的纵向高度（含间距）
  nodeH: 26,        // 卡片本身高度
  padX: 14,         // 卡片左右内边距
  charW: 13.5,      // 一个汉字大约多宽
  rootGap: 26,      // 两根之间留的空
  minW: 74
};

let mindData = null;          // 上一次拉到的 world 数组
let mindFolded = new Set();   // 被折起来的节点 id
let mindSel = '';             // 当前选中的节点
let mindView = { k: 1, x: 0, y: 0 };
let mindDrag = null;

function mindKids() {
  const map = new Map();
  for (const n of mindData || []) {
    const p = n.parentId || '';
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(n);
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.order || 0) - (b.order || 0));
  return map;
}

function mindNodeW(n) {
  const t = String(n.title || '');
  let w = 0;
  for (const ch of t) w += /[\x00-\xff]/.test(ch) ? MIND.charW * 0.55 : MIND.charW;
  // 上限给到 340：原来卡 230，十几个字的名字一律被截成「…」，
  // 而世界树里往往有一批名字很长的词条。
  return Math.max(MIND.minW, Math.min(340, w + MIND.padX * 2));
}

function mindTextW(n) {
  return mindNodeW(n);
}

/** 把整棵树摊成坐标。返回 {nodes, edges, w, h} */
function mindLayout() {
  const kids = mindKids();
  const roots = kids.get('') || [];
  const out = [];
  const edges = [];
  let cursor = 0;

  function walk(n, depth, parent) {
    const myKids = mindFolded.has(n.id) ? [] : (kids.get(n.id) || []);
    const w = mindNodeW(n);
    const x = MIND.padX + depth * MIND.colW;
    // 先把父节点挂上再递归孩子——反过来的话孩子算连线时父节点还不在 out 里，
    // find 拿到 undefined，整张图一条线都画不出来。
    const node = { id: n.id, t: n.title || '（没名字）', x, y: 0, w, d: depth, raw: n };
    out.push(node);
    if (parent) edges.push({ from: parent, to: node });

    let y;
    if (!myKids.length) {
      y = cursor;
      cursor += MIND.rowH;
    } else {
      const childYs = myKids.map(k => walk(k, depth + 1, node));
      y = (childYs[0] + childYs[childYs.length - 1]) / 2;
    }
    node.y = y;
    return y;
  }

  for (let i = 0; i < roots.length; i++) {
    walk(roots[i], 0, null);
    cursor += MIND.rootGap;
  }

  const maxX = out.reduce((m, o) => Math.max(m, o.x + o.w), 0);
  const maxY = out.reduce((m, o) => Math.max(m, o.y + MIND.nodeH), 0);
  return { nodes: out, edges, w: maxX + MIND.padX * 2, h: maxY + MIND.padX * 2 };
}

function mindEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function mindRender() {
  const box = $('#mindCanvas');
  if (!box) return;
  if (!mindData || !mindData.length) {
    box.innerHTML = '<div class="mindEmpty">世界树还是空的。去「世界」那边先建几条。</div>';
    return;
  }
  const L = mindLayout();
  const n = (L.nodes.length);
  const rootN = (mindKids().get('') || []).length;

  // 连线：父右中 → 子左中，三次贝塞尔，横着走
  const paths = L.edges.map(e => {
    const x1 = e.from.x + e.from.w, y1 = e.from.y + MIND.nodeH / 2;
    const x2 = e.to.x, y2 = e.to.y + MIND.nodeH / 2;
    const mx = (x1 + x2) / 2;
    return `<path class="mindEdge d${e.to.d}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`;
  }).join('');

  // 节点
  const nodes = L.nodes.map(o => {
    const cls = ['mindNode', 'd' + o.d];
    if (o.id === mindSel) cls.push('sel');
    if ((mindKids().get(o.id) || []).length) cls.push('hasKids');
    if (mindFolded.has(o.id)) cls.push('folded');
    const cy = o.y + MIND.nodeH / 2;
    // 字放不下才截，而且按真实字宽算——中文一个宽、英文和符号半个宽。
    // 原来一律按中文宽算，把中英混排、本来放得下的也误杀了。
    let label = o.t;
    const avail = o.w - MIND.padX * 2;
    const chars = [...label];
    let tw = 0;
    let cut = chars.length;
    for (let i = 0; i < chars.length; i++) {
      const cw = /[\x00-\xff]/.test(chars[i]) ? MIND.charW * 0.55 : MIND.charW;
      if (tw + cw > avail) { cut = Math.max(2, i); break; }
      tw += cw;
    }
    if (cut < chars.length) label = chars.slice(0, Math.max(1, cut - 1)).join('') + '…';
    return `<g class="${cls.join(' ')}" data-id="${mindEsc(o.id)}" transform="translate(${o.x} ${o.y})">
      <title>${mindEsc(o.t)}</title>
      <rect class="mindRect" width="${o.w}" height="${MIND.nodeH}" rx="7"/>
      <text class="mindLabel" x="${MIND.padX}" y="${MIND.nodeH / 2 + 4.5}">${mindEsc(label)}</text>
      ${(mindKids().get(o.id) || []).length ? `<circle class="mindDot" cx="${o.w - 9}" cy="${MIND.nodeH / 2}" r="2.6"/>` : ''}
    </g>`;
  }).join('');

  box.innerHTML = `<svg class="mindSvg" width="${Math.max(L.w, box.clientWidth)}" height="${Math.max(L.h, box.clientHeight)}">
    <g class="mindWorld" transform="translate(${mindView.x} ${mindView.y}) scale(${mindView.k})">
      <g class="mindEdges">${paths}</g>
      <g class="mindNodes">${nodes}</g>
    </g>
  </svg>`;

  const stat = $('#mindStat');
  if (stat) stat.textContent = `${n} 个词条 · ${rootN} 棵 · ${L.edges.length} 条连线`;
  mindBind();
}

function mindApply() {
  const g = document.querySelector('.mindWorld');
  if (g) g.setAttribute('transform', `translate(${mindView.x} ${mindView.y}) scale(${mindView.k})`);
}

/** 缩放到刚好装下 */
function mindFit() {
  const box = $('#mindCanvas');
  if (!box || !mindData || !mindData.length) return;
  const L = mindLayout();
  const bw = box.clientWidth, bh = box.clientHeight;
  const k = Math.min(1.15, Math.max(0.2, Math.min((bw - 20) / L.w, (bh - 20) / L.h)));
  mindView.k = k;
  mindView.x = (bw - L.w * k) / 2;
  mindView.y = (bh - L.h * k) / 2;
  mindApply();
}

function mindBind() {
  const box = $('#mindCanvas');
  if (!box) return;
  const svg = box.querySelector('.mindSvg');
  if (!svg) return;

  svg.querySelectorAll('.mindNode').forEach(g => {
    g.addEventListener('click', ev => {
      ev.stopPropagation();
      if (mindDrag && mindDrag.moved) return;
      const id = g.dataset.id;
      mindSel = id === mindSel ? '' : id;
      const has = (mindKids().get(id) || []).length > 0;
      if (has) {
        if (mindFolded.has(id)) mindFolded.delete(id);
        else mindFolded.add(id);
      }
      mindRender();
    });
    g.addEventListener('dblclick', ev => {
      ev.stopPropagation();
      const id = g.dataset.id;
      if (typeof openWorldNode === 'function') {
        // 双击跳去「世界」那边的词条详情
        document.querySelector('.railBtn[data-view="world"]').click();
        setTimeout(() => openWorldNode(id), 60);
      }
    });
  });

  // 拖动平移
  svg.addEventListener('pointerdown', ev => {
    if (ev.target.closest('.mindNode')) return;
    mindDrag = { sx: ev.clientX, sy: ev.clientY, ox: mindView.x, oy: mindView.y, moved: false };
    svg.setPointerCapture(ev.pointerId);
    svg.classList.add('grabbing');
  });
  svg.addEventListener('pointermove', ev => {
    if (!mindDrag) return;
    const dx = ev.clientX - mindDrag.sx, dy = ev.clientY - mindDrag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) mindDrag.moved = true;
    mindView.x = mindDrag.ox + dx;
    mindView.y = mindDrag.oy + dy;
    mindApply();
  });
  const endDrag = () => {
    if (!mindDrag) return;
    svg.classList.remove('grabbing');
    const moved = mindDrag.moved;
    mindDrag = null;
    // 松手后 100ms 内别让 click 再当成点节点
    if (moved) { setTimeout(() => { mindDrag = null; }, 30); }
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  // 滚轮缩放（以指针为中心）
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const old = mindView.k;
    const next = Math.min(2.2, Math.max(0.2, old * (ev.deltaY < 0 ? 1.12 : 0.89)));
    if (next === old) return;
    mindView.x = px - (px - mindView.x) * (next / old);
    mindView.y = py - (py - mindView.y) * (next / old);
    mindView.k = next;
    mindApply();
  }, { passive: false });
}

function mindExpandAll() {
  mindFolded.clear();
  mindRender();
}

/** 只留到某一层，再深就折起来 */
function mindCollapseAll() {
  mindFolded.clear();
  const kids = mindKids();
  // 每根只展开一层
  for (const r of kids.get('') || []) {
    for (const k of kids.get(r.id) || []) {
      if ((kids.get(k.id) || []).length) mindFolded.add(k.id);
    }
  }
  mindRender();
}

async function enterMindView() {
  $('#paneTitle').textContent = '思维';
  $('#viewEditor').hidden = true;
  $('#viewCards').hidden = true;
  $('#viewPlot').hidden = true;
  $('#viewWorld').hidden = true;
  $('#viewStats').hidden = true;
  $('#viewEmpty').hidden = true;
  $('#viewMind').hidden = false;
  // 导图要横向铺开，左侧那栏把图挤成一半，收起来
  document.body.classList.add('mindOn');

  const first = !mindData;
  try {
    const r = await api('/api/world');
    mindData = (r && r.items) || [];
    state.world = mindData;
  } catch (e) {
    mindData = [];
  }
  // 头一次进来只展开两三层：先看清主干，想看细的再点。
  // 手机屏幕窄，展开三层整棵就横出屏外了，所以窄屏只展开两层。
  if (first) mindFoldToDepth(window.innerWidth <= 900 ? 2 : 3);
  mindRender();
  // 手机上「适应窗口」会把整张图缩到 0.4 以下，字小得没法看。
  // 窄屏就别全塞进去了：先给一个能读的倍数、从主干起头，剩下的靠拖。
  requestAnimationFrame(() => {
    if (window.innerWidth <= 900) {
      mindView.k = 0.85;
      mindView.x = 16;
      mindView.y = 40;
      mindApply();
    } else {
      mindFit();
    }
  });
}

/** 只展开到 depth 层，再深的折起来 */
function mindFoldToDepth(depth) {
  mindFolded.clear();
  const kids = mindKids();
  (function walk(id, d) {
    for (const c of kids.get(id) || []) {
      if (d + 1 >= depth && (kids.get(c.id) || []).length) mindFolded.add(c.id);
      walk(c.id, d + 1);
    }
  })('', 0);
}

function bindMindView() {
  const box = $('#mindCanvas');
  if (!box) return;
  $('#mindFit') && ($('#mindFit').onclick = () => mindFit());
  $('#mindExpand') && ($('#mindExpand').onclick = () => { mindExpandAll(); });
  $('#mindCollapse') && ($('#mindCollapse').onclick = () => { mindCollapseAll(); });
  // 窗口变大变小，重新装一次
  let t = null;
  window.addEventListener('resize', () => {
    if (currentView !== 'mind') return;
    clearTimeout(t);
    t = setTimeout(() => { mindFit(); }, 180);
  });
}
