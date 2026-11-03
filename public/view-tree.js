'use strict';
/* 大纲树 + 正文编辑器 */

let saveTimer = null;
let savePending = false;
let currentRevision = 0;
let currentContent = '';
let readOnlyNotice = false;

// ---------------------------------------------------------------- 渲染列表

// 大纲只看大纲：正文视图里建的那些「第 章」不进这棵树。
// 两边各管各的，改哪边都不影响另一边。
function isTextOnly(n) {
  return !!n && n.inText === true;
}

function outlineKids(id) {
  return childrenOf(id).filter(n => !isTextOnly(n));
}

function flattenOutline(parentId, depth, out) {
  const kids = outlineKids(parentId);
  kids.forEach((n, i) => {
    // 记一下是不是这一层的最后一个：最后一个的竖线只画到半高，
    // 收成一个 └，不然线会直愣愣地伸到行底，看着像还没结束。
    out.push({ node: n, depth, last: i === kids.length - 1 });
    // 章节下面也可以再挂东西（把一章拖进另一章），所以不再限定 folder
    if (!state.collapsed.has(n.id) && outlineKids(n.id).length) {
      flattenOutline(n.id, depth + 1, out);
    }
  });
  return out;
}

function renderTreeList() {
  const body = $('#listBody');
  if (!body) return;
  const rows = flattenOutline(null, 0, []);
  const kw = state.filter.trim().toLowerCase();

  const html = rows
    .map(({ node, depth, last }) => {
      if (kw) {
        const hit =
          node.title.toLowerCase().includes(kw) ||
          String(node.summarySentence || '').toLowerCase().includes(kw);
        if (!hit && node.type !== 'folder') return '';
      }
      const isFolder = node.type === 'folder';
      const hasKids = outlineKids(node.id).length > 0;
      const active = node.id === state.nodeId ? ' active' : '';
      const lastCls = last && depth > 0 ? ' last' : '';
      const folded = state.collapsed.has(node.id);
      const caret = isFolder || hasKids
        ? `<span class="caret ${folded ? 'folded' : ''}" data-caret="${node.id}">${folded ? '▸' : '▾'}</span>`
        : '<span class="caret ghost"></span>';
      const stat = isFolder
        ? `<span class="rowMeta">${fmtNum(node.chars || 0)}</span>`
        : `<span class="rowMeta">${node.chars ? fmtNum(node.chars) : ''}</span>`;
      const statusDot = !isFolder && node.status > 0
        ? `<span class="sdot s${node.status}" title="${esc((state.project.statuses || [])[node.status] || '')}"></span>`
        : '';
      // 这一章挂了几个情节，在树上就能看见，不用点进去
      const nPlots = (state.plots || []).filter(p => p.nodeId === node.id).length;
      const plotTag = nPlots ? `<span class="plotTag" title="${nPlots} 个情节挂在这一章">${nPlots}</span>` : '';
      return `<div class="row ${isFolder ? 'folder' : 'leaf'}${active}${lastCls}" data-id="${node.id}"
                   draggable="true" style="--depth:${depth}">
        ${caret}
        <span class="rowTitle">${esc(node.title || '未命名')}</span>
        ${plotTag}
        ${statusDot}
        ${stat}
        <button class="rowMore" data-more="${node.id}" title="更多">⋯</button>
      </div>`;
    })
    .join('');

  body.innerHTML =
    (html || '<div class="listEmpty">还没有内容。点右上角 + 新建。</div>') +
    '<div class="rootDrop">松手 · 移出所在的卷，成为独立节点</div>';
  const w = $('#projWords');
  if (w) w.textContent = fmtNum(totalWords()) + ' 字';
}

// ---------------------------------------------------------------- 打开节点

/* 按当前所在的视图刷左边那一栏。
   正文视图有自己的排法（卷头 + 20 章小折叠），不能拿大纲的树去盖它——
   否则在正文里点一下章节，列表会闪一下变成大纲。 */
function renderListForView() {
  if (typeof currentView === 'string' && currentView === 'text' && typeof renderTextList === 'function') {
    renderTextList();
  } else {
    renderTreeList();
  }
}

async function openNode(id, opts) {
  const o = opts || {};
  if (!o.keepScroll && state.dirty) await flushSave(true);
  const node = nodeById(id);
  if (!node) return;

  state.nodeId = id;
  state.dirty = false;
  flashSaved('');

  if (node.type === 'folder') {
    // 文件夹：显示它的章节数，不打开编辑器正文
    showNodeInfo(id);
    renderListForView();
    return;
  }

  state.editorLoadedFor = id;
  $('#docTitle').value = node.title || '';
  renderStatusSelect(node);
  renderListForView();

  const ed = $('#editor');
  try {
    const r = await api('/api/text/' + id);
    if (state.nodeId !== id) return;
    currentContent = r.content || '';
    currentRevision = r.revision || 0;
    ed.value = currentContent;
    restoreLocalDraft(id);
    updateCounters();
    if (!o.keepScroll) {
      ed.scrollTop = 0;
      ed.focus();
    }
  } catch (e) {
    toast('这一章没读出来：' + e.message, 'error');
  }
}

