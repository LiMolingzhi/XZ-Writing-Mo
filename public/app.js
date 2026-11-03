'use strict';
/* 茉 · 写作台 —— 入口 */

let currentView = 'tree';

// ---------------------------------------------------------------- 登录

async function initLogin() {
  const st = await api('/api/status').catch(() => null);
  if (st) state.status = st;
  if (st && st.needsLogin) {
    $('#login').hidden = false;
    $('#app').hidden = true;
    const hint = $('#loginHint');
    const addrs = (st.addresses || []).filter(a => !/radmin|vpn/i.test(a.name));
    if (addrs.length) {
      hint.innerHTML = '手机连同一个 WiFi，打开：<br><span class="loginAddr">http://' + esc(addrs[0].address) + ':' + location.port + '</span>';
    }
    setTimeout(() => $('#pwInput').focus(), 200);
    return false;
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  return true;
}

function bindLogin() {
  const go = async () => {
    const pw = $('#pwInput').value;
    if (!pw) return;
    $('#loginBtn').disabled = true;
    $('#loginBtn').textContent = '…';
    try {
      await api('/api/login', { method: 'POST', body: { password: pw } });
      $('#login').hidden = true;
      $('#app').hidden = false;
      await boot();
    } catch (e) {
      $('#loginHint').textContent = e.message || '进不去';
      $('#loginHint').classList.add('shake');
      setTimeout(() => $('#loginHint').classList.remove('shake'), 500);
      $('#pwInput').select();
    } finally {
      $('#loginBtn').disabled = false;
      $('#loginBtn').textContent = '进 入';
    }
  };
  $('#loginBtn').onclick = go;
  $('#pwInput').onkeydown = e => {
    if (e.key === 'Enter') go();
  };
}

// ---------------------------------------------------------------- 视图切换

/**
 * 空状态。以前这一屏什么按钮都没有——手机上进到空的「物品」页，
 * 既回不去也别处点，只能刷页面。现在它跟别的视图一样有顶栏：
 * 左边 ☰ 开抽屉，右边 + 就地新建。
 */
function showEmpty(title, text) {
  ['#viewEditor', '#viewCards', '#viewPlot', '#viewWorld', '#viewStats'].forEach(sel => {
    const el = $(sel);
    if (el) el.hidden = true;
  });
  const t = $('#emptyTitle');
  if (t) t.textContent = title || '';
  const txt = $('#viewEmpty').querySelector('.emptyText');
  if (txt) txt.textContent = text || '';
  $('#viewEmpty').hidden = false;
}

function switchView(view) {
  currentView = view;
  // 「思维」要占满整个宽度画导图，其他视图把左边那栏放回来。
  // 另外手机上进思维要把抽屉收掉——不然那层半屏列表会跟着一起进去，画布只剩一条缝。
  if (view === 'mind') document.body.classList.remove('listOpen');
  else document.body.classList.remove('mindOn');
  // 关系网也占左栏。这里无条件先清掉——各分支里到处都是提前 return，
  // 放在末尾那句根本跑不到，回来时列表就一直是关着的（页面像卡死）。
  if (view !== 'net') document.body.classList.remove('netOn');
  // 手机上视图栏是抽屉：这里偏偏不收——刚拉开抽屉点了「角色」，
  // 抽屉得留着让人接着选条目。真正收起来的时机是「打开某一项」的时候。
  try {
    sessionStorage.setItem('mo:view', view);
  } catch (e) {
    /* 隐私模式下写不了，无所谓 */
  }
  $$('.railBtn').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  document.body.classList.remove('focus');
  // 专注模式挪到正文了：大纲是规划用的，不需要盯着字看
  const focusBtn = $('#btnFocus');
  if (focusBtn) focusBtn.hidden = view !== 'text';
  // 「新建一卷」只在正文里有意义；大纲那边的分组用行菜单建
  const nfBtn = $('#btnNewFolder');
  if (nfBtn) nfBtn.hidden = view !== 'text';
  // 「关系网」是角色视图的侧门：旁边挂着，点一下转到网里看
  const netBtn = $('#btnNet');
  if (netBtn) netBtn.hidden = view !== 'characters';
  // 分量滑块只属于角色和情节视图
  const bar = $('#listFilter');
  if (bar && view !== 'characters' && view !== 'plots') {
    bar.hidden = true;
    bar.innerHTML = '';
  }

  // 先把自己藏干净，再由下面的分支把自己亮出来。
  // 各个 enter*View 各管各的，很容易漏——「思维」当初就没在任何一个
  // 分支里被藏过，结果从思维切到世界再切物品时会串台。
  $$('.view').forEach(v => { v.hidden = true; });

  if (view === 'tree') {
    $('#paneTitle').textContent = '大纲';
    $('#viewEditor').hidden = false;
    $('#viewCards').hidden = true;
    $('#viewPlot').hidden = true;
    $('#viewWorld').hidden = true;
    $('#viewStats').hidden = true;
    $('#viewEmpty').hidden = true;
    renderTreeList();
    // 树上要显示「这章挂了几个情节」，先把情节拉下来再重画一次
    if (typeof ensurePlots === 'function') ensurePlots().then(() => renderTreeList());
    if (!state.nodeId || !nodeById(state.nodeId)) {
      const first = state.nodes.find(n => n.type === 'text');
      if (first) openNode(first.id);
      else {
        $('#viewEditor').hidden = true;
        showEmpty('大纲', '还没有章节。点右上角 + 新建。');
      }
    } else if (state.editorLoadedFor !== state.nodeId) {
      // 刷新后如果上次停在角色/情节视图，编辑器是空的，得把正文重新读进来
      openNode(state.nodeId, { keepScroll: true });
    }
    return;
  }
  if (view === 'text') {
    $('#viewEditor').hidden = false;
    $('#viewCards').hidden = true;
    $('#viewPlot').hidden = true;
    $('#viewWorld').hidden = true;
    $('#viewStats').hidden = true;
    $('#viewEmpty').hidden = true;
    enterTextView();
    // 章节行上要显示「挂了几个情节」
    if (typeof ensurePlots === 'function') ensurePlots().then(() => renderTextList());
    const cur = state.nodeId ? nodeById(state.nodeId) : null;
    // 正文视图里只有「叶子章节」能写。停在卷上、或停在 001·020 这种分组上，
    // 编辑器会是空的——那就自动挪到第一个真章节。
    const kids = textKids();
    const all = [];
    for (const v of kids.get('') || []) if (v.type === 'folder') leavesUnder(v.id, kids, all);
    const leafSet = new Set(all.map(n => n.id));
    if (!cur || !leafSet.has(cur.id)) {
      const first = all.find(n => (n.chars || 0) > 0) || all[0];
      if (first) openNode(first.id);
      else {
        $('#viewEditor').hidden = true;
        showEmpty('正文', '还没有章节。点右上角 + 新建，或者在大纲的行菜单里「放进正文」。');
      }
    } else if (state.editorLoadedFor !== state.nodeId) {
      openNode(state.nodeId, { keepScroll: true });
    }
    return;
  }
  if (view === 'characters' || view === 'items' || view === 'plots') {
    enterCardsView(view);
    return;
  }
  if (view === 'world') {
    enterWorldView();
    return;
  }
  // 「思维」「关系网」是宽屏视图：手机上入口是隐藏的，
  // 但可能有别的地方（快捷键、旧书签、刷新恢复）把它推进来，这里直接挡掉。
  if ((view === 'mind' || view === 'net') && window.innerWidth <= 900) {
    view = 'tree';
    currentView = view;
  }
  if (view === 'mind') {
    enterMindView();
    return;
  }
  if (view === 'net') {
    // 关系网自带左栏，把外层那个角色列表让出来，别两份列表并排放
    document.body.classList.add('netOn');
    $('#viewNet').hidden = false;
    enterNetView();
    return;
  }
  if (view === 'stats') {
    enterStatsView();
    return;
  }
}

// ---------------------------------------------------------------- 设置

/**
 * 存一个文件给用户。
 *
 * 浏览器里用 blob + a.download；安卓壳里的 WebView 不支持这条路径
 * （blob: URL 不会触发 DownloadListener，点下去毫无反应），
 * 所以壳里改走注入的 MoShell.saveFile(base64)。
 */
function saveFile(name, blob) {
  const shell = window.MoShell;
  if (shell && typeof shell.saveFile === 'function') {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      shell.saveFile(name, s.slice(s.indexOf(',') + 1));
    };
    r.readAsDataURL(blob);
    toast('已存到「下载」：' + name);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ── 整体缩放：和浏览器 Ctrl+滚轮一样的效果 ──
   用 CSS zoom 而不是 transform:scale —— zoom 会真的把布局重排，
   滚动条、fixed 定位、光标都跟着对；transform 只是糊一层。 */
function applyUiZoom(v) {
  const z = Math.min(160, Math.max(70, Number(v) || 100));
  document.documentElement.style.zoom = z / 100;
  // zoom 是在同一个视口里把东西放大，100vh 不会跟着变，弹窗就会顶出屏幕。
  // 把这些高度按缩放反算回来（样式里写的是 calc(88vh / var(--z))）。
  document.documentElement.style.setProperty('--z', z / 100);
  return z;
}

function initUiZoom() {
  applyUiZoom(Number(localStorage.getItem('mo:uiZoom') || 100));

  let lastToast = 0;
  document.addEventListener(
    'wheel',
    e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const cur = Number(localStorage.getItem('mo:uiZoom') || 100);
      const next = Math.min(160, Math.max(70, cur + (e.deltaY < 0 ? 5 : -5)));
      if (next === cur) return;
      localStorage.setItem('mo:uiZoom', next);
      applyUiZoom(next);
      const now = Date.now();
      if (now - lastToast > 400) {
        lastToast = now;
        toast('界面 ' + next + '%');
      }
    },
    { passive: false }
  );

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      localStorage.setItem('mo:uiZoom', 100);
      applyUiZoom(100);
      toast('界面 100%');
    }
  });
}

