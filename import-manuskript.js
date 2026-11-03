'use strict';
/**
 * 把 Manuskript 工程导入成茉的写作台数据格式。
 *
 * 用法：node import-manuskript.js "<Manuskript 工程目录>"
 *
 * 只读源工程，不改它。目标写在 ./data 下；已有的 data 会先改名备份。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SRC = process.argv[2];
if (!SRC) {
  console.error('用法: node import-manuskript.js "<Manuskript 工程目录>" [目标书 id，默认 mo]');
  process.exit(1);
}
const BOOK_ID = process.argv[3] || 'mo';
const DATA = path.join(__dirname, 'data', 'books', BOOK_ID);
const TEXT_DIR = path.join(DATA, 'text');
const HIST_DIR = path.join(DATA, 'history');

const stamp = () => new Date().toISOString();

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

/** 解析 Manuskript 的 "key: value" 头部；多行值靠缩进续行 */
function parseHeader(text) {
  const out = {};
  if (!text) return out;
  const lines = text.split(/\r?\n/);
  let lastKey = null;
  for (const line of lines) {
    if (/^\s*$/.test(line)) continue;
    const m = /^([^:\s][^:]*?):\s*(.*)$/.exec(line);
    if (m) {
      const k = m[1].trim();
      out[k] = m[2];
      lastKey = k;
    } else if (lastKey && /^\s+/.test(line)) {
      out[lastKey] = (out[lastKey] || '') + '\n' + line.trim();
    }
  }
  return out;
}

/** 文本节点：头部之后（第一个空行起）就是正文 */
function splitHeadBody(text) {
  if (!text) return { head: {}, body: '' };
  const idx = text.search(/\r?\n\s*\r?\n/);
  if (idx < 0) return { head: parseHeader(text), body: '' };
  return {
    head: parseHeader(text.slice(0, idx)),
    body: text.slice(idx).replace(/^\s*\r?\n/, '')
  };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '')
    .replace(/&amp;/g, '&');
}

/** 极简 OPML 解析：只认 outline 的 name/ID/description 与嵌套 */
function parseOPML(xml) {
  const root = { children: [] };
  const stack = [root];
  const re = /<(\/?)outline\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    const closing = m[1] === '/';
    const attrs = m[2] || '';
    const selfClose = m[3] === '/';
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const get = name => {
      const r = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i').exec(attrs);
      return r ? decodeEntities(r[1]) : '';
    };
    const node = {
      name: get('name') || get('text') || '未命名',
      srcId: get('ID'),
      description: get('description') || get('_note'),
      children: []
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root.children;
}

let seq = 0;
const uid = prefix => prefix + (++seq).toString(36) + crypto.randomInt(4096).toString(36);
const usedIds = new Set();
function uidFrom(prefix, wanted) {
  let base = prefix + String(wanted || '').replace(/[^\w-]/g, '');
  if (!wanted) base = prefix + 'x';
  let id = base;
  let n = 1;
  while (usedIds.has(id)) id = base + '-' + n++;
  usedIds.add(id);
  return id;
}

// ---------------------------------------------------------------- 大纲

function walkOutline(dir, parentId, depth, nodes, texts) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  const dirs = entries.filter(e => e.isDirectory());

  const items = [];
  for (const d of dirs) {
    const sub = path.join(dir, d.name);
    const head = parseHeader(read(path.join(sub, 'folder.txt')));
    if (!head.ID && !head.title) continue;
    // Manuskript 的层级就是目录层级：目录里还有子目录 = 分组，没有 = 具体的章节
    let hasChild = false;
    try {
      hasChild = fs.readdirSync(sub, { withFileTypes: true }).some(e => e.isDirectory());
    } catch (e) {
      /* 读不动就当叶子 */
    }
    const m = /^(\d+)/.exec(String(d.name));
    items.push({
      kind: hasChild ? 'folder' : 'text',
      sortKey: m ? parseInt(m[1], 10) : 9999,
      dir: sub,
      head
    });
  }
  items.sort((a, b) => a.sortKey - b.sortKey);

  let order = 0;
  for (const it of items) {
    const id = uidFrom('n', it.head.ID);
    const isText = it.kind === 'text';
    const node = {
      id,
      parentId,
      type: it.kind,
      title: (it.head.title || '未命名').trim(),
      order: ++order,
      summarySentence: it.head.summarySentence || '',
      // Manuskript 里正文通常写在节点的「详细摘要」(summaryFull) 里：
      // 叶子节点直接用它当正文，分组的 summaryFull 才是真摘要。
      summaryFull: isText ? '' : it.head.summaryFull || '',
      status: parseInt(it.head.status, 10),
      // Manuskript 用 0/1/2 三态表示「是否参与合并导出」，2 才是纳入
      compile: String(it.head.compile) === '2' || String(it.head.compile).toLowerCase() === 'true',
      labels: [],
      goal: parseInt(it.head.goal, 10) || 0,
      createdAt: stamp(),
      updatedAt: stamp()
    };
    if (!Number.isFinite(node.status)) delete node.status;
    if (it.head.labels) node.labels = String(it.head.labels).split(',').map(s => s.trim()).filter(Boolean);
    nodes.push(node);
    if (isText) {
      texts[id] = (it.head.summaryFull || '').trim();
    } else {
      walkOutline(it.dir, id, depth + 1, nodes, texts);
    }
  }
}

// ---------------------------------------------------------------- 角色