function renderStatusSelect(node) {
  const sel = $('#docStatus');
  const statuses = (state.project && state.project.statuses) || ['待作'];
  sel.innerHTML = statuses.map((s, i) => `<option value="${i}">${esc(s)}</option>`).join('');
  sel.value = String(node.status || 0);
  sel.classList.toggle('draft', (node.status || 0) > 0);
}

function updateCounters() {
  const ed = $('#editor');
  const text = ed ? ed.value : '';
  const chars = countChars(text);
  const total = countAll(text);
  $('#statChars').textContent = fmtNum(chars) + ' 字';
  $('#statTotal').textContent = '共 ' + fmtNum(total) + ' 字符';
  const node = nodeById(state.nodeId);
  const goalEl = $('#statGoal');
  const goal = node ? Number(node.goal) || 0 : 0;
  if (goal > 0) {
    const pct = Math.min(100, Math.round((chars / goal) * 100));
    goalEl.textContent = `今日目标 ${fmtNum(goal)} · ${pct}%`;
    goalEl.classList.toggle('done', chars >= goal);
  } else {
    goalEl.textContent = '';
  }
}

// ---------------------------------------------------------------- 保存

function markDirty() {
  state.dirty = true;
  flashSaved('未保存', 'dirty');
  stashLocal();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(), 1200);
}

function flashSaved(text, cls) {
  const el = $('#saveState');
  if (!el) return;
  el.textContent = text;
  el.className = 'saveState ' + (cls || '');
}

async function flushSave(immediate) {
  if (!state.nodeId) return;
  const node = nodeById(state.nodeId);
  if (!node || node.type !== 'text') return;
  if (!state.dirty && !immediate) return;
  if (savePending) {
    if (immediate) savePending = true;
    return;
  }
  clearTimeout(saveTimer);
  const ed = $('#editor');
  const content = ed.value;

  savePending = true;
  if (immediate) flashSaved('保存中…', 'dirty');
  try {
    const r = await api('/api/text/' + node.id, {
      method: 'PUT',
      body: {
        content,
        title: $('#docTitle').value,
        baseRevision: currentRevision,
        origin: CLIENT_ID
      }
    });
    currentContent = content;
    currentRevision = r.revision;
    node.chars = countChars(content);
    node.updatedAt = new Date().toISOString();
    state.dirty = false;
    clearLocalDraft(node.id, content);
    flashSaved('已保存', 'ok');
    updateCounters();
    refreshRowMeta(node.id);
  } catch (e) {
    if (e.status === 409) {
      savePending = false;
      await resolveConflict(node.id, e.data);
      return;
    }
    flashSaved('保存失败，内容在本机', 'error');
    toast('没存上：' + e.message + '。内容还在这个页面里，别关。', 'error');
  } finally {
    savePending = false;
  }
  if (state.dirty) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushSave(), 1500);
  }
}

async function resolveConflict(id, data) {
  const serverContent = (data && data.content) || '';
  const ed = $('#editor');
  const mine = ed ? ed.value : '';
  if (serverContent === mine) {
    currentRevision = data.revision;
    state.dirty = false;
    flashSaved('已保存', 'ok');
    return;
  }
  const keepMine = await confirmDialog(
    '两边都改了同一章',
    '另一台设备先存了一版。要用你屏幕上这一版覆盖它吗？\n选「取消」则载入对方的版本，你现在的改动会先留一份历史。',
    '用我这版',
    false
  );
  if (keepMine) {
    currentRevision = data.revision;
    state.dirty = true;
    try {
      const r = await api('/api/text/' + id, {
        method: 'PUT',
        body: { content: mine, title: $('#docTitle').value, baseRevision: data.revision, origin: CLIENT_ID }
      });
      currentRevision = r.revision;
      state.dirty = false;
      flashSaved('已保存', 'ok');
      toast('你的版本已经覆盖上去，对方的改动留在了历史里');
    } catch (e2) {
      toast('还是没存上：' + e2.message, 'error');
    }
  } else {
    ed.value = serverContent;
    currentContent = serverContent;
    currentRevision = data.revision;
    state.dirty = false;
    updateCounters();
    flashSaved('已载入对方版本', 'ok');
  }
}

// ---------------------------------------------------------------- 本地草稿

function draftKey(id) {
  return 'mo:draft:' + id;
}

