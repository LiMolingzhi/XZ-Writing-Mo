'use strict';
/* 茉 · 写作台 —— 公共底座 */

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

/** 全局状态。所有视图共享这一份，不各自缓存。 */
const state = {
  project: null,
  nodes: [],
  characters: [],
  plots: [],
  items: [],
  world: [],
  stats: null,
  view: 'tree',
  nodeId: null,
  cardId: null,
  plotId: null,
  worldId: null,
  dirty: false,
  saving: null,
  collapsed: new Set(),
  filter: '',
  impFilter: null // 角色列表按分量筛选；null = 全部
};

const CLIENT_ID = Math.random().toString(36).slice(2, 10);

function fmtNum(n) {
  n = Number(n) || 0;
  return n.toLocaleString('zh-CN');
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = x => String(x).padStart(2, '0');
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return p(d.getHours()) + ':' + p(d.getMinutes());
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
  return fmtTime(ts);
}

/** 字数：非空白字符，和服务器同一口径 */
function countChars(text) {
  let n = 0;
  for (const ch of String(text || '')) {
    if (!/\s/.test(ch)) n++;
  }
  return n;
}
function countAll(text) {
  return [...String(text || '')].length;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- toast

let toastTimer = null;
function toast(msg, kind) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, kind === 'error' ? 4200 : 2200);
}

// ---------------------------------------------------------------- 浮层

let _ovTimer = null;

function openOverlay(html, onMount) {
  const ov = $('#overlay');
  const card = $('#overlayCard');
  // 上一步还在播关闭动画时就又开了新的：把那个待执行的清理掐掉，
  // 否则 160ms 后会把刚写进来的内容一起清空。
  if (_ovTimer) {
    clearTimeout(_ovTimer);
    _ovTimer = null;
  }
  card.innerHTML = html;
  ov.hidden = false;
  // 不靠 requestAnimationFrame：后台标签页 / 被节流的 webview 里那一帧可能不来，
  // 弹窗就会一直停在透明状态，看着像"点了没反应"。强制读一次布局再切 .on。
  void ov.offsetWidth;
  ov.classList.add('on');
  if (onMount) onMount(card);
}
function closeOverlay() {
  const ov = $('#overlay');
  ov.classList.remove('on');
  if (_ovTimer) clearTimeout(_ovTimer);
  _ovTimer = setTimeout(() => {
    _ovTimer = null;
    // 这 160ms 里要是有新的弹窗顶上来，就别动它
    if (ov.classList.contains('on')) return;
    ov.hidden = true;
    $('#overlayCard').innerHTML = '';
  }, 160);
}
document.addEventListener('click', e => {
  if (e.target.id === 'overlay') closeOverlay();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('#overlay').hidden) closeOverlay();
  }
});

function confirmDialog(title, text, okLabel, danger) {
  return new Promise(resolve => {
    openOverlay(
      `<div class="modalTitle">${esc(title)}</div>
       <div class="modalText">${esc(text)}</div>
       <div class="modalBtns">
         <button class="mBtn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(okLabel || '确定')}</button>
         <button class="mBtn" data-act="cancel">取消</button>
       </div>`,
      card => {
        card.querySelector('[data-act="ok"]').onclick = () => {
          closeOverlay();
          resolve(true);
        };
        card.querySelector('[data-act="cancel"]').onclick = () => {
          closeOverlay();
          resolve(false);
        };
      }
    );
  });
}