function parseCharacter(file) {
  const text = read(file);
  if (!text) return null;
  const head = parseHeader(text);
  if (!head.Name && !head.ID) return null;
  const known = new Set([
    'Name', 'ID', 'Importance', 'POV', 'Motivation', 'Goal', 'Conflict',
    'Epiphany', 'Phrase Summary', 'Paragraph Summary', 'Full Summary', 'Color'
  ]);
  const custom = {};
  for (const k of Object.keys(head)) {
    if (!known.has(k)) custom[k] = head[k];
  }
  return {
    id: uidFrom('c', head.ID),
    name: (head.Name || '未命名').trim(),
    importance: parseInt(head.Importance, 10) || 0,
    pov: /true/i.test(head.POV || ''),
    motivation: head.Motivation || '',
    goal: head.Goal || '',
    conflict: head.Conflict || '',
    epiphany: head.Epiphany || '',
    phraseSummary: head['Phrase Summary'] || '',
    paragraphSummary: head['Paragraph Summary'] || '',
    summaryFull: head['Full Summary'] || '',
    color: head.Color || '',
    custom,
    order: 0,
    createdAt: stamp(),
    updatedAt: stamp()
  };
}

// ---------------------------------------------------------------- 情节

function parsePlots(file) {
  const xml = read(file);
  if (!xml) return [];
  const out = [];
  const re = /<plot\b([^>]*?)\/?>/g;
  let m;
  let i = 0;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const get = name => {
      const r = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i').exec(attrs);
      return r ? decodeEntities(r[1]) : '';
    };
    out.push({
      id: uidFrom('p', get('ID')),
      name: get('name') || '未命名情节',
      importance: parseInt(get('importance'), 10) || 0,
      characters: get('characters')
        ? get('characters').split(',').map(s => s.trim()).filter(Boolean).map(n => 'c' + n)
        : [],
      description: get('description'),
      result: get('result'),
      order: ++i,
      createdAt: stamp(),
      updatedAt: stamp()
    });
  }
  return out;
}

// ---------------------------------------------------------------- 世界

function buildWorld(nodes, parentId, list, depth) {
  let order = 0;
  for (const n of list) {
    const id = uidFrom('w', n.srcId);
    nodes.push({
      id,
      parentId,
      title: n.name || '未命名',
      content: n.description || '',
      order: ++order,
      createdAt: stamp(),
      updatedAt: stamp()
    });
    if (n.children && n.children.length) buildWorld(nodes, id, n.children, depth + 1);
  }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const src = path.resolve(SRC);
  console.log('源工程:', src);

  const infos = parseHeader(read(path.join(src, 'infos.txt')));
  const labelsRaw = read(path.join(src, 'labels.txt')) || '';
  const statusRaw = read(path.join(src, 'status.txt')) || '';

  const labels = [];
  for (const line of labelsRaw.split(/\r?\n/)) {
    const m = /^(.+?):\s*(#?[0-9a-fA-F]{3,8})\s*$/.exec(line.trim());
    if (m) labels.push({ name: m[1].trim(), color: m[2] });
  }
  const statuses = statusRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // 大纲
  const nodes = [];
  const texts = {};
  walkOutline(path.join(src, 'outline'), null, 0, nodes, texts);

  // 角色
  const characters = [];
  const charDir = path.join(src, 'characters');
  for (const f of (fs.existsSync(charDir) ? fs.readdirSync(charDir) : [])) {
    if (!f.toLowerCase().endsWith('.txt')) continue;
    const c = parseCharacter(path.join(charDir, f));
    if (c) characters.push(c);
  }
  characters.sort((a, b) => a.importance === b.importance
    ? a.name.localeCompare(b.name, 'zh')
    : b.importance - a.importance);
  characters.forEach((c, i) => { c.order = i + 1; });

  // 情节
  const plots = parsePlots(path.join(src, 'plots.xml'));

  // 世界
  const world = [];
  const opml = read(path.join(src, 'world.opml'));
  if (opml) buildWorld(world, null, parseOPML(opml), 0);

  // 备份旧 data
  if (fs.existsSync(DATA)) {
    const bak = path.join(__dirname, 'data-old-' + Date.now());
    fs.renameSync(DATA, bak);
    console.log('旧数据已备份到:', path.basename(bak));
  }
  await fsp.mkdir(TEXT_DIR, { recursive: true });
  await fsp.mkdir(HIST_DIR, { recursive: true });

  const project = {
    title: infos.Title || '未命名作品',
    series: infos.Serie || '',
    author: infos.Author || '',
    license: infos.License || '',
    labels,
    statuses: statuses.length ? statuses : ['待作', '初稿', '次稿', '终稿'],
    goal: { daily: 2000, total: 0 },
    createdAt: stamp(),
    updatedAt: stamp()
  };

  const write = async (name, obj) =>
    fsp.writeFile(path.join(DATA, name), JSON.stringify(obj, null, 2), 'utf8');

  await write('project.json', project);
  await write('nodes.json', nodes);
  await write('characters.json', characters);
  await write('plots.json', plots);
  await write('world.json', world);
  await write('items.json', []);
  await write('stats.json', { days: {} });

  let textCount = 0;
  for (const [id, body] of Object.entries(texts)) {
    if (!body) continue;
    await fsp.writeFile(path.join(TEXT_DIR, id + '.md'), body, 'utf8');
    textCount++;
  }

  console.log('');
  console.log('导入完成');
  console.log('  大纲节点: ' + nodes.length + '（其中正文非空: ' + textCount + '）');
  console.log('  角色卡:   ' + characters.length);
  console.log('  情节:     ' + plots.length);
  console.log('  世界节点: ' + world.length);
  console.log('  标签:     ' + labels.map(l => l.name).join('、'));
  console.log('  状态:     ' + project.statuses.join('、'));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