let stashTimer = null;
function stashLocal(immediate) {
  if (!state.nodeId) return;
  const write = () => {
    stashTimer = null;
    try {
      localStorage.setItem(
        draftKey(state.nodeId),
        JSON.stringify({ content: $('#editor').value, title: $('#docTitle').value, ts: Date.now() })
      );
    } catch (e) {
      /* 配额满了就算了，不打断写作 */
    }
  };
  if (immediate) {
    clearTimeout(stashTimer);
    write();
    return;
  }
  if (!stashTimer) stashTimer = setTimeout(write, 400);
}

function clearLocalDraft(id, content) {
  try {
    const raw = localStorage.getItem(draftKey(id));
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.content === content) localStorage.removeItem(draftKey(id));
  } catch (e) {
    localStorage.removeItem(draftKey(id));
  }
}

function restoreLocalDraft(id) {
  let d = null;
  try {
    d = JSON.parse(localStorage.getItem(draftKey(id)) || 'null');
  } catch (e) {
    d = null;
  }
  if (!d || typeof d.content !== 'string') return;
  if (d.content === currentContent) {
    localStorage.removeItem(draftKey(id));
    return;
  }
  if (Date.now() - (d.ts || 0) > 1000 * 60 * 60 * 24 * 30) {
    localStorage.removeItem(draftKey(id));
    return;
  }
  // 空草稿一律不认：翻页、误触、刚建的新章都会留下一条空记录，
  // 拿它去跟服务器比，只会换来每次打开都跳一句吓人的提示。
  if (!d.content.trim()) {
    localStorage.removeItem(draftKey(id));
    return;
  }
  const charsMine = countChars(d.content);
  const charsServer = countChars(currentContent);
  const pickLocal = charsMine > charsServer;
  if (pickLocal) {
    toast('恢复了上次没上传完的内容（比服务器多 ' + fmtNum(charsMine - charsServer) + ' 字）');
    $('#editor').value = d.content;
    state.dirty = true;
    updateCounters();
    flashSaved('待保存', 'dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushSave(), 900);
  } else {
    // 服务器版本更全，本地这份是旧的就丢掉；不打扰。
    localStorage.removeItem(draftKey(id));
  }
}

// ---------------------------------------------------------------- 编辑器事件

function bindEditor() {
  const ed = $('#editor');

  ed.addEventListener('input', () => {
    markDirty();
    updateCounters();
  });

  // 手机上打字，键盘弹出会改变可视高度，这里让光标始终可见
  ed.addEventListener('focus', () => {
    setTimeout(() => {
      ed.scrollIntoView({ block: 'nearest' });
    }, 260);
  });

  ed.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      flushSave(true);
      return;
    }
    // Tab 缩进两个全角空格
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ed.selectionStart;
      const t = ed.selectionEnd;
      ed.setRangeText('　　', s, t, 'end');
      markDirty();
      updateCounters();
    }
  });

  $('#docTitle').addEventListener('input', () => {
    const node = nodeById(state.nodeId);
    if (!node) return;
    node.title = $('#docTitle').value;
    // 只改这一行的标题文字，整表重画会把正文视图里卷头的金框连带冲掉
    refreshRowTitle(state.nodeId);
    markDirty();
  });

  $('#docTitle').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#editor').focus();
    }
  });

  $('#docStatus').addEventListener('change', async e => {
    const node = nodeById(state.nodeId);
    if (!node) return;
    const v = Number(e.target.value);
    try {
      await api('/api/nodes/' + node.id, { method: 'PATCH', body: { status: v } });
      node.status = v;
      renderStatusSelect(node);
      renderTreeList();
    } catch (err) {
      toast('状态没改上：' + err.message, 'error');
    }
  });

  $('#btnHistory').onclick = () => showHistory(state.nodeId);
  $('#btnNodeInfo').onclick = () => showNodeInfo(state.nodeId);

  $('#btnFocus').onclick = () => {
    const on = document.body.classList.toggle('focus');
    toast(on ? '专注模式：点一下屏幕右上角的按钮可退出' : '已退出专注模式');
  };
}

// ---------------------------------------------------------------- 历史版本

