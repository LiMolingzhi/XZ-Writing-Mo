'use strict';
/**
 * 书架
 *
 * 一个人可以同时写好几本书。这里把 data/books/ 下的每一本摊开，
 * 点哪本进哪本——切书就是换一个 book id，然后整页重载，
 * 因为大纲/角色/情节/统计全都要换成另一本书的，重载最干净。
 */

let shelfBooks = [];
let shelfCurrent = '';
let shelfBusy = false;

function shelfEl() {
  return $('#shelf');
}

function shelfOpen() {
  const el = shelfEl();
  if (!el) return;
  el.hidden = false;
  // 不用 requestAnimationFrame：某些环境下（后台标签页、被节流的 iframe）
  // 那一帧可能压根不来，书架就一直停在 opacity:0，看着像"点了没反应"。
  // 强制读一次布局让 opacity:0 先落地，再切 .on，过渡照样播。
  void el.offsetWidth;
  el.classList.add('on');
  shelfLoad();
}

function shelfClose() {
  const el = shelfEl();
  if (!el) return;
  el.classList.remove('on');
  setTimeout(() => {
    el.hidden = true;
  }, 200);
}

async function shelfLoad() {
  const box = $('#shelfList');
  if (!box) return;
  box.innerHTML = '<div class="shelfTip">正在翻书……</div>';
  try {
    const r = await api('/api/books');
    shelfBooks = r.books || [];
    shelfCurrent = r.current || '';
    renderShelf();
  } catch (e) {
    box.innerHTML = '<div class="shelfTip">书架没打开：' + esc(e.message) + '</div>';
  }
}

/** 封面底色：拿 id 算一个稳定的色相，每本书有自己的颜色，但刷新不会变 */
function coverHue(id) {
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function fmtAgo(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60 * 1000) return '刚动过';
  if (d < 60 * 60 * 1000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 24 * 60 * 60 * 1000) return Math.floor(d / 3600000) + ' 小时前';
  const days = Math.floor(d / 86400000);
  if (days < 30) return days + ' 天前';
  return Math.floor(days / 30) + ' 个月前';
}

function fmtNum(n) {
  if (!n) return '0';
  if (n < 10000) return String(n);
  return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
}

function renderShelf() {
  const box = $('#shelfList');
  if (!box) return;
  if (!shelfBooks.length) {
    box.innerHTML = '<div class="shelfTip">还没有书。下面新建一本。</div>';
    return;
  }
  box.innerHTML = shelfBooks
    .map(b => {
      const now = b.id === shelfCurrent;
      const first = (b.title || '书').trim().slice(0, 1);
      const bits = [b.series, b.chapters + ' 章', fmtNum(b.chars) + ' 字', fmtAgo(b.mtime)]
        .filter(Boolean)
        .join(' · ');
      return `<div class="bookCard${now ? ' now' : ''}" data-id="${esc(b.id)}" title="双击打开《${esc(b.title)}》">
        <div class="bookCover${b.cover ? ' has-img' : ''}" style="--h:${coverHue(b.id)}">${
          b.cover
            ? `<img class="coverImg" src="/api/books/${encodeURIComponent(b.id)}/cover?v=${b.coverV || 0}" alt="">`
            : esc(first)
        }</div>
        <div class="bookInfo">
          <div class="bookTitle">${esc(b.title)}</div>
          <div class="bookMeta">${esc(bits)}</div>
        </div>
        ${now ? '<div class="bookNow">创作中</div>' : ''}
        <div class="bookOps">
          <button class="bookOp moveOp" data-act="up" title="往上挪一位">↑ 上移</button>
          <button class="bookOp moveOp" data-act="down" title="往下挪一位">↓ 下移</button>
          <button class="bookOp" data-act="cover" title="用一张图当封面">${b.cover ? '换封面' : '加封面'}</button>
          ${b.cover ? '<button class="bookOp" data-act="nocover" title="换回默认的色块封面">去封面</button>' : ''}
          <button class="bookOp" data-act="rename" title="改名">改名</button>
          <button class="bookOp del" data-act="del" title="删掉这本书">删除</button>
        </div>
      </div>`;
    })
    .join('');
}

/** 切到某一本：记住它，然后整页重载，所有视图一起换掉 */
function switchBook(id) {
  if (!id || id === shelfCurrent) {
    shelfClose();
    return;
  }
  setCurrentBookId(id);
  const box = $('#shelfList');
  if (box) box.innerHTML = '<div class="shelfTip">正在换书……</div>';
  location.reload();
}