function openSettings() {
  const p = state.project || {};
  const fs = Number(localStorage.getItem('mo:fontSize') || 19);
  const lh = Number(localStorage.getItem('mo:lineHeight') || 190);
  const cw = Number(localStorage.getItem('mo:colWidth') || 620);
  const zoom = Number(localStorage.getItem('mo:uiZoom') || 100);

  openOverlay(
    `<div class="modalTitle">设置</div>
     <div class="settingsScroll">
       <div class="setGroup">
         <div class="setGroupTitle">作品</div>
         <label class="fLabel">书名</label>
         <input class="mInput" id="setTitle" value="${esc(p.title || '')}">
         <label class="fLabel">系列</label>
         <input class="mInput" id="setSeries" value="${esc(p.series || '')}">
         <label class="fLabel">作者</label>
         <input class="mInput" id="setAuthor" value="${esc(p.author || '')}">
         <label class="fLabel">每日目标字数</label>
         <input class="mInput" id="setGoal" type="number" min="0" step="100" value="${(p.goal && p.goal.daily) || 0}">
       </div>

       <div class="setGroup">
          <div class="setGroupTitle">界面</div>
          <label class="fLabel">整体缩放 <span class="dim" id="zoomVal">${zoom}%</span></label>
          <input class="range" id="setZoom" type="range" min="70" max="160" step="5" value="${zoom}">
        </div>

        <div class="setGroup">
         <div class="setGroupTitle">阅读</div>
         <label class="fLabel">字号 <span class="dim" id="fsVal">${fs}px</span></label>
         <input class="range" id="setFont" type="range" min="14" max="28" value="${fs}">
         <label class="fLabel">行距 <span class="dim" id="lhVal">${(lh / 100).toFixed(2)}</span></label>
         <input class="range" id="setLine" type="range" min="140" max="260" step="5" value="${lh}">
         <label class="fLabel">栏宽 <span class="dim" id="cwVal">${cw}px</span></label>
         <input class="range" id="setCol" type="range" min="420" max="1200" step="20" value="${cw}">
       </div>

              <div class="setGroup">
         <div class="setGroupTitle">手机 / 平板</div>
         <div class="dim small">同一个 WiFi 下，手机浏览器打开这个地址：</div>
         <div class="setRow">
           <span class="lanAddr" id="setLanAddr">—</span>
           <button class="mBtn small" id="btnCopyLan">复制</button>
         </div>
         <div class="dim small">别用 127.0.0.1 —— 那是手机自己，不是这台电脑。</div>
         <div class="setRow">
           <a class="mBtn small" id="btnGetApk" href="/app.apk" download>装成手机 App</a>
         </div>
       </div>

        <div class="setGroup" id="setGroupDesktop">
          <div class="setGroupTitle">装到这台电脑</div>
          <div class="setRow">
            <a class="mBtn small" id="btnGetSetup" href="/setup.exe" download>下载电脑版安装包</a>
          </div>
          <div class="dim small">装到这台电脑上任何位置都行，稿子留在原地不动。安装包也能拷到别的电脑——那台不用装 Node.js，运行时在包里。</div>
        </div>

<div class="setGroup">
         <div class="setGroupTitle">导出</div>
         <div class="setRow">
           <button class="mBtn small" data-export="md">Markdown</button>
           <button class="mBtn small" data-export="txt">纯文本</button>
           <button class="mBtn small" data-export="html">HTML</button>
         </div>
         <div class="dim small">只导出勾选了「参与合并导出」的章节。</div>
       </div>

       <div class="setGroup">
         <div class="setGroupTitle">打包带走</div>
         <div class="setRow">
           <button class="mBtn small" id="btnPackage">下载整包</button>
         </div>
         <div class="dim small">
           程序 + 全部正文 + 设定 + 最近一次备份，打成一个 zip。<br>
           换电脑：装好 Node 后解压，双击 run-loop.bat 就能接着写。
         </div>
       </div>

       <div class="setGroup">
         <div class="setGroupTitle">密码</div>
         <label class="fLabel">原密码</label>
         <input class="mInput" id="setOldPw" type="password" autocomplete="current-password">
         <label class="fLabel">新密码</label>
         <input class="mInput" id="setNewPw" type="password" autocomplete="new-password">
         <div class="setRow"><button class="mBtn small" id="btnChangePw">改密码</button></div>
           改完可以删掉程序目录下的「密码.txt」。
       </div>

       <div class="setGroup">
         <div class="setGroupTitle">其他</div>
         <div class="setRow">
           <button class="mBtn small" id="btnSearch">搜索全书</button>
           <button class="mBtn small" id="btnLogout">退出登录</button>
         </div>
       </div>
     </div>
     <div class="modalBtns"><button class="mBtn primary" data-act="close">完成</button></div>`,
    card => {
      card.querySelector('[data-act="close"]').onclick = () => {
        applyReadingPrefs();
        closeOverlay();
      };
      // 两个下载入口要按「文件在不在」来摆：开源包里没有 apk 和 Setup.exe，
      // 无条件显示的话点开就是 404，看着像程序坏了。
      (() => {
        const st = state.status || {};
        const apk = card.querySelector('#btnGetApk');
        if (apk && !st.hasApk) {
          const row = apk.closest('.setRow');
          if (row) row.style.display = 'none';
        }
        const box = card.querySelector('#setGroupDesktop');
        if (!box) return;
        const narrow = innerWidth <= 900;
        const android = /Android/i.test(navigator.userAgent);
        if (narrow || android || !st.hasSetup) box.style.display = 'none';
      })();
      // 手机地址：直接告诉用户该在手机上敲什么，省得他照着本机的 127.0.0.1 抄
      (() => {
        const st = state.status || {};
        const addrs = (st.addresses || []).filter(a => !/radmin|vpn/i.test(a.name));
        const el = card.querySelector('#setLanAddr');
        if (addrs.length) {
          const url = 'http://' + addrs[0].address + ':' + (location.port || 7788);
          el.textContent = url;
          card.querySelector('#btnCopyLan').onclick = async () => {
            try {
              await navigator.clipboard.writeText(url);
              toast('地址复制好了');
            } catch (err) {
              // 非 HTTPS 下 clipboard 可能不给用，退回到选中文本让人自己复制
              const r = document.createRange();
              r.selectNodeContents(el);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(r);
              toast('已选中，长按复制');
            }
          };
        } else {
          el.textContent = '没找到局域网地址';
          card.querySelector('#btnCopyLan').disabled = true;
        }
      })();

      card.querySelector('#setZoom').oninput = e => {
        const v = Number(e.target.value);
        localStorage.setItem('mo:uiZoom', v);
        card.querySelector('#zoomVal').textContent = v + '%';
        applyUiZoom(v);
      };
      card.querySelector('#setFont').oninput = e => {
        localStorage.setItem('mo:fontSize', e.target.value);
        card.querySelector('#fsVal').textContent = e.target.value + 'px';
        applyReadingPrefs();
      };
      card.querySelector('#setLine').oninput = e => {
        localStorage.setItem('mo:lineHeight', e.target.value);
        card.querySelector('#lhVal').textContent = (e.target.value / 100).toFixed(2);
        applyReadingPrefs();
      };
      card.querySelector('#setCol').oninput = e => {
        localStorage.setItem('mo:colWidth', e.target.value);
        card.querySelector('#cwVal').textContent = e.target.value + 'px';
        applyReadingPrefs();
      };
      card.querySelectorAll('[data-export]').forEach(btn => {
        btn.onclick = () => exportBook(btn.dataset.export);
      });

      card.querySelector('#btnPackage').onclick = e => {
        // 直接走浏览器原生下载：流式落盘，不把三十几 MB 塞进内存，
        // 也不受页面里 await 的超时影响。下载器自己管，最稳。
        const a = document.createElement('a');
        a.href = '/api/package';
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast('正在打包，好了浏览器会提示保存');
      };;
      card.querySelector('#btnChangePw').onclick = async () => {
        const oldPw = card.querySelector('#setOldPw').value;
        const newPw = card.querySelector('#setNewPw').value;
        if (!oldPw || !newPw) {
          toast('两个都要填', 'error');
          return;
        }
        try {
          await api('/api/password', { method: 'POST', body: { old: oldPw, next: newPw } });
          toast('密码改好了');
          card.querySelector('#setOldPw').value = '';
          card.querySelector('#setNewPw').value = '';
        } catch (e) {
          toast(e.message, 'error');
        }
      };
      card.querySelector('#btnSearch').onclick = () => {
        closeOverlay();
        openSearch();
      };
      card.querySelector('#btnLogout').onclick = async () => {
        await api('/api/logout', { method: 'POST' }).catch(() => {});
        location.reload();
      };
      // 作品信息：失焦即保存
      const saveProject = async () => {
        const patch = {
          title: card.querySelector('#setTitle').value,
          series: card.querySelector('#setSeries').value,
          author: card.querySelector('#setAuthor').value,
          goal: { daily: Number(card.querySelector('#setGoal').value) || 0 }
        };
        try {
          state.project = await api('/api/project', { method: 'PATCH', body: patch });
          $('#projTitle').textContent = state.project.title || '未命名作品';
          document.title = (state.project.title || '') + ' · 写作台';
        } catch (e) {
          toast('书名没存上：' + e.message, 'error');
        }
      };
      ['#setTitle', '#setSeries', '#setAuthor', '#setGoal'].forEach(sel => {
        card.querySelector(sel).addEventListener('blur', saveProject);
      });
    }
  );
}