async function showHistory(id) {
  if (!id) return;
  try {
    const r = await api('/api/text/' + id + '/history');
    const list = r.snapshots || [];
    if (!list.length) {
      toast('还没有历史版本。写过一段之后，这里会自动留底。');
      return;
    }
    const newest = list.length ? list[0].file : '';
    const rows = list
      .map(
        s => `<div class="histRow${s.file === newest ? ' histKeep' : ''}" data-file="${esc(s.file)}">
                <input type="checkbox" class="histChk" data-file="${esc(s.file)}" title="${s.file === newest ? '最新一版，永远留着' : '选中'}"${s.file === newest ? ' disabled' : ''}>
                <span class="histTime">${fmtTime(s.ts)}</span>
                <span class="histAgo">${fmtAgo(s.ts)}</span>
                <span class="histSize">${fmtNum(Math.round(s.size / 3))} 字</span>
                ${s.file === newest ? '<span class="histTag">最新</span>' : ''}
                <button class="histDel" data-file="${esc(s.file)}" title="${s.file === newest ? '最新一版删不掉' : '删掉这一版'}"${s.file === newest ? ' disabled' : ''}>×</button>
              </div>`
      )
      .join('');
    openOverlay(
      `<div class="modalTitle">历史版本</div>
       <div class="modalText">每次自动保存都会留底。点一个版本看内容，再决定要不要恢复；右边的 × 只删这一份留底，不动正文。勾上可以一次删多份。<br><span class="histNote">最新的一版永远留着，删不掉——万一哪天真要回滚，至少还有它。</span></div>
       <div class="histTools">
         <label class="histAllWrap"><input type="checkbox" id="histAll"> 全选</label>
         <span class="histPick" id="histPick">已选 0 份</span>
         <button class="histClearAll" id="histClearAll" title="清掉所有旧版本，只留最新那一份">清空（留最新 1 份）</button>
       </div>
       <div class="histList">${rows}</div>
       <div class="modalBtns row2">
         <button class="mBtn" data-act="close">关闭</button>
         <button class="mBtn danger" id="histDelSel" disabled>删掉选中的 0 份</button>
       </div>`,
      card => {
        card.querySelector('[data-act="close"]').onclick = closeOverlay;
        card.querySelectorAll('.histRow').forEach(el => {
          el.onclick = () => previewSnapshot(id, el.dataset.file);
        });
        card.querySelectorAll('.histDel').forEach(btn => {
          btn.onclick = async ev => {
            ev.stopPropagation();
            const file = btn.dataset.file;
            const ok = await confirmDialog(
              '删掉这一份留底？',
              '只删这一个历史版本，正文和别的版本都不动。删了就找不回来了。',
              '删除'
            );
            if (!ok) return;
            try {
              await api('/api/text/' + id + '/history/' + encodeURIComponent(file), {
                method: 'DELETE'
              });
              toast('删掉了');
              showHistory(id); // 重新拉一遍，列表立刻少一行
            } catch (e) {
              toast('删除失败：' + e.message, 'error');
            }
          };
        });

        // ---- 多选 ----
        const chks = [...card.querySelectorAll('.histChk')].filter(c => !c.disabled);
        const allBox = card.querySelector('#histAll');
        const pickTxt = card.querySelector('#histPick');
        const delSel = card.querySelector('#histDelSel');

        const picked = () => chks.filter(c => c.checked).map(c => c.dataset.file);
        const sync = () => {
          const n = picked().length;
          pickTxt.textContent = '已选 ' + n + ' 份';
          delSel.disabled = n === 0;
          delSel.textContent = '删掉选中的 ' + n + ' 份';
          allBox.checked = n > 0 && n === chks.length;
          allBox.indeterminate = n > 0 && n < chks.length;
        };
        chks.forEach(c => {
          c.onclick = ev => {
            ev.stopPropagation();
            sync();
          };
        });
        allBox.onclick = ev => {
          ev.stopPropagation();
          chks.forEach(c => (c.checked = allBox.checked));
          sync();
        };
        sync();

        delSel.onclick = async () => {
          const files = picked();
          if (!files.length) return;
          const ok = await confirmDialog(
            '删掉选中的 ' + files.length + ' 份留底？',
            '这些历史版本会直接消失，正文和没勾的版本都不动。删了就找不回来了。',
            '删除',
            true
          );
          if (!ok) return;
          try {
            const r2 = await api('/api/text/' + id + '/history/delete', {
              method: 'POST',
              body: { files }
            });
            let msg = '删掉了 ' + (r2.deleted || files.length) + ' 份';
            if (r2.kept) msg += '（最新那版留着）';
            toast(msg);
            showHistory(id);
          } catch (e) {
            toast('删除失败：' + e.message, 'error');
          }
        };

        // ---- 一键清空：连着问三次，一次比一次难点头 ----
        card.querySelector('#histClearAll').onclick = async () => {
          const n = list.length;
          const willGo = Math.max(0, n - 1);
          const q1 = await confirmDialog(
            '清掉 ' + willGo + ' 份旧版本？',
            '先说清楚：删掉的是「留底」，你的正文一个字都不会动。最新那一版（' +
              fmtTime(list[0].ts) +
              '）会留着，其余 ' + willGo + ' 份真的会消失，没有回收站。',
            '我要清',
            true
          );
          if (!q1) return;
          const q2 = await confirmDialog(
            '再确认一次：只剩最新 1 份，' + willGo + ' 份全清？',
            '这次是真的了。清完只剩「最新那一版」和「现在」，中间的修改过程再也翻不出来了。',
            '我确定',
            true
          );
          if (!q2) return;
          const q3 = await promptDialog(
            '最后一次确认',
            '在下面输入「清空旧版本」五个字，才会动手。（取消就停下）',
            ''
          );
          if (q3 === null) return;
          if (String(q3).trim() !== '清空旧版本') {
            toast('字不对，什么都没删。');
            return;
          }
          try {
            const r3 = await api('/api/text/' + id + '/history/clear', { method: 'POST' });
            toast('清掉了 ' + (r3.deleted || willGo) + ' 份，最新那版留着');
            showHistory(id);
          } catch (e) {
            toast('清空失败：' + e.message, 'error');
          }
        };
      }
    );
  } catch (e) {
    toast('读历史失败：' + e.message, 'error');
  }
}

