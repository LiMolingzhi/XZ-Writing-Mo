'use strict';
/* 正文：按卷分组列章节。和「大纲」共用同一个编辑器，区别只在左边这一栏怎么排。
   大纲看的是结构（谁挂在谁下面、哪一段有细纲），正文看的是「写到第几章了」。

   只有 inText === true 的章节才会出现在这里。
   所以大纲里那棵树原封不动，正文可以从空白开始——想从大纲移过来，
   在行菜单里点「放进正文」。 */

const textFolded = new Set();

// 刚被展开的那一卷：渲染完给它挂一个「正从 0 高度推开」的类，CSS 负责动画
let textJustOpened = '';

// 当前「按住」的是哪一卷：点卷头就选中它、展开它、把别的卷收起来。
// 点「+」建的章节落在这一卷里，不用再靠「当前打开的章节在哪」去猜。
let textVolSel = '';

// 一卷里每多少章打一个小折叠
const TEXT_GROUP = 20;

function textKids() {
  const kids = new Map();
  for (const n of state.nodes) {
    const p = n.parentId || '';
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(n);
  }
  for (const arr of kids.values()) arr.sort((a, b) => a.order - b.order);
  return kids;
}

/* 一卷下面的所有「能写的叶子」——自己下面还有东西的不算，那是分组。
   只要 inText 的：大纲里那些规划节点不该在这里出现。 */
function leavesUnder(id, kids, out) {
  for (const k of kids.get(id) || []) {
    if (kids.has(k.id)) leavesUnder(k.id, kids, out);
    else if (k.type === 'text' && k.inText) out.push(k);
  }
  return out;
}

/* 某个节点属于哪一卷（往上找到顶层 folder）。找不到就退到第一卷。 */
function textVolOf(nodeId) {
  let cur = state.nodes.find(n => n.id === nodeId);
  while (cur) {
    if (!cur.parentId) return cur.type === 'folder' ? cur.id : null;
    cur = state.nodes.find(n => n.id === cur.parentId);
  }
  const first = state.nodes.filter(n => !n.parentId && n.type === 'folder')[0];
  return first ? first.id : null;
}

function renderTextRow(c) {
  const active = c.id === state.nodeId ? ' active' : '';
  const statusDot = c.status > 0
    ? `<span class="sdot s${c.status}" title="${esc((state.project.statuses || [])[c.status] || '')}"></span>`
    : '';
  const nPlots = (state.plots || []).filter(p => p.nodeId === c.id).length;
  const plotTag = nPlots ? `<span class="plotTag" title="${nPlots} 个情节挂在这一章">${nPlots}</span>` : '';
  return `<div class="row leaf${active}" data-id="${c.id}">
            <span class="rowTitle">${esc(c.title || '未命名')}</span>
            ${plotTag}
            ${statusDot}
            <span class="rowMeta">${c.chars ? fmtNum(c.chars) : ''}</span>
            <button class="rowMore" data-more="${c.id}" title="更多">⋯</button>
          </div>`;
}