function applyReadingPrefs() {
  const fs = Number(localStorage.getItem('mo:fontSize') || 19);
  const lh = Number(localStorage.getItem('mo:lineHeight') || 190) / 100;
  const cw = Number(localStorage.getItem('mo:colWidth') || 620);
  document.documentElement.style.setProperty('--editor-font', fs + 'px');
  document.documentElement.style.setProperty('--editor-lh', lh);
  document.documentElement.style.setProperty('--editor-w', cw + 'px');
}

async function exportBook(format) {
  try {
    const r = await api('/api/export?format=' + format);
    const ext = format === 'md' ? 'md' : format === 'html' ? 'html' : 'txt';
    const name = ((state.project && state.project.title) || '作品') + '.' + ext;
    const blob = new Blob([r.content || ''], { type: 'text/plain;charset=utf-8' });
    saveFile(name, blob);
    toast('已导出 ' + name);
  } catch (e) {
    toast('导出失败：' + e.message, 'error');
  }
}

// ---------------------------------------------------------------- 搜索

function openSearch() {
  openOverlay(
    `<div class="modalTitle">搜索全书</div>
     <input class="mInput" id="searchInput" placeholder="输入关键词，搜正文和设定" autocomplete="off">
     <div class="searchResults" id="searchResults"><div class="dim small">输入之后自动搜。</div></div>
     <div class="modalBtns"><button class="mBtn" data-act="close">关闭</button></div>`,
    card => {
      card.querySelector('[data-act="close"]').onclick = closeOverlay;
      const input = card.querySelector('#searchInput');
      const box = card.querySelector('#searchResults');
      let timer = null;
      input.focus();
      input.oninput = () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (!q) {
          box.innerHTML = '<div class="dim small">输入之后自动搜。</div>';
          return;
        }
        timer = setTimeout(async () => {
          try {
            const r = await api('/api/search?q=' + encodeURIComponent(q));
            const hits = r.hits || [];
            if (!hits.length) {
              box.innerHTML = '<div class="dim small">没找到。</div>';
              return;
            }
            box.innerHTML = hits
              .map((h, i) => {
                // 角色结果顺带标出它的分量，省得点进去才知道
                let impTag = '';
                if (h.kind === 'characters' && typeof clampImp === 'function' && state.characters.length) {
                  const c = state.characters.find(x => x.id === h.id);
                  if (c) impTag = `<span class="hitImp">${esc(IMPORTANCE_NAMES[clampImp(c.importance)])}</span>`;
                }
                return `<div class="searchHit" data-i="${i}">
                  <div class="hitTitle">${esc(h.title || '')}<span class="hitKind">${kindName(h.kind)}</span>${impTag}</div>
                  <div class="hitSnip">${esc(h.snippet || '')}</div>
                </div>`;
              })
              .join('');
            box.querySelectorAll('.searchHit').forEach(el => {
              el.onclick = () => {
                const h = hits[Number(el.dataset.i)];
                closeOverlay();
                gotoHit(h);
              };
            });
          } catch (e) {
            box.innerHTML = '<div class="dim small">搜索失败：' + esc(e.message) + '</div>';
          }
        }, 260);
      };
    }
  );
}