async function previewSnapshot(id, file) {
  try {
    const r = await api('/api/text/' + id + '/history/' + encodeURIComponent(file));
    const body = r.content || '';
    openOverlay(
      `<div class="modalTitle">这个版本的内容</div>
       <div class="snapPreview">${esc(body) || '<span class="dim">（空）</span>'}</div>
       <div class="modalBtns">
         <button class="mBtn primary" data-act="restore">恢复成这一版</button>
         <button class="mBtn" data-act="close">返回</button>
       </div>`,
      card => {
        card.querySelector('[data-act="close"]').onclick = () => showHistory(id);
        card.querySelector('[data-act="restore"]').onclick = async () => {
          const ok = await confirmDialog('恢复这一版？', '当前的内容会先存成一份历史，不会丢。', '恢复');
          if (!ok) return;
          try {
            const res = await api('/api/text/' + id + '/restore', { method: 'POST', body: { file } });
            closeOverlay();
            if (state.nodeId === id) {
              $('#editor').value = res.content || '';
              currentContent = res.content || '';
              currentRevision = res.revision || 0;
              state.dirty = false;
              updateCounters();
              flashSaved('已保存', 'ok');
            }
            toast('恢复好了');
            await loadNodes();
            renderTreeList();
          } catch (e) {
            toast('恢复失败：' + e.message, 'error');
          }
        };
      }
    );
  } catch (e) {
    toast('读这个版本失败：' + e.message, 'error');
  }
}

// ---------------------------------------------------------------- 节点设定

async function showNodeInfo(id) {
  await ensurePlots();
  const node = nodeById(id);
  if (!node) return;
  const isFolder = node.type === 'folder';
  const labels = (state.project && state.project.labels) || [];

  const labelChips = labels
    .map(
      (l, i) =>
        `<button class="chip ${(node.labels || []).includes(l.name) ? 'on' : ''}" data-label="${esc(l.name)}"
           style="--chip:${esc(l.color || '#888')}">${esc(l.name)}</button>`
    )
    .join('');

  // 挂在当前节点上的情节，点一下就跳过去
  const linked = (state.plots || []).filter(p => p.nodeId === node.id);
  const plotLinks = linked.length
    ? linked
        .map(p => `<button class="chip linkChip" data-goplot="${esc(p.id)}">${esc(p.name || '未命名情节')}</button>`)
        .join('')
    : '<span class="dim small">还没有情节挂在这一章上。去「情节」里给它绑一个。</span>';

  openOverlay(
    `<div class="modalTitle">${isFolder ? '这一卷' : '这一章'}</div>
     <div class="fieldGrid">
       <label class="fLabel">一句话梗概</label>
       <input class="mInput" id="niSentence" value="${esc(node.summarySentence || '')}" placeholder="一章只用一句话说清">
       <label class="fLabel">段落梗概</label>
       <textarea class="mInput mArea" id="niFull" rows="5" placeholder="这一段发生了什么">${esc(node.summaryFull || '')}</textarea>
       ${isFolder ? '' : `<label class="fLabel">本章目标字数</label>
       <input class="mInput" id="niGoal" type="number" min="0" step="100" value="${Number(node.goal) || 0}">`}
       <label class="fLabel">标签</label>
       <div class="chips" id="niLabels">${labelChips}</div>
       <label class="fLabel">关联情节</label>
       <div class="chips" id="niPlots">${plotLinks}</div>
       <label class="fLabel">导出</label>
       <label class="checkLine"><input type="checkbox" id="niCompile" ${node.compile === false ? '' : 'checked'}> 参与合并导出</label>
     </div>
     <div class="modalBtns">
       <button class="mBtn primary" data-act="save">保存</button>
       <button class="mBtn" data-act="close">关闭</button>
     </div>`,
    card => {
      card.querySelector('[data-act="close"]').onclick = closeOverlay;
      card.querySelectorAll('#niLabels .chip').forEach(el => {
        el.onclick = () => el.classList.toggle('on');
      });
      // 「关联情节」直通情节卡
      card.querySelectorAll('[data-goplot]').forEach(el => {
        el.onclick = () => {
          const pid = el.dataset.goplot;
          closeOverlay();
          switchView('plots');
          setTimeout(() => openCard('plots', pid), 90);
        };
      });
      card.querySelector('[data-act="save"]').onclick = async () => {
        const picked = Array.from(card.querySelectorAll('#niLabels .chip.on')).map(el => el.dataset.label);
        const patch = {
          summarySentence: card.querySelector('#niSentence').value,
          summaryFull: card.querySelector('#niFull').value,
          labels: picked,
          compile: card.querySelector('#niCompile').checked
        };
        const goalEl = card.querySelector('#niGoal');
        if (goalEl) patch.goal = Number(goalEl.value) || 0;
        try {
          const r = await api('/api/nodes/' + node.id, { method: 'PATCH', body: patch });
          Object.assign(node, r.node);
          closeOverlay();
          renderTreeList();
          updateCounters();
          toast('存好了');
        } catch (e) {
          toast('没存上：' + e.message, 'error');
        }
      };
    }
  );
}