async function shelfNewBook() {
  if (shelfBusy) return;
  const title = await promptDialog('新建一本书', '书名（之后随时能改）', '');
  if (title === null) return;
  const name = String(title).trim();
  if (!name) {
    toast('书名不能是空的', 'error');
    return;
  }
  shelfBusy = true;
  try {
    const r = await api('/api/books', { method: 'POST', body: { title: name } });
    setCurrentBookId(r.id);
    const box = $('#shelfList');
    if (box) box.innerHTML = '<div class="shelfTip">正在打开新书……</div>';
    location.reload();
  } catch (e) {
    toast('建不上：' + e.message, 'error');
    shelfBusy = false;
  }
}

async function shelfRename(id, oldTitle) {
  if (shelfBusy) return;
  const title = await promptDialog('改书名', '新的名字', oldTitle || '');
  if (title === null) return;
  const name = String(title).trim();
  if (!name) {
    toast('书名不能是空的', 'error');
    return;
  }
  if (name === oldTitle) return;
  shelfBusy = true;
  try {
    await api('/api/books/' + encodeURIComponent(id), { method: 'PATCH', body: { title: name } });
    // 改的是正在写的这本，写作台顶部的书名也得跟着变
    if (id === shelfCurrent && typeof state !== 'undefined' && state.project) {
      state.project.title = name;
      const t = $('#paneTitle');
      const f = $('.brandTitle');
      if (f) f.textContent = name;
    }
    await shelfLoad();
    toast('改好了');
  } catch (e) {
    toast('改不了：' + e.message, 'error');
  } finally {
    shelfBusy = false;
  }
}

async function shelfDelete(id, title) {
  if (shelfBusy) return;
  const ok = await confirmDialog(
    '把《' + (title || '这本') + '》从书架上拿掉？',
    '不会真的粉碎：整本书会挪进 data/books-trash 里，后悔了还能手工捞回来。',
    '拿掉',
    true
  );
  if (!ok) return;
  shelfBusy = true;
  try {
    await api('/api/books/' + encodeURIComponent(id), { method: 'DELETE' });
    if (id === shelfCurrent) {
      // 正在写的这本被拿掉了：换到书架上剩下的第一本
      const rest = shelfBooks.filter(b => b.id !== id);
      if (rest.length) {
        setCurrentBookId(rest[0].id);
        location.reload();
        return;
      }
      setCurrentBookId('');
      location.reload();
      return;
    }
    await shelfLoad();
    toast('拿掉了');
  } catch (e) {
    toast('拿不掉：' + e.message, 'error');
  } finally {
    shelfBusy = false;
  }
}

/* 封面：选一张图 -> 读成 dataURL -> 交给服务端存成 cover.xxx。
   不压缩不裁切，用户给什么就存什么，显示时靠 CSS 铺满。 */
function shelfPickCover(id) {
  let inp = $('#shelfCoverInput');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/jpeg,image/png,image/webp,image/gif';
    inp.id = 'shelfCoverInput';
    inp.style.display = 'none';
    document.body.appendChild(inp);
  }
  inp.value = '';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(f.type)) {
      toast('只认 jpg / png / webp / gif', 'error');
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      toast('这张图 ' + (f.size / 1024 / 1024).toFixed(1) + 'MB，换张 5MB 以内的', 'error');
      return;
    }
    toast('正在换封面…');
    const rd = new FileReader();
    rd.onload = async () => {
      try {
        await api('/api/books/' + encodeURIComponent(id) + '/cover', {
          method: 'POST',
          body: { data: rd.result }
        });
        toast('封面换好了');
        await shelfLoad();
      } catch (e) {
        toast('换封面失败：' + e.message, 'error');
      }
    };
    rd.onerror = () => toast('这张图读不出来', 'error');
    rd.readAsDataURL(f);
  };
  inp.click();
}

async function shelfClearCover(id) {
  try {
    await api('/api/books/' + encodeURIComponent(id) + '/cover', { method: 'DELETE' });
    toast('换回默认封面了');
    await shelfLoad();
  } catch (e) {
    toast('去封面失败：' + e.message, 'error');
  }
}

/* ---------------- 拖拽排序 ----------------
   用 pointer 事件，不用 HTML5 drag：
   桌面鼠标和手机手指走同一套逻辑，也省掉拖拽光影那一堆默认行为。
   点一下就松手 = 打开这本书；按住挪超过 8px 才算拖。 */