function kindName(k) {
  return { text: '正文', node: '大纲', characters: '角色', plots: '情节', items: '物品', world: '世界' }[k] || k;
}

function gotoHit(h) {
  if (h.kind === 'text' || h.kind === 'node') {
    switchView('tree');
    setTimeout(() => {
      const node = nodeById(h.id);
      if (!node) return;
      // 展开父级
      for (const p of pathOf(h.id)) state.collapsed.delete(p.id);
      renderTreeList();
      if (node.type === 'folder') showNodeInfo(node.id);
      else openNode(h.id);
    }, 80);
    return;
  }
  if (h.kind === 'world') {
    switchView('world');
    setTimeout(() => openWorldNode(h.id), 80);
    return;
  }
  if (h.kind === 'characters' || h.kind === 'items') {
    switchView(h.kind);
    setTimeout(() => openCard(h.kind, h.id), 80);
    return;
  }
  if (h.kind === 'plots') {
    switchView('plots');
    setTimeout(() => openCard('plots', h.id), 80);
  }
}

// ---------------------------------------------------------------- 服务端事件

function onServerEvent(msg) {
  if (msg.type === 'text' && msg.id === state.nodeId && msg.origin !== CLIENT_ID) {
    if (state.dirty) {
      toast('这一章刚在别的设备上被改过，你这里也有改动', 'error');
    } else {
      refreshCurrentText();
    }
    return;
  }
  if (msg.type === 'nodes' || msg.type === 'world' || msg.type === 'cards') {
    refreshQuietly(msg.type);
  }
}