// ---------------------------------------------------------------- 行内菜单

function openRowMenu(id, anchorEl) {
  const node = nodeById(id);
  if (!node) return;
  // 上一个菜单如果还挂着（连续点多个 ⋯），它的"点别处就关"监听
  // 会在这次点击里把新菜单关掉，留下一个关不掉的孤儿
  document.querySelectorAll('.ctxMenu').forEach(m => m.remove());
  const isFolder = node.type === 'folder';
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'ctxMenu';
  menu.innerHTML = `
    <button data-act="rename">重命名</button>
    ${isFolder ? '<button data-act="add">新建子项</button>' : ''}
    <button data-act="info">设定…</button>
    ${!isFolder ? `<button data-act="totext">${node.inText ? '移出正文' : '放进正文'}</button>` : ''}
    <button data-act="up">上移</button>
    <button data-act="down">下移</button>
    <button data-act="indent">缩进一级</button>
    <button data-act="outdent">提升一级</button>
    <button data-act="tofolder">${isFolder ? '改为章节' : '改为卷'}</button>
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
    await handleRowAction(act, node);
  };
}

async function handleRowAction(act, node) {
  if (act === 'rename') {
    const v = await promptDialog('重命名', '这段叫什么？', node.title);
    if (v === null || !v.trim()) return;
    await api('/api/nodes/' + node.id, { method: 'PATCH', body: { title: v.trim() } });
    node.title = v.trim();
    if (state.nodeId === node.id) $('#docTitle').value = node.title;
    renderListForView();
    return;
  }
  if (act === 'add') {
    await createNode(node.id, 'text');
    return;
  }
  if (act === 'info') {
    showNodeInfo(node.id);
    return;
  }
  if (act === 'totext') {
    // 正文视图只列 inText 的章节，这里是一章进出正文的开关。
    // 只改标记，正文内容一个字都不碰。
    const next = !node.inText;
    await api('/api/nodes/' + node.id, { method: 'PATCH', body: { inText: next } });
    node.inText = next;
    await loadNodes();
    if (currentView === 'text' && typeof renderTextList === 'function') renderTextList();
    else renderListForView();
    toast(next ? '已经放进正文' : '已经移出正文');
    return;
  }
  if (act === 'up' || act === 'down') {
    const sibs = childrenOf(node.parentId);
    const i = sibs.findIndex(n => n.id === node.id);
    if (act === 'up' ? i <= 0 : i >= sibs.length - 1) return;
    // 上移 = 插到前一个的再前面；下移 = 插到后一个的后面
    const afterId = act === 'up'
      ? (i - 2 >= 0 ? sibs[i - 2].id : null)
      : sibs[i + 1].id;
    await api('/api/nodes/' + node.id + '/move', {
      method: 'POST',
      body: { parentId: node.parentId || null, afterId }
    });
    await loadNodes();
    renderListForView();
    return;
  }
  if (act === 'indent') {
    const sibs = childrenOf(node.parentId);
    const i = sibs.findIndex(n => n.id === node.id);
    if (i <= 0) return;
    const prev = sibs[i - 1];
    await api('/api/nodes/' + node.id + '/move', { method: 'POST', body: { parentId: prev.id } });
    state.collapsed.delete(prev.id);
    await loadNodes();
    renderListForView();
    return;
  }
  if (act === 'outdent') {
    if (!node.parentId) return;
    const p = nodeById(node.parentId);
    if (!p) return;
    await api('/api/nodes/' + node.id + '/move', {
      method: 'POST',
      body: { parentId: p.parentId || null, afterId: p.id }
    });
    await loadNodes();
    renderListForView();
    return;
  }
  if (act === 'tofolder') {
    const next = node.type === 'folder' ? 'text' : 'folder';
    if (next === 'text' && childrenOf(node.id).length) {
      const ok = await confirmDialog('改成章节？', '它下面还有子项。改成章节后，那些子项会挪到它的上一层，不会删。', '改成章节');
      if (!ok) return;
      for (const c of childrenOf(node.id)) {
        await api('/api/nodes/' + c.id, { method: 'PATCH', body: { parentId: node.parentId || null } });
      }
    }
    await api('/api/nodes/' + node.id, { method: 'PATCH', body: { type: next } });
    await loadNodes();
    renderListForView();
    if (state.nodeId === node.id) openNode(node.id);
    return;
  }
  if (act === 'delete') {
    const kids = subtreeIds(node.id).length - 1;
    const ok = await confirmDialog(
      '删除「' + node.title + '」？',
      kids > 0 ? '它下面还有 ' + kids + ' 个子项，会一起移走。所有内容会放进 data/trash，不会真的消失。' : '内容会放进 data/trash，不会真的消失。',
      '删除',
      true
    );
    if (!ok) return;
    await api('/api/nodes/' + node.id, { method: 'DELETE' });
    if (subtreeIds.call(null, node.id).includes(state.nodeId)) state.nodeId = null;
    await loadNodes();
    renderListForView();
    toast('删掉了，可在 data/trash 找回');
    const first = state.nodes.find(n => n.type === 'text');
    if (!state.nodeId && first) openNode(first.id);
    return;
  }
}

async function createNode(parentId, type, silent, inText) {
  // 点「+」是为了马上动笔，不是为了先给章节起名：
  // 不弹窗，直接用默认名建好并打开，标题框里名字是全选的，想改直接打字。
  let name = '';
  if (!silent) {
    name = await promptDialog(type === 'folder' ? '新建一卷' : '新建章节', '名字（之后随时能改）', '');
    if (name === null) return;
  }
  try {
    const r = await api('/api/nodes', {
      method: 'POST',
      body: {
        parentId: parentId || null,
        type,
        title: (name || '').trim() || (type === 'folder' ? '新卷' : '第 章'),
        // 顶层新建一卷时，别拿当前章节当锚点（它在别的卷底下，插不进这一层）
        afterId: (type === 'folder' && !parentId) ? null : state.nodeId,
        inText: !!inText
      }
    });
    await loadNodes();
    if (r.node.type === 'text') {
      await openNode(r.node.id);
      const t = $('#docTitle');
      if (t && !name) {
        t.focus();
        t.select();
      }
    }
    // 刷新的活儿放在最后：openNode 那条链路里会顺手把左边刷一遍，
    // 这里再按当前视图对一次，免得 folder 那种不走 openNode 的情况漏掉。
    renderListForView();
  } catch (e) {
    toast('建不上：' + e.message, 'error');
  }
}

// ---------------------------------------------------------------- 树的交互

function bindTree() {
  const body = $('#listBody');

  body.addEventListener('click', e => {
    // 正文视图有自己的一套（卷标题 + 章节行），别在这儿抢
    if (typeof currentView === 'string' && currentView === 'text') return;
    const caret = e.target.closest('[data-caret]');
    if (caret) {
      const id = caret.dataset.caret;
      if (state.collapsed.has(id)) state.collapsed.delete(id);
      else state.collapsed.add(id);
      listFlip(renderTreeList);
      return;
    }
    const more = e.target.closest('[data-more]');
    if (more) {
      e.stopPropagation();
      openRowMenu(more.dataset.more, more);
      return;
    }
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    const node = nodeById(id);
    if (!node) return;
    if (node.type === 'folder' && !e.target.closest('.rowTitle')) {
      if (state.collapsed.has(id)) state.collapsed.delete(id);
      else state.collapsed.add(id);
      listFlip(renderTreeList);
      return;
    }
    if (node.type === 'folder') {
      if (state.collapsed.has(id)) state.collapsed.delete(id);
      else state.collapsed.add(id);
      listFlip(renderTreeList);
      return;
    }
    openNode(id);
    if (innerWidth <= 900) document.body.classList.remove('listOpen');
  });

  // 拖拽排序
  // 行的上四分之一 = 插到它前面（同级）
  // 行中间         = 收进去，成为它的子章节
  // 行下四分之一 = 插到它后面（同级）
  // 拖到列表空白   = 提到最外层
  let dragId = null;
  let dropHint = null;

  const clearHints = () => {
    $$('.row.dropAbove,.row.dropBelow,.row.dropInside').forEach(el =>
      el.classList.remove('dropAbove', 'dropBelow', 'dropInside'));
    body.classList.remove('dragover-root');
  };

  body.addEventListener('dragstart', e => {
    if (typeof currentView === 'string' && currentView === 'text') return;
    const row = e.target.closest('.row');
    if (!row) return;
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    document.body.classList.add('is-dragging');
    setTimeout(() => row.classList.add('dragging'), 0);
  });

  body.addEventListener('dragend', () => {
    $$('.row.dragging').forEach(el => el.classList.remove('dragging'));
    document.body.classList.remove('is-dragging');
    clearHints();
    dragId = null;
    dropHint = null;
  });

  body.addEventListener('dragover', e => {
    if (!dragId) return;
    const row = e.target.closest('.row');
    clearHints();
    if (!row) {
      e.preventDefault();
      body.classList.add('dragover-root');
      dropHint = { id: null, where: 'root' };
      return;
    }
    const targetId = row.dataset.id;
    if (targetId === dragId) {
      dropHint = null;
      return;
    }
    if (subtreeIds(dragId).includes(targetId)) {
      dropHint = null; // 不能拖进自己的子孙里
      return;
    }
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const y = (e.clientY - rect.top) / Math.max(1, rect.height);
    let where;
    if (y < 0.25) where = 'above';
    else if (y > 0.75) where = 'below';
    else where = 'inside';
    row.classList.add(where === 'above' ? 'dropAbove' : where === 'below' ? 'dropBelow' : 'dropInside');
    dropHint = { id: targetId, where };
  });

  body.addEventListener('dragleave', e => {
    if (!body.contains(e.relatedTarget)) {
      clearHints();
      dropHint = null;
    }
  });

  body.addEventListener('drop', async e => {
    e.preventDefault();
    const hint = dropHint;
    const id = dragId;
    clearHints();
    document.body.classList.remove('is-dragging');
    dropHint = null;
    dragId = null;
    if (!id || !hint) return;
    try {
      if (hint.where === 'root') {
        await api('/api/nodes/' + id + '/move', { method: 'POST', body: { parentId: null } });
      } else {
        const t = nodeById(hint.id);
        if (!t) return;
        if (hint.where === 'inside') {
          await api('/api/nodes/' + id + '/move', { method: 'POST', body: { parentId: t.id } });
          state.collapsed.delete(t.id);
        } else {
          const parentId = t.parentId || null;
          const sibs = childrenOf(parentId).filter(n => n.id !== id);
          const idx = sibs.findIndex(n => n.id === t.id);
          const afterId = hint.where === 'above' ? (idx > 0 ? sibs[idx - 1].id : null) : t.id;
          await api('/api/nodes/' + id + '/move', { method: 'POST', body: { parentId, afterId } });
        }
      }
      await loadNodes();
      listFlip(renderTreeList);
    } catch (err) {
      toast('挪不动：' + err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------- 导航

function enterTreeView() {
  state.view = 'tree';
  $('#paneTitle').textContent = '大纲';
  $('#viewEditor').hidden = false;
  $('#viewCards').hidden = true;
  $('#viewPlot').hidden = true;
  $('#viewWorld').hidden = true;
  $('#viewStats').hidden = true;
  $('#viewEmpty').hidden = true;
  listFlip(renderTreeList);
  if (!state.nodeId) {
    const first = state.nodes.find(n => n.type === 'text');
    if (first) openNode(first.id);
    else {
      $('#viewEditor').hidden = true;
      $('#viewEmpty').hidden = false;
    }
  } else if (nodeById(state.nodeId) && nodeById(state.nodeId).type === 'text') {
    // 保留当前打开的章节
  } else {
    const first = state.nodes.find(n => n.type === 'text');
    if (first) openNode(first.id);
    else {
      $('#viewEditor').hidden = true;
      $('#viewEmpty').hidden = false;
    }
  }
}

// 保存之后只更新这一行（和它所在卷头）的字数，不重画整张列表。
// 以前这里调的是 renderTreeList()，在正文视图里打字每 1.2 秒会把左边刷成大纲的样子。
function refreshRowTitle(id) {
  const body = $('#listBody');
  if (!body) return;
  const node = nodeById(id);
  if (!node) return;
  const row = body.querySelector('.row[data-id="' + id + '"]');
  if (!row) return;
  const t = row.querySelector('.rowTitle');
  if (t) t.textContent = node.title || '';
}

function refreshRowMeta(id) {
  const body = $('#listBody');
  if (!body) return;
  const node = nodeById(id);
  if (!node) return;

  const row = body.querySelector('.row[data-id="' + id + '"]');
  if (row) {
    const meta = row.querySelector('.rowMeta');
    if (meta) meta.textContent = node.chars ? fmtNum(node.chars) : '';
  }

  if (typeof currentView === 'string' && currentView === 'text' && typeof textVolOf === 'function') {
    const vol = textVolOf(id);
    const vEl = vol ? body.querySelector('.textVol[data-vol="' + vol + '"]') : null;
    if (vEl) {
      const meta = vEl.querySelector('.volMeta');
      if (meta) {
        const kids = textKids();
        const leaves = [];
        leavesUnder(vol, kids, leaves);
        let n = 0, w = 0;
        for (const l of leaves) { n++; w += (l.chars || 0); }
        meta.textContent = n + ' 章 · ' + fmtNum(w) + ' 字';
      }
    }
  }
}