let dragSt = null;
let suppressClick = false;

function shelfListEl() {
  return $('#shelfList');
}

function dndClearMarks() {
  document.querySelectorAll('.bookCard.dropTarget').forEach(c => {
    c.classList.remove('dropTarget', 'below');
  });
}

function onDragDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  // 手指在卡片上按一下就想上下滑，浏览器会把这次手势判给「滚动列表」，
  // 拖拽在真机上根本收不到事件。所以触屏一律走长按出「↑↓」按钮那条路。
  if (e.pointerType === 'touch' || e.pointerType === 'pen') return;
  const card = e.target.closest('.bookCard');
  if (!card) return;
  if (e.target.closest('[data-act]')) return;  // 卡片上的按钮不参与拖拽

  dragSt = {
    id: card.dataset.id,
    el: card,
    x0: e.clientX,
    y0: e.clientY,
    active: false,
    armed: true,
    touch: false,
    timer: null,
    target: null,
    below: false
  };
}

function onDragMove(e) {
  const st = dragSt;
  if (!st) return;
  // 拖到窗口外再松手时 pointerup 会丢，这里靠「按键已松开」兜底收尾
  if (st.active && e.buttons === 0) {
    onDragUp();
    return;
  }
  if (!st.armed) {
    // 还在等长按：手指已经划出去一段了，说明他想滚列表，别抢
    if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) > 10) {
      if (st.timer) clearTimeout(st.timer);
      dragSt = null;
    }
    return;
  }
  if (!st.active) {
    if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 8) return;
    st.active = true;
    st.el.classList.add('dragging');
    const box = shelfListEl();
    if (box) box.classList.add('sorting');
  }
  e.preventDefault();

  const cards = [...document.querySelectorAll('.bookCard')].filter(c => c !== st.el);
  let hit = null;
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (e.clientY >= r.top && e.clientY <= r.bottom) {
      hit = c;
      break;
    }
  }
  dndClearMarks();
  if (hit) {
    const r = hit.getBoundingClientRect();
    st.below = e.clientY > r.top + r.height / 2;  // 落在下半张 = 插到它后面
    hit.classList.add('dropTarget');
    if (st.below) hit.classList.add('below');
    st.target = hit;
  } else {
    st.target = null;
  }
}

async function onDragUp() {
  const st = dragSt;
  dragSt = null;
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  st.el.style.touchAction = '';
  dndClearMarks();
  const box = shelfListEl();
  if (box) box.classList.remove('sorting');
  st.el.classList.remove('dragging');
  if (!st.active) {
    // 长按进去又原地松手：别让这一下被当成「点开这本书」
    if (st.touch && st.armed) {
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      }, 350);
    }
    return;
  }

  suppressClick = true;  // 拖完那一下的 click 不要当成「打开这本书」
  setTimeout(() => {
    suppressClick = false;
  }, 350);
  if (!st.target) return;

  const from = shelfBooks.findIndex(b => b.id === st.id);
  if (from < 0) return;
  const moved = shelfBooks.splice(from, 1)[0];
  let to = shelfBooks.findIndex(b => b.id === st.target.dataset.id);
  if (to < 0) {
    shelfBooks.splice(from, 0, moved);
    return;
  }
  if (st.below) to += 1;
  if (to === from) {
    shelfBooks.splice(from, 0, moved);
    return;
  }
  shelfBooks.splice(to, 0, moved);

  renderShelf();
  try {
    await api('/api/books/order', {
      method: 'POST',
      body: { order: shelfBooks.map(b => b.id) }
    });
  } catch (err) {
    toast('顺序没存上：' + err.message, 'error');
  }
}

function bindShelfDrag() {
  const list = $('#shelfList');
  if (!list || list.dataset.dndBound) return;  // 只绑一次
  list.dataset.dndBound = '1';
  list.addEventListener('pointerdown', onDragDown);
  document.addEventListener('pointermove', onDragMove, { passive: false });
  document.addEventListener('pointerup', onDragUp);
  document.addEventListener('pointercancel', onDragUp);
}

/** 手机上的排序：长按书卡 → 只留「↑ 上移 / ↓ 下移」两个大按钮，点一下挪一位。
 *  比拖拽可靠得多——手指按在卡片上想上下滑时，浏览器会把手势判给「滚动列表」，
 *  根本轮不到我们。 */
function enterMoveMode(card) {
  document.querySelectorAll('.bookCard.moveMode').forEach(c => c.classList.remove('moveMode'));
  if (card) card.classList.add('moveMode');
}

