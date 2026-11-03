'use strict';
/* 写作统计 */

function dayKey(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function renderStats() {
  const s = state.stats || { days: {}, total: 0, perNode: {}, today: 0, streak: 0 };
  const days = s.days || {};
  const today = s.today || 0;
  const goal = (state.project && state.project.goal && state.project.goal.daily) || 0;
  const pct = goal > 0 ? Math.min(100, Math.round((today / goal) * 100)) : 0;

  // 最近 30 天
  const bars = [];
  let max = 1;
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = dayKey(d);
    const v = days[k] || 0;
    max = Math.max(max, v);
    bars.push({ key: k, value: v, label: k.slice(5).replace('-', '/'), dow: d.getDay() });
  }

  const barHtml = bars
    .map((b, i) => {
      const h = Math.max(2, Math.round((b.value / max) * 100));
      const isToday = b.key === dayKey(new Date());
      // 30 根柱子挤在一起，日期全写就糊成一条线：每 5 天标一次，今天必标
      const showLab = isToday || i % 5 === 0;
      return `<div class="barCol ${isToday ? 'today' : ''}" title="${b.key}　${fmtNum(b.value)} 字">
                <div class="barVal">${b.value ? fmtNum(b.value) : ''}</div>
                <div class="bar" style="height:${h}%"></div>
                <div class="barLab">${showLab ? b.label : ''}</div>
              </div>`;
    })
    .join('');

  // 字数排行
  const ranking = (state.nodes || [])
    .filter(n => n.type === 'text' && (n.chars || 0) > 0)
    .sort((a, b) => (b.chars || 0) - (a.chars || 0))
    .slice(0, 12)
    .map(
      n => `<div class="rankRow" data-id="${n.id}">
              <span class="rankName">${esc(n.title || '未命名')}</span>
              <span class="rankVal">${fmtNum(n.chars)}</span>
            </div>`
    )
    .join('');

  const totalDays = Object.keys(days).filter(k => (days[k] || 0) > 0).length;
  const avg = totalDays > 0 ? Math.round(Object.values(days).reduce((a, b) => a + b, 0) / totalDays) : 0;

  $('#statsBody').innerHTML = `
    <div class="statsScroll">
      <div class="statCards">
        <div class="statCard">
          <div class="statLabel">今天写了</div>
          <div class="statValue">${fmtNum(today)}<span class="statUnit">字</span></div>
          ${goal > 0 ? `<div class="statGoalBar"><div class="statGoalFill" style="width:${pct}%"></div></div>
          <div class="statSub">目标 ${fmtNum(goal)} · ${pct}%</div>` : '<div class="statSub">还没设目标</div>'}
        </div>
        <div class="statCard">
          <div class="statLabel">全书字数</div>
          <div class="statValue">${fmtNum(s.total)}<span class="statUnit">字</span></div>
          <div class="statSub">${state.nodes.filter(n => n.type === 'text').length} 章 · ${state.nodes.filter(n => n.type === 'folder').length} 卷 · ${state.nodes.filter(n => n.type === 'text' && (n.chars || 0) > 0).length} 章有字</div>
        </div>
        <div class="statCard">
          <div class="statLabel">连续写作</div>
          <div class="statValue">${s.streak}<span class="statUnit">天</span></div>
          <div class="statSub">共 ${totalDays} 天有记录</div>
        </div>
        <div class="statCard">
          <div class="statLabel">日均</div>
          <div class="statValue">${fmtNum(avg)}<span class="statUnit">字</span></div>
          <div class="statSub">按有记录的天数算</div>
        </div>
      </div>

      <div class="statSection">
        <div class="statSectionTitle">最近 30 天</div>
        <div class="barChart">${barHtml}</div>
      </div>

      <div class="statSection">
        <div class="statSectionTitle">最长的几章</div>
        <div class="rankList">${ranking || '<div class="dim">还没有字数记录</div>'}</div>
      </div>
    </div>`;

  $$('#statsBody .rankRow').forEach(el => {
    el.onclick = () => {
      const id = el.dataset.id;
      switchView('tree');
      setTimeout(() => openNode(id), 60);
    };
  });
}

async function enterStatsView() {
  state.view = 'stats';
  await loadStats();
  renderStats();
  $('#viewEditor').hidden = true;
  $('#viewCards').hidden = true;
  $('#viewPlot').hidden = true;
  $('#viewWorld').hidden = true;
  $('#viewStats').hidden = false;
  $('#viewEmpty').hidden = true;
  $('#paneTitle').textContent = '统计';
  $('#listBody').innerHTML =
    '<div class="listEmpty">左侧是统计面板。<br><br>字数每存一次就会累加。</div>';
}