let refreshTimer = null;
function refreshQuietly(kind) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      if (kind === 'nodes') {
        await loadNodes();
        if (currentView === 'tree') renderTreeList();
        if (state.view === 'stats' || currentView === 'stats') renderStats();
      } else if (kind === 'world') {
        await loadWorld();
        if (currentView === 'world') renderWorldList();
      } else if (kind === 'cards') {
        await loadCards('characters');
        await loadCards('items');
        await loadCards('plots');
        if (['characters', 'items', 'plots'].includes(currentView)) renderCardList(currentView);
      }
    } catch (e) {
      /* ignore */
    }
  }, 400);
}

async function refreshCurrentText() {
  if (!state.nodeId) return;
  try {
    const r = await api('/api/text/' + state.nodeId);
    if ($('#editor').value !== r.content) {
      const ed = $('#editor');
      const pos = ed.selectionStart;
      ed.value = r.content || '';
      currentContent = r.content || '';
      currentRevision = r.revision || 0;
      updateCounters();
      flashSaved('已同步', 'ok');
      try {
        ed.selectionStart = ed.selectionEnd = Math.min(pos, ed.value.length);
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 启动

async function boot() {
  await loadProject();
  await loadNodes();
  applyReadingPrefs();
  connectSSE();

  if (!state.nodeId) {
    const last = sessionStorage.getItem('mo:last');
    const node = last ? nodeById(last) : null;
    if (node && node.type === 'text') state.nodeId = node.id;
  }

  // 上次读到哪没记住（换了设备、清了缓存、刚导入），就自动落在第一个能写的章节上，
  // 总比一进来对着空白标题发呆好。
  if (!nodeById(state.nodeId)) {
    const first = firstWritable();
    if (first) {
      state.nodeId = first.id;
      for (const p of pathOf(first.id)) state.collapsed.delete(p.id);
    }
  }

  // 刷新一下不该把人踢回大纲页：记住上次待的视图
  const lastView = sessionStorage.getItem('mo:view');
  const knownViews = ['tree', 'text', 'characters', 'plots', 'world', 'mind', 'net', 'items', 'stats'];
  // 「思维」和「关系网」在手机上是藏起来的（屏幕太窄，图根本展不开）。
  // 以前在电脑上停在这两个视图、换成手机打开时会卡在里面出不去，这里兜一下。
  let startView = knownViews.includes(lastView) ? lastView : 'tree';
  if (window.innerWidth <= 900 && (startView === 'mind' || startView === 'net')) startView = 'tree';
  switchView(startView);

  const node = nodeById(state.nodeId);
  if (node) {
    for (const p of pathOf(node.id)) state.collapsed.delete(p.id);
    if (!lastView || lastView === 'tree') await openNode(node.id, { keepScroll: true });
  }
}

function bindGlobal() {
  $$('.railBtn[data-view]').forEach(btn => {
    btn.onclick = () => {
      switchView(btn.dataset.view);
    };
  });
  $('#railSettings').onclick = openSettings;
  $('#railSearch').onclick = openSearch;
  // 角色视图标题旁边那个「关系网」小门
  const netBtn = $('#btnNet');
  if (netBtn) netBtn.onclick = () => switchView('net');

  $('#btnNew').onclick = () => {
    if (currentView === 'tree') {
      const cur = nodeById(state.nodeId);
      // 正在某个分组里就建在分组里，否则跟当前章并排
      const target = cur && cur.type === 'text' ? cur.parentId || null : state.nodeId || null;
      createNode(target, 'text', true);
      return;
    }
    if (currentView === 'text') {
      // 正文视图：新建的章落进「点亮的卷」；没点亮就跟着当前章节走。
      // 打上 inText 标记，这样大纲那边原来的结构节点一个都不会被卷进来。
      createNode(textVolSel || textVolOf(state.nodeId), 'text', true, true);
      return;
    }
    if (currentView === 'characters' || currentView === 'items' || currentView === 'plots') {
      createCard(currentView);
      return;
    }
    if (currentView === 'world') {
      const cur = state.worldId ? state.world.find(n => n.id === state.worldId) : null;
      createWorldNode(cur ? cur.parentId : null);
      return;
    }
    if (currentView === 'stats') {
      toast('统计页没有可新建的东西');
    }
  };

  const newFolderBtn = $('#btnNewFolder');
  if (newFolderBtn) newFolderBtn.onclick = () => {
    if (currentView === 'tree') {
      // 建在当前所在的卷里，跟当前节点并排
      createNode(textVolOf(state.nodeId), 'folder', false);
      return;
    }
    if (currentView === 'text') {
      // 正文视图里「分组」就是一卷，直接建在顶层；打上 inText 就不会跑进大纲
      createNode(null, 'folder', false, true);
      return;
    }
    toast('这个视图没有分组');
  };

  $('#btnToggleList').onclick = () => document.body.classList.toggle('listOpen');
  $$('.btnToggleList').forEach(b => {
    b.onclick = () => document.body.classList.toggle('listOpen');
  });
  const emptyNew = $('#btnEmptyNew');
  if (emptyNew) emptyNew.onclick = () => $('#btnNew').click();
  $('#scrim').onclick = () => document.body.classList.remove('listOpen');

  // 桌面快捷键
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      openSearch();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      if (currentView === 'tree') {
        e.preventDefault();
        $('#btnNew').click();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      if (state.view === 'tree' && state.nodeId) {
        e.preventDefault();
        flushSave(true);
      }
    }
  });

  // 双击行标题改名
  $('#listBody').addEventListener('dblclick', async e => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id || row.dataset.wid;
    if (!id) return;
    if (row.dataset.id) {
      const node = nodeById(id);
      if (!node) return;
      const v = await promptDialog('重命名', '名字', node.title);
      if (v === null || !v.trim()) return;
      await api('/api/nodes/' + id, { method: 'PATCH', body: { title: v.trim() } });
      await loadNodes();
      renderTreeList();
      if (state.nodeId === id) $('#docTitle').value = v.trim();
    }
  });

  // 离开页面
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stashLocal(true);
      if (state.dirty) flushSave(true);
      if (state.nodeId) sessionStorage.setItem('mo:last', state.nodeId);
    }
  });

  window.addEventListener('pagehide', () => {
    stashLocal(true);
    if (state.nodeId) sessionStorage.setItem('mo:last', state.nodeId);
    if (!state.dirty || !state.nodeId) return;
    const node = nodeById(state.nodeId);
    if (!node) return;
    try {
      const body = JSON.stringify({
        content: $('#editor').value,
        title: $('#docTitle').value,
        origin: CLIENT_ID
      });
      navigator.sendBeacon('/api/text/' + state.nodeId + '/beacon', new Blob([body], { type: 'application/json' }));
    } catch (e) {
      /* ignore */
    }
  });

  window.addEventListener('resize', () => {
    if (innerWidth > 900) document.body.classList.remove('listOpen');
  });
}

function confirmNewType() {
  // 默认建章节；按住 Alt 建卷（桌面），手机上走行内菜单
  return 'text';
}

// ---------------------------------------------------------------- 入口

async function main() {
  bindLogin();
  bindGlobal();
  bindTree();
  bindWorldView();
  bindMindView();
  if (typeof bindNetView === 'function') bindNetView();
  initUiZoom();
  bindShelf();
  bindEditor();

  unauthorizedHandler = () => {
    $('#login').hidden = false;
    $('#app').hidden = true;
    toast('登录过期了，重新进一下', 'error');
  };

  const ready = await initLogin();
  if (ready) {
    try {
      await boot();
    } catch (e) {
      if (e.message === '未登录') return;
      toast('打不开：' + e.message, 'error');
    }
  }
}

document.addEventListener('DOMContentLoaded', main);