function renderTextList() {
  const body = $('#listBody');
  if (!body) return;
  const kids = textKids();
  const kw = state.filter.trim().toLowerCase();
  const vols = (kids.get('') || []).filter(n => n.type === 'folder');

  const chunks = [];
  for (const vol of vols) {
    const chs = leavesUnder(vol.id, kids, []);
    const hit = kw ? chs.filter(c => (c.title || '').toLowerCase().includes(kw)) : chs;
    if (kw && !hit.length && !(vol.title || '').toLowerCase().includes(kw)) continue;

    const folded = textFolded.has(vol.id);
    const volWords = chs.reduce((s, c) => s + (c.chars || 0), 0);
    const shown = kw ? hit : chs;

    chunks.push(
      `<div class="textVol${folded ? ' folded' : ''}${vol.id === textVolSel ? ' sel' : ''}" data-vol="${vol.id}">
         <span class="caret ${folded ? 'folded' : ''}" data-vcaret="${vol.id}">▾</span>
         <span class="volTitle">${esc(vol.title || '未命名卷')}</span>
         <span class="volMeta">${shown.length} 章 · ${fmtNum(volWords)} 字</span>
         <button class="rowMore" data-more="${vol.id}" title="更多">⋯</button>
       </div>`
    );

    if (folded) continue;

    const inner = [];
    if (!shown.length) {
      inner.push('<div class="textVolEmpty">这一卷还没有章节。点右上角「＋」新建。</div>');
    } else {
      // 每 20 章打一个小折叠；不够 20 章就不打组头，省得啰嗦。
      // 最后一组如果只剩孤零零一两章，也不给它套个「第 21–21 章」的壳。
      const withGroups = shown.length > TEXT_GROUP;
      for (let i = 0; i < shown.length; i += TEXT_GROUP) {
        const slice = shown.slice(i, i + TEXT_GROUP);
        if (withGroups && slice.length > 1) {
          const gid = vol.id + '#' + i;
          const gfold = textFolded.has(gid);
          inner.push(
            `<div class="textGroup" data-grp="${gid}">
               <span class="caret small ${gfold ? 'folded' : ''}">▾</span>
               <span class="grpTitle">第 ${i + 1}–${i + slice.length} 章</span>
               <span class="grpMeta">${slice.reduce((s, c) => s + (c.chars || 0), 0).toLocaleString('en-US')} 字</span>
             </div>`
          );
          if (gfold) continue;
        }
        for (const c of slice) inner.push(renderTextRow(c));
      }
    }
    // 包一层：收起时靠 grid-template-rows 做高度过渡，不是硬跳
    chunks.push(`<div class="volBody" data-body="${vol.id}"><div>${inner.join('')}</div></div>`);
  }

  body.innerHTML = chunks.join('') ||
    '<div class="listEmpty">正文还是空的。<br><br>大纲里那棵树原样没动，只是没搬过来。<br>想开写：点右上角「＋」新建一章；<br>想把大纲里已经写的章节挪进来：行菜单里点「放进正文」。</div>';
  const w = $('#projWords');
  if (w) w.textContent = fmtNum(totalWords()) + ' 字';

  // 刚展开的那一卷：先压成 0 高度，再放开，让它自己推开
  if (textJustOpened) {
    const b = body.querySelector('.volBody[data-body="' + textJustOpened + '"]');
    if (b) {
      b.classList.add('opening');
      void b.offsetHeight; // 强制重排：让 0 高度先落地，否则过渡不会触发
      b.classList.remove('opening');
    }
    textJustOpened = '';
  }
}

function bindTextView() {
  const body = $('#listBody');
  if (!body || body.dataset.textBound === '1') return;
  body.dataset.textBound = '1';
  body.addEventListener('click', e => {
    // 20 章一组的小折叠
    const grp = e.target.closest('.textGroup');
    if (grp) {
      const gid = grp.dataset.grp;
      if (textFolded.has(gid)) textFolded.delete(gid);
      else textFolded.add(gid);
      renderTextList();
      return;
    }
    // 行菜单按钮（章节和卷头都有）要先接，否则会被下面的「点卷头 = 点亮」吞掉
    const more = e.target.closest('[data-more]');
    if (more) {
      e.stopPropagation();
      openRowMenu(more.dataset.more, more);
      return;
    }
    // 点卷头 = 选中这一卷；已经选中的再点一下 = 收起来
    const vh = e.target.closest('.textVol');
    if (vh) {
      const id = vh.dataset.vol;
      if (e.target.closest('[data-vcaret]')) {
        if (textFolded.has(id)) { textFolded.delete(id); textJustOpened = id; }
        else textFolded.add(id);
        renderTextList();
        return;
      }
      if (textVolSel === id && !textFolded.has(id)) {
        // 再点一下已经展开的这一卷：先让内容自己收回去，动画走完再重排。
        // 直接收的话元素当场被删掉，看不到任何过渡。
        const b = document.querySelector('.volBody[data-body="' + id + '"]');
        textVolSel = '';
        if (b) {
          b.classList.add('closing');
          setTimeout(() => {
            textFolded.add(id);
            renderTextList();
          }, 240);
        } else {
          textFolded.add(id);
          renderTextList();
        }
        return;
      }
      textVolSel = id;
      if (textFolded.has(id)) {
        textFolded.delete(id);
        textJustOpened = id;
      }
      for (const v of (textKids().get('') || [])) {
        if (v.type === 'folder' && v.id !== id) textFolded.add(v.id);
      }
      renderTextList();
      return;
    }
    const row = e.target.closest('.row.leaf');
    if (row && row.dataset.id) {
      // 打开哪一章，就把它的卷也捎上，接着点「+」不会跑偏
      const vol = textVolOf(row.dataset.id);
      if (vol) {
        textVolSel = vol;
        textFolded.delete(vol);
      }
      openNode(row.dataset.id);
      if (innerWidth <= 900) document.body.classList.remove('listOpen');
    }
  });
}

function enterTextView() {
  $('#paneTitle').textContent = '正文';
  bindTextView();
  if (!textVolSel) {
    const cur = textVolOf(state.nodeId);
    const first = (textKids().get('') || []).filter(n => n.type === 'folder')[0];
    textVolSel = cur || (first ? first.id : '');
  }
  renderTextList();
}