function exitMoveMode() {
  document.querySelectorAll('.bookCard.moveMode').forEach(c => c.classList.remove('moveMode'));
}

async function moveBookBy(id, dir) {
  const i = shelfBooks.findIndex(b => b.id === id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= shelfBooks.length) return;
  const moved = shelfBooks.splice(i, 1)[0];
  shelfBooks.splice(j, 0, moved);
  renderShelf();
  // 重建 DOM 之后把「可移动」状态接着给挪过的那张卡，方便连着挪几下
  const card = document.querySelector('.bookCard[data-id="' + id + '"]');
  if (card) card.classList.add('moveMode');
  try {
    await api('/api/books/order', {
      method: 'POST',
      body: { order: shelfBooks.map(b => b.id) }
    });
  } catch (err) {
    toast('顺序没存上：' + err.message, 'error');
  }
}

function bindShelfLongPress() {
  const list = $('#shelfList');
  if (!list || list.dataset.lpBound) return;  // 只绑一次
  list.dataset.lpBound = '1';

  let timer = null;
  let card = null;
  let sx = 0;
  let sy = 0;
  let moved = false;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  list.addEventListener(
    'touchstart',
    e => {
      if (e.touches.length !== 1) return;
      const c = e.target.closest('.bookCard');
      if (!c) return;
      if (e.target.closest('[data-act]')) return;  // 按钮上长按不算
      card = c;
      moved = false;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      clear();
      timer = setTimeout(() => {
        timer = null;
        if (moved || !card) return;
        enterMoveMode(card);
        suppressClick = true;
        setTimeout(() => {
          suppressClick = false;
        }, 700);
        try {
          if (navigator.vibrate) navigator.vibrate(18);
        } catch (err) {}
      }, 1200);
    },
    { passive: true }
  );

  list.addEventListener(
    'touchmove',
    e => {
      if (!timer) return;
      const t = e.touches[0];
      if (!t) return;
      if (Math.hypot(t.clientX - sx, t.clientY - sy) > 12) {
        moved = true;  // 想滚列表，别抢
        clear();
      }
    },
    { passive: true }
  );

  list.addEventListener('touchend', clear);
  list.addEventListener('touchcancel', clear);

  // 点到别处就收起那两个按钮
  document.addEventListener('click', e => {
    if (e.target.closest('.bookCard.moveMode')) return;
    exitMoveMode();
  });
}

function bindShelf() {
  const brand = $('#btnShelf');
  if (brand) {
    brand.onclick = () => shelfOpen();
    brand.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        shelfOpen();
      }
    };
  }

  const close = $('#shelfClose');
  if (close) close.onclick = () => shelfClose();

  const nw = $('#shelfNew');
  if (nw) nw.onclick = () => shelfNewBook();

  const list = $('#shelfList');
  if (list) {
    list.onclick = e => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const op = e.target.closest('[data-act]');
      const card = e.target.closest('.bookCard');
      if (!card) return;
      const id = card.dataset.id;
      const book = shelfBooks.find(b => b.id === id);
      if (!book) return;

      if (op) {
        e.stopPropagation();
        const a = op.dataset.act;
        if (a === 'up') moveBookBy(id, -1);
        else if (a === 'down') moveBookBy(id, 1);
        else if (a === 'rename') shelfRename(id, book.title);
        else if (a === 'del') shelfDelete(id, book.title);
        else if (a === 'cover') shelfPickCover(id);
        else if (a === 'nocover') shelfClearCover(id);
        return;
      }
      // 单击弹详情，双击才进书；两者靠一个 260ms 的定时器分开
      if (cardClickTimer) clearTimeout(cardClickTimer);
      cardClickTimer = setTimeout(() => {
        cardClickTimer = null;
        openBookDetail(id);
      }, 260);
    };

    list.ondblclick = e => {
      if (cardClickTimer) {
        clearTimeout(cardClickTimer);
        cardClickTimer = null;
      }
      if (suppressClick) return;
      if (e.target.closest('[data-act]')) return;
      const card = e.target.closest('.bookCard');
      if (!card) return;
      switchBook(card.dataset.id);
    };
  }

  bindShelfDrag();
  bindShelfLongPress();
  bindBookDetail();

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const el = shelfEl();
    if (el && !el.hidden) {
      e.preventDefault();
      shelfClose();
    }
  });
}


/* ---------------- 书籍详情面板 ----------------
   桌面从右边滑进来，手机从底下顶上来（同一份 DOM，靠 CSS 媒体查询换方向）。 */