function promptDialog(title, label, value) {
  return new Promise(resolve => {
    openOverlay(
      `<div class="modalTitle">${esc(title)}</div>
       <div class="modalText">${esc(label)}</div>
       <input class="mInput" id="mPromptInput" value="${esc(value || '')}">
       <div class="modalBtns">
         <button class="mBtn primary" data-act="ok">确定</button>
         <button class="mBtn" data-act="cancel">取消</button>
       </div>`,
      card => {
        const input = card.querySelector('#mPromptInput');
        setTimeout(() => {
          input.focus();
          input.select();
        }, 60);
        const ok = () => {
          const v = input.value;
          closeOverlay();
          resolve(v);
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

// ---------------------------------------------------------------- API

let unauthorizedHandler = null;

/* ---------------------------------------------------------------- 当前是哪本书
 * 存在 localStorage，key 是 mo:book。没存过就用服务端的默认书（mo）。
 * 每次请求都带上，服务端据此决定读哪个 data/books/<id>/ 目录。
 */
const BOOK_KEY = 'mo:book';
function currentBookId() {
  try {
    return localStorage.getItem(BOOK_KEY) || '';
  } catch (e) {
    return '';
  }
}
function setCurrentBookId(id) {
  try {
    if (id) localStorage.setItem(BOOK_KEY, id);
    else localStorage.removeItem(BOOK_KEY);
  } catch (e) {
    /* 隐私模式下写不了，那就用默认书 */
  }
}

async function api(path, opts) {
  const o = Object.assign({ method: 'GET', headers: {} }, opts || {});
  const bid = currentBookId();
  if (bid) o.headers['x-book'] = bid;
  if (o.body !== undefined && typeof o.body !== 'string') {
    o.body = JSON.stringify(o.body);
    o.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, o);
  if (res.status === 401) {
    if (unauthorizedHandler) unauthorizedHandler();
    throw new Error('未登录');
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || '请求失败');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- 数据加载

async function loadProject() {
  state.project = await api('/api/project');
  const t = $('#projTitle');
  if (t) t.textContent = state.project.title || '未命名作品';
  document.title = (state.project.title || '茉 · 写作台') + ' · 写作台';
}

async function loadNodes() {
  const r = await api('/api/nodes');
  state.nodes = r.nodes || [];
}

async function loadCards(kind) {
  const r = await api('/api/cards/' + kind);
  const list = r.items || [];
  if (kind === 'characters') state.characters = list;
  else if (kind === 'plots') state.plots = list;
  else state.items = list;
  return list;
}

async function loadWorld() {
  const r = await api('/api/world');
  state.world = r.items || [];
}

async function loadStats() {
  state.stats = await api('/api/stats');
}

// ---------------------------------------------------------------- 树工具

function childrenOf(parentId) {
  return state.nodes
    .filter(n => (n.parentId || null) === (parentId || null))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function nodeById(id) {
  return state.nodes.find(n => n.id === id) || null;
}

function parentOf(node) {
  return node ? nodeById(node.parentId) : null;
}

/** 从根到该节点的路径（不含自身） */
function pathOf(id) {
  const out = [];
  let cur = nodeById(id);
  let guard = 0;
  while (cur && cur.parentId && guard++ < 40) {
    const p = nodeById(cur.parentId);
    if (!p) break;
    out.unshift(p);
    cur = p;
  }
  return out;
}

/** 全树按显示顺序的第一个可写章节（深度优先，顺着 order 走） */
function firstWritable() {
  const walk = parentId => {
    for (const n of childrenOf(parentId)) {
      if (n.type === 'text') return n;
      const found = walk(n.id);
      if (found) return found;
    }
    return null;
  };
  return walk(null);
}

/** 全树按显示顺序的子项（含分组），深度优先 */
function visibleNodes() {
  const out = [];
  const walk = (parentId, depth) => {
    for (const n of childrenOf(parentId)) {
      out.push({ node: n, depth });
      if (state.collapsed.has(n.id)) continue;
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function subtreeIds(id) {
  const out = [id];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of state.nodes) {
      if (n.parentId === cur) {
        out.push(n.id);
        stack.push(n.id);
      }
    }
  }
  return out;
}

/** 深度优先展开顺序，展开状态要考虑 collapsed */
function flattenTree(parentId, depth, out) {
  for (const n of childrenOf(parentId)) {
    out.push({ node: n, depth });
    // 章节下面也可以再挂东西（把一章拖进另一章），所以不再限定 folder
    if (!state.collapsed.has(n.id)) {
      const kids = state.nodes.some(x => x.parentId === n.id);
      if (kids) flattenTree(n.id, depth + 1, out);
    }
  }
  return out;
}

function totalWords() {
  return state.nodes.filter(n => n.type === 'text').reduce((s, n) => s + (n.chars || 0), 0);
}

// ---------------------------------------------------------------- SSE

let sse = null;
let sseRetry = 0;

function connectSSE() {
  if (sse) {
    try {
      sse.close();
    } catch (e) {
      /* ignore */
    }
  }
  sse = new EventSource('/api/events');
  sse.onopen = () => {
    sseRetry = 0;
    const el = $('#statSync');
    if (el) el.textContent = '已连接';
  };
  sse.onmessage = ev => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    handleServerEvent(msg);
  };
  sse.onerror = () => {
    const el = $('#statSync');
    if (el) el.textContent = '连接中断，重试中';
    try {
      sse.close();
    } catch (e) {
      /* ignore */
    }
    sseRetry = Math.min(sseRetry + 1, 6);
    setTimeout(connectSSE, 800 * sseRetry);
  };
}

function handleServerEvent(msg) {
  if (typeof onServerEvent === 'function') {
    try {
      onServerEvent(msg);
    } catch (e) {
      console.error(e);
    }
  }
}

// ---------------------------------------------------------------- 别的设备改过

/**
 * 同一条正文在另一台设备上被改过。
 * 如果本地没有未保存的改动，就直接换成服务器版本；
 * 如果本地也有改动，交给调用方决定，绝不静默覆盖。
 */
function applyRemoteText(remote) {
  const ed = $('#editor');
  if (!ed || !state.nodeId) return;
  if (state.nodeId !== remote.id) {
    // 不是我正在写的这一章：只更新侧栏字数
    const n = nodeById(remote.id);
    if (n && remote.meta) {
      n.chars = remote.meta.chars;
      n.updatedAt = remote.meta.updatedAt;
      if (typeof renderList === 'function') renderList();
    }
    return;
  }
  if (state.dirty) {
    toast('这一章在别的设备上被改过，你这里也有没上传的改动', 'error');
    return;
  }
  if (ed.value !== remote.meta.__content) {
    // meta 里不带正文，这里只在字数差异明显时重拉
  }
}

// ---------------------------------------------------------------- 网络与页面状态

window.addEventListener('online', () => {
  const el = $('#statSync');
  if (el) el.textContent = '已重连';
  if (typeof flushSave === 'function') flushSave(true);
  connectSSE();
});

window.addEventListener('offline', () => {
  const el = $('#statSync');
  if (el) el.textContent = '离线，内容留在本机';
});

// ── 列表折叠/展开的平滑过渡（FLIP）──────────────────────────────
// 树是拍平成一串 .row 再画出来的，没有包裹层的容器；折叠时子行直接从 DOM 里消失，
// 下面的行会瞬移一大截。所以先记住每行的旧位置，重画后让它从旧位置滑回来。
function listFlip(renderFn) {
  const body = document.getElementById('listBody');
  if (!body) { renderFn(); return; }
  // 大纲的行挂 data-id，世界树的行挂 data-wid，两个都认
  const keyOf = r => r.dataset.id || r.dataset.wid || '';

  const before = new Map();
  for (const r of body.querySelectorAll('.row')) {
    const k = keyOf(r); if (k) before.set(k, r.getBoundingClientRect().top);
  }

  renderFn();

  // 新长出来的行：淡入，别硬生生蹦出来
  let hasNew = false;
  const fresh = [];
  for (const r of body.querySelectorAll('.row')) {
    const k = keyOf(r); if (k && !before.has(k)) { fresh.push(r); hasNew = true; }
  }

  // 老行：按位移反向补偿
  let hasMove = false;
  for (const r of body.querySelectorAll('.row')) {
    const id = keyOf(r);
    if (!id || !before.has(id)) continue;
    const dy = before.get(id) - r.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    r.style.transition = 'none';
    r.style.transform = 'translateY(' + dy + 'px)';
    hasMove = true;
  }

  if (hasNew) {
    for (const r of fresh) {
      r.style.transition = 'none';
      r.style.opacity = '0';
      r.style.transform = 'translateY(-6px)';
    }
  }
  if (!hasMove && !hasNew) return;

  // 强制重排一次，让上面那些"起点"先真正落到布局里，再改回去才会走过渡
  void body.offsetHeight;

  for (const r of body.querySelectorAll('.row')) {
    const animated = r.style.transform || r.style.opacity === '0';
    if (!animated) continue;
    r.style.transition = 'transform .24s cubic-bezier(.22,.7,.3,1), opacity .2s ease';
    r.style.transform = '';
    r.style.opacity = '';
  }

  // 过渡结束后把这些行内样式清掉，免得影响后续 hover / 拖拽定位
  clearTimeout(listFlip._t);
  listFlip._t = setTimeout(() => {
    for (const r of body.querySelectorAll('.row')) {
      if (r.style.transition) {
        r.style.transition = '';
        r.style.transform = '';
        r.style.opacity = '';
      }
    }
  }, 320);
}