let cardClickTimer = null;
let bdCur = '';

function bdEl() {
  return $('#bookDetail');
}

function bdScrimEl() {
  return $('#bdScrim');
}

function openBookDetail(id) {
  const b = shelfBooks.find(x => x.id === id);
  const el = bdEl();
  if (!b || !el) return;
  bdCur = b.id;

  $('#bdTitle').textContent = b.title || '未命名作品';
  const meta = [
    b.series,
    b.chapters ? b.chapters + ' 章' : '',
    b.chars ? fmtNum(b.chars) + ' 字' : '',
    b.mtime ? fmtAgo(b.mtime) : ''
  ].filter(Boolean).join(' · ');
  $('#bdMeta').textContent = meta || '还是一张白纸';

  const cov = $('#bdCover');
  if (b.cover) {
    cov.textContent = '';
    cov.innerHTML = '<img src="/api/books/' + encodeURIComponent(b.id) +
      '/cover?v=' + (b.coverV || 0) + '" alt="">';
  } else {
    cov.innerHTML = '';
    cov.textContent = (b.title || '书').trim().charAt(0) || '书';
    cov.style.setProperty('--h', coverHue(b.id));
  }

  $('#bdName').value = b.title || '';
  $('#bdSeries').value = b.series || '';
  $('#bdAuthor').value = b.author || '';
  $('#bdEmail').value = b.email || '';
  $('#bdLicense').value = b.license || '';

  const lines = [];
  lines.push('共 ' + (b.chapters || 0) + ' 章 · ' + fmtNum(b.chars || 0) + ' 字');
  if (b.mtime) lines.push('最后一次动笔：' + fmtAgo(b.mtime));
  lines.push('存放位置：data/books/' + b.id);
  $('#bdStats').textContent = lines.join('\n');
  $('#bdStats').style.whiteSpace = 'pre-line';

  el.hidden = false;
  const scrim = bdScrimEl();
  if (scrim) scrim.hidden = false;
  void el.offsetWidth;   // 同上：不靠 rAF，免得那一帧不来就停在透明
  el.classList.add('on');
  if (scrim) scrim.classList.add('on');

  const nm = $('#bdName');
  if (nm) setTimeout(() => { nm.focus(); nm.select(); }, 250);
}

function closeBookDetail() {
  const el = bdEl();
  const scrim = bdScrimEl();
  if (!el || el.hidden) return;
  el.classList.remove('on');
  if (scrim) scrim.classList.remove('on');
  setTimeout(() => {
    if (el.classList.contains('on')) return;  // 中途又打开了就别藏
    el.hidden = true;
    if (scrim) scrim.hidden = true;
  }, 240);
  bdCur = '';
}

async function saveBookDetail() {
  const id = bdCur;
  if (!id) return;
  const body = {
    series: $('#bdSeries').value,
    author: $('#bdAuthor').value,
    email: $('#bdEmail').value,
    license: $('#bdLicense').value
  };
  const name = $('#bdName').value.trim();
  if (name) body.title = name;
  try {
    await api('/api/books/' + encodeURIComponent(id), { method: 'PATCH', body });
    const b = shelfBooks.find(x => x.id === id);
    if (b) {
      b.series = body.series;
      b.author = body.author;
      b.email = body.email;
      b.license = body.license;
      if (body.title) b.title = body.title;
    }
    $('#bdTitle').textContent = name || $('#bdTitle').textContent;
    renderShelf();
    toast('记下了');
  } catch (e) {
    toast('没存上：' + e.message, 'error');
  }
}

function bindBookDetail() {
  const el = bdEl();
  if (!el || el.dataset.bdBound) return;
  el.dataset.bdBound = '1';

  const close = $('#bdClose');
  if (close) close.onclick = closeBookDetail;
  const done = $('#bdDone');
  if (done) done.onclick = closeBookDetail;

  const scrim = bdScrimEl();
  if (scrim) scrim.onclick = closeBookDetail;

  const open = $('#bdOpen');
  if (open) {
    open.onclick = () => {
      const id = bdCur;
      if (!id) return;
      closeBookDetail();
      switchBook(id);
    };
  }

  ['bdName', 'bdSeries', 'bdAuthor', 'bdEmail', 'bdLicense'].forEach(fid => {
    const input = document.getElementById(fid);
    if (!input) return;
    input.addEventListener('change', saveBookDetail);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        input.blur();
      }
    });
  });
}
