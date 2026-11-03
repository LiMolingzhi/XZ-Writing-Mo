'use strict';
/**
 * 茉的写作台 —— 局域网写作服务
 * 零依赖，仅用 Node 内置模块。
 *
 * 目录约定（一本书一个目录，书架上的每一本都是这样一份）
 *   data/books/<书id>/project.json     作品信息、标签、状态、目标
 *   data/books/<书id>/nodes.json       大纲树（folder 卷章 / text 正文）
 *   data/books/<书id>/world.json       世界观树
 *   data/books/<书id>/characters.json  角色卡
 *   data/books/<书id>/plots.json       情节线
 *   data/books/<书id>/items.json       物品
 *   data/books/<书id>/stats.json       每日字数
 *   data/books/<书id>/text/<id>.md     正文，纯文本
 *   data/books/<书id>/history/<id>/    正文历史快照
 *   data/books/<书id>/trash/           删掉的东西，不当场销毁
 *   data/books-trash/<id>-<时间>/      从书架上拿掉的书（不是真删）
 *   data/access.log / server.log       服务级日志，不属于任何一本书
 *
 * 三条铁律
 *   1. 正文永远是纯 .md，任何编辑器都能打开
 *   2. 每次写入：临时文件 -> fsync -> 原子 rename，不会写一半
 *   3. 关窗口那一下也要存成功：beacon 无条件写入，遇冲突先留快照
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { AsyncLocalStorage } = require('node:async_hooks');

const ROOT = __dirname;

/* ─────────────────────────── 书架：一本书一个目录 ───────────────────────────
 * data/books/<书 id>/   每本书的全部内容（大纲、角色、正文、备份……）
 * data/access.log       服务级日志，不属于任何一本书
 *
 * 当前正在看哪本，由每个请求自己决定（前端在 x-book 头里带）。
 * 用 AsyncLocalStorage 而不是一个全局变量：两个人同时翻不同的书时，
 * 各自的 await 交错执行，全局变量会被后一个请求改掉，前面那个就读串了。
 */
const BOOKS_DIR = path.join(ROOT, 'data', 'books');
const bookCtx = new AsyncLocalStorage();
const DEFAULT_BOOK = 'mo';
const BOOK_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function bookId() {
  const v = bookCtx.getStore();
  return v && BOOK_ID_RE.test(v) ? v : DEFAULT_BOOK;
}
function bookDir(id) {
  return path.join(BOOKS_DIR, id || bookId());
}
function dataDir() {
  return bookDir();
}
const textDir = () => path.join(dataDir(), 'text');
const histDir = () => path.join(dataDir(), 'history');
const trashDir = () => path.join(dataDir(), 'trash');
const backupDir = () => path.join(dataDir(), 'backups');

const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PASSWORD_FILE = path.join(ROOT, '密码.txt');

const DEFAULT_PORT = 7788;
const SESSION_DAYS = 30;
const COOKIE_NAME = 'mo_token';
const MAX_BODY = 8 * 1024 * 1024;
const SNAPSHOT_INTERVAL_MS = 30 * 1000;
const MAX_SNAPSHOTS = 400;
const BACKUP_KEEP_DAYS = 30;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_TRIES = 8;

// ---------------------------------------------------------------- 基础工具

/** 首次启动时用的默认密码。改这里就是改「第一次跑起来」的密码。 */
const DEFAULT_PASSWORD = '12345678';

function makePassword(len = 8) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}

const nowISO = () => new Date().toISOString();

function localDay(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function rid(prefix = 'n') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

/** 字数：和前端同一口径——非空白字符数 */
function countChars(text) {
  let n = 0;
  for (const ch of String(text || '')) {
    if (!/\s/.test(ch)) n++;
  }
  return n;
}

function countAllChars(text) {
  return [...String(text || '')].length;
}

async function atomicWrite(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

const writeJSON = (file, obj) => atomicWrite(file, JSON.stringify(obj, null, 2));

// ---------------------------------------------------------------- 配置

let CONFIG = {};
function loadConfig() {
  try {
    let raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    // 用记事本/PowerShell 存过的文件会带 BOM，JSON.parse 见到它就直接抛错。
    // 不剥掉的话会静默退回默认配置，然后把你手改的 port 覆盖回去——
    // 表现就是「我明明改了端口，重启还是老端口」。
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    CONFIG = JSON.parse(raw);
  } catch (e) {
    CONFIG = {};
  }
}
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2), 'utf8');
}
function ensureConfig() {
  loadConfig();
  let changed = false;
  if (!CONFIG.salt) {
    CONFIG.salt = crypto.randomBytes(16).toString('hex');
    changed = true;
  }
  if (!CONFIG.passwordHash) {
    const pw = DEFAULT_PASSWORD;
    CONFIG.passwordHash = hashPassword(pw, CONFIG.salt);
    try {
      fs.writeFileSync(
        PASSWORD_FILE,
        '茉 · 写作台 初始密码\n\n' +
          '    密码：  ' + pw + '\n\n' +
          '这是默认密码。第一件事就是去「设置 → 密码」把它改掉。\n' +
          '改完就可以把这个文件删掉。\n',
        'utf8'
      );
    } catch (e) {
      /* ignore */
    }
    changed = true;
  }
  if (!CONFIG.secret) {
    CONFIG.secret = crypto.randomBytes(32).toString('hex');
    changed = true;
  }
  if (!CONFIG.port) {
    CONFIG.port = DEFAULT_PORT;
    changed = true;
  }
  if (CONFIG.bind === undefined) {
    CONFIG.bind = '0.0.0.0';
    changed = true;
  }
  if (!Array.isArray(CONFIG.allowlist)) {
    CONFIG.allowlist = [];
    changed = true;
  }
  if (changed) saveConfig();
}

// ---------------------------------------------------------------- 会话

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signToken(payload) {
  const data = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', CONFIG.secret).update(data).digest());
  return data + '.' + mac;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const data = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const want = b64url(crypto.createHmac('sha256', CONFIG.secret).update(data).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(unb64url(data).toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[COOKIE_NAME]);
}

function authCookie() {
  const payload = { exp: Date.now() + SESSION_DAYS * 86400 * 1000, u: 'mo' };
  const token = signToken(payload);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

// 登录限流
const attempts = new Map();
function tooManyTries(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_TRIES;
}
function noteFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, until: 0 };
  rec.count++;
  rec.until = Date.now() + LOGIN_WINDOW_MS;
  attempts.set(ip, rec);
}

// ---------------------------------------------------------------- HTTP 工具

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBodyRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBodyJSON(req) {
  const raw = await readBodyRaw(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

function clientIP(req) {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

// ---------------------------------------------------------------- SSE

const clients = new Set();
function broadcast(obj) {
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of clients) {
    try {
      res.write(line);
    } catch (e) {
      clients.delete(res);
    }
  }
}

// ---------------------------------------------------------------- 数据访问

const FILES = {
  project: () => path.join(dataDir(), 'project.json'),
  nodes: () => path.join(dataDir(), 'nodes.json'),
  world: () => path.join(dataDir(), 'world.json'),
  characters: () => path.join(dataDir(), 'characters.json'),
  plots: () => path.join(dataDir(), 'plots.json'),
  relations: () => path.join(dataDir(), 'relations.json'),
  items: () => path.join(dataDir(), 'items.json'),
  stats: () => path.join(dataDir(), 'stats.json')
};

// 关系网第一次打开时给的一组默认「颜色 = 含义」，
// 用户之后可以改成自己认得的说法，存进 relations.json 的 types 里。
const NET_TYPES_DEFAULT = [
  { name: '朋友', color: '#5aa06a' },
  { name: '家人', color: '#5b8fd9' },
  { name: '爱人', color: '#d96b9a' },
  { name: '敌人', color: '#d95f5f' },
  { name: '师生', color: '#b6892e' },
  { name: '同伴', color: '#6aa6a6' },
  { name: '其他', color: '#7a736a' }
];

const DEFAULT_PROJECT = {
  title: '未命名作品',
  series: '',
  author: '',
  license: '',
  labels: [
    { name: '创意', color: '#ffff00' },
    { name: '笔记', color: '#00ff00' },
    { name: '章节', color: '#0000ff' },
    { name: '场景', color: '#ff0000' },
    { name: '研究', color: '#00ffff' }
  ],
  statuses: ['待作', '初稿', '次稿', '终稿'],
  goal: { daily: 2000, total: 0 },
  createdAt: nowISO(),
  updatedAt: nowISO()
};

let nodesCache = null;
let cacheBook = null;
/* 换了一本书，这些缓存必须立刻作废，否则 A 书的大纲会灌进 B 书 */
function ensureBookCache() {
  const k = bookId();
  if (cacheBook !== k) {
    cacheBook = k;
    nodesCache = null;
    statsCache = null;
  }
}
async function getNodes() {
  ensureBookCache();
  if (!nodesCache) nodesCache = await readJSON(FILES.nodes(), []);
  return nodesCache;
}
async function saveNodes(nodes) {
  ensureBookCache();
  nodesCache = nodes;
  await writeJSON(FILES.nodes(), nodes);
  if (statsTimer) clearTimeout(statsTimer);
  statsTimer = setTimeout(() => flushStatsCache(), 800);
}

async function getProject() {
  ensureBookCache();
  return readJSON(FILES.project(), DEFAULT_PROJECT);
}
async function getStats() {
  ensureBookCache();
  return readJSON(FILES.stats(), { days: {} });
}

let statsTimer = null;
let statsCache = null;
async function addWords(n) {
  if (!n || n < 0) return;
  ensureBookCache();
  if (!statsCache) statsCache = await getStats();
  if (!statsCache.days) statsCache.days = {};
  const day = localDay();
  statsCache.days[day] = (statsCache.days[day] || 0) + n;
  if (statsTimer) clearTimeout(statsTimer);
  statsTimer = setTimeout(() => flushStatsCache(), 800);
}
async function flushStatsCache() {
  statsTimer = null;
  if (!statsCache) return;
  try {
    await writeJSON(FILES.stats(), statsCache);
  } catch (e) {
    /* ignore */
  }
}

const textPath = id => path.join(textDir(), id + '.md');
const histPath = id => path.join(histDir(), id);

// ---------------------------------------------------------------- 书架
// 这里全部显式传 id，不走 bookCtx —— 书架要一眼看全所有书。

const BOOK_TRASH_DIR = path.join(ROOT, 'data', 'books-trash');

/* 封面：就放在书的目录里，cover.jpg / png / webp / gif，哪个在就用哪个。
   这样子备份、搬家、打包全都天然带上，不需要额外的数据库字段。 */
const COVER_EXTS = ['.jpg', '.png', '.webp', '.gif'];
const COVER_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const COVER_MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

/* 书架顺序：单独存一份 data/books-order.json，不动书本身。
   没被列进 order 的书（比如以后新建的）排在已排序的后面，仍按修改时间。 */
const BOOK_ORDER_FILE = path.join(ROOT, 'data', 'books-order.json');

async function readBooksOrder() {
  try {
    const j = JSON.parse(await fsp.readFile(BOOK_ORDER_FILE, 'utf8'));
    return Array.isArray(j.order) ? j.order.filter(x => typeof x === 'string') : [];
  } catch (e) {
    return [];
  }
}

async function saveBooksOrder(order) {
  await fsp.mkdir(path.join(ROOT, 'data'), { recursive: true });
  await atomicWrite(BOOK_ORDER_FILE, JSON.stringify({ order, updatedAt: nowISO() }, null, 2));
}

async function findCover(id) {
  const dir = path.join(BOOKS_DIR, id);
  for (const ext of COVER_EXTS) {
    const file = path.join(dir, 'cover' + ext);
    try {
      const st = await fsp.stat(file);
      if (st.isFile()) return { file, ext, size: st.size, mtime: st.mtimeMs };
    } catch (e) {
      /* 这个格式没有，试下一个 */
    }
  }
  return null;
}

async function readBookMeta(id) {
  const meta = { id, title: '未命名作品', series: '', author: '', chars: 0, chapters: 0, mtime: 0 };
  try {
    const p = JSON.parse(await fsp.readFile(path.join(BOOKS_DIR, id, 'project.json'), 'utf8'));
    meta.title = p.title || meta.title;
    meta.series = p.serie || p.series || '';
    meta.author = p.author || '';
    meta.email = p.email || '';
    meta.license = p.license || '';
  } catch (e) {
    /* 还没建过 project.json 的书也用默认标题 */
  }
  try {
    const nodes = JSON.parse(await fsp.readFile(path.join(BOOKS_DIR, id, 'nodes.json'), 'utf8'));
    for (const n of nodes) {
      if (n.type === 'text') {
        meta.chapters++;
        meta.chars += n.chars || 0;
      }
    }
  } catch (e) {
    /* 空书 */
  }
  try {
    meta.mtime = (await fsp.stat(path.join(BOOKS_DIR, id, 'nodes.json'))).mtimeMs;
  } catch (e) {
    try {
      meta.mtime = (await fsp.stat(path.join(BOOKS_DIR, id))).mtimeMs;
    } catch (e2) {
      /* ignore */
    }
  }
  const cov = await findCover(id);
  if (cov) {
    meta.cover = true;
    meta.coverV = Math.round(cov.mtime);
  }
  return meta;
}

async function listAllBooks() {
  let dirs = [];
  try {
    dirs = await fsp.readdir(BOOKS_DIR, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !BOOK_ID_RE.test(d.name)) continue;
    out.push(await readBookMeta(d.name));
  }
  const order = await readBooksOrder();
  out.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return b.mtime - a.mtime;
  });
  return out;
}

/* 建一本书：目录 + 六个空 json + 空目录，结构必须和迁移过来的那本一致 */
async function createBook(id, title) {
  const dir = path.join(BOOKS_DIR, id);
  await fsp.mkdir(path.join(dir, 'text'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'history'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'trash'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'backups'), { recursive: true });
  const proj = Object.assign({}, DEFAULT_PROJECT, {
    title: title || '未命名作品',
    createdAt: nowISO(),
    updatedAt: nowISO()
  });
  await writeJSON(path.join(dir, 'project.json'), proj);
  await writeJSON(path.join(dir, 'nodes.json'), []);
  await writeJSON(path.join(dir, 'world.json'), []);
  await writeJSON(path.join(dir, 'characters.json'), []);
  await writeJSON(path.join(dir, 'plots.json'), []);
  await writeJSON(path.join(dir, 'relations.json'), []);
  await writeJSON(path.join(dir, 'items.json'), []);
  await writeJSON(path.join(dir, 'stats.json'), { days: {} });
  return dir;
}

function newBookId() {
  return 'b' + crypto.randomBytes(5).toString('hex');
}

async function readText(id) {
  try {
    return await fsp.readFile(textPath(id), 'utf8');
  } catch (e) {
    return '';
  }
}

/** 历史快照：按间隔节流，最多留 MAX_SNAPSHOTS 份 */
async function snapshot(id, content, force) {
  if (!content) return;
  const dir = histPath(id);
  try {
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md')).sort();
    if (files.length) {
      const last = files[files.length - 1];
      const ts = parseInt(last.split('-')[0], 10);
      const lastBody = await fsp.readFile(path.join(dir, last), 'utf8');
      if (lastBody === content) return;
      if (!force && Number.isFinite(ts) && Date.now() - ts < SNAPSHOT_INTERVAL_MS) return;
    }
  } catch (e) {
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  }
  const name = Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.md';
  await fsp.writeFile(path.join(dir, name), content, 'utf8');
  try {
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md')).sort();
    if (files.length > MAX_SNAPSHOTS) {
      for (const old of files.slice(0, files.length - MAX_SNAPSHOTS)) {
        await fsp.unlink(path.join(dir, old)).catch(() => {});
      }
    }
  } catch (e) {
    /* ignore */
  }
}

async function listSnapshots(id) {
  try {
    const dir = histPath(id);
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.md'));
    const out = [];
    for (const f of files) {
      const st = await fsp.stat(path.join(dir, f));
      out.push({ file: f, ts: parseInt(f.split('-')[0], 10) || st.mtimeMs, size: st.size });
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------- 树操作

function subtreeIds(nodes, id) {
  const out = [id];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of nodes) {
      if (n.parentId === cur) {
        out.push(n.id);
        stack.push(n.id);
      }
    }
  }
  return out;
}

function normalizeOrders(nodes, parentId) {
  const kids = nodes
    .filter(n => (n.parentId || null) === (parentId || null))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  kids.forEach((n, i) => { n.order = i + 1; });
}

// ---------------------------------------------------------------- 路由

async function handleAPI(req, res, pathname, url) {
  const method = req.method;
  const ip = clientIP(req);

  // 免登录
  if (pathname === '/api/status' && method === 'GET') {
    // 安装包不一定在（开源包里就没有）。前端据此决定要不要摆那两个下载入口，
    // 否则陌生人点开是 404，会以为程序坏了。
    const has = async (n) => {
      try {
        await fsp.access(path.join(ROOT, n));
        return true;
      } catch (e) {
        return false;
      }
    };
    return sendJSON(res, 200, {
      needsLogin: !currentUser(req),
      title: '茉 · 写作台',
      addresses: lanAddresses(),
      hasApk: await has('茉写作.apk'),
      hasSetup: (await has('Setup.exe')) || (await has('卸载茉写作.exe'))
    });
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (tooManyTries(ip)) {
      return sendJSON(res, 429, { error: '尝试太多次了，等十分钟再试' });
    }
    let body;
    try {
      body = await readBodyJSON(req);
    } catch (e) {
      return sendJSON(res, 400, { error: '请求格式有误' });
    }
    const pw = String(body.password || '');
    const hash = hashPassword(pw, CONFIG.salt);
    const a = Buffer.from(hash);
    const b = Buffer.from(CONFIG.passwordHash);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      noteFailure(ip);
      return sendJSON(res, 401, { error: '密码不对' });
    }
    attempts.delete(ip);
    res.setHeader('Set-Cookie', authCookie());
    return sendJSON(res, 200, { ok: true });
  }

  // 以下全部要登录
  const user = currentUser(req);
  if (!user) return sendJSON(res, 401, { error: '请先登录' });

  if (pathname === '/api/me' && method === 'GET') return sendJSON(res, 200, { ok: true });

  // ---- 书架
  // ---- 书架：拖拽排序后保存顺序
  if (pathname === '/api/books/order' && method === 'POST') {
    const body = await readBodyJSON(req);
    const order = Array.isArray(body.order)
      ? body.order.filter(x => typeof x === 'string' && BOOK_ID_RE.test(x))
      : [];
    // 只认真的存在的书，别让前端传错 id 把顺序表写脏
    const alive = [];
    for (const id of order) {
      if (fs.existsSync(path.join(BOOKS_DIR, id))) alive.push(id);
    }
    await saveBooksOrder(alive);
    return sendJSON(res, 200, { ok: true, count: alive.length });
  }

  // ---- 书架：封面（存成书目录里的 cover.jpg/png/webp/gif）
  {
    const cm = /^\/api\/books\/([A-Za-z0-9_-]+)\/cover$/.exec(pathname);
    if (cm && BOOK_ID_RE.test(cm[1])) {
      const id = cm[1];
      const dir = path.join(BOOKS_DIR, id);
      if (!fs.existsSync(dir)) return sendJSON(res, 404, { error: '没有这本书' });

      if (method === 'GET') {
        const cov = await findCover(id);
        if (!cov) return sendJSON(res, 404, { error: '这本书还没设封面' });
        const buf = await fsp.readFile(cov.file);
        res.writeHead(200, {
          'Content-Type': COVER_MIME[cov.ext] || 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
          ETag: '"' + Math.round(cov.mtime) + '-' + cov.size + '"'
        });
        return res.end(buf);
      }

      if (method === 'POST') {
        const body = await readBodyJSON(req);
        const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.data || ''));
        if (!m) return sendJSON(res, 400, { error: '只认 jpg / png / webp / gif 这几种图' });
        const ext = COVER_MIME_EXT[m[1]];
        const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
        if (!buf.length) return sendJSON(res, 400, { error: '这张图是空的' });
        if (buf.length > 5 * 1024 * 1024) return sendJSON(res, 413, { error: '图太大了，换张 5MB 以内的' });
        // 换格式时把旧的那张删掉，免得 jpg 和 png 同时躺着、分不清用哪个
        for (const e of COVER_EXTS) {
          const p = path.join(dir, 'cover' + e);
          if (e !== ext && fs.existsSync(p)) {
            try { await fsp.unlink(p); } catch (err) { /* ignore */ }
          }
        }
        await fsp.writeFile(path.join(dir, 'cover' + ext), buf);
        return sendJSON(res, 200, { ok: true, ext: ext.slice(1) });
      }

      if (method === 'DELETE') {
        for (const e of COVER_EXTS) {
          const p = path.join(dir, 'cover' + e);
          if (fs.existsSync(p)) {
            try { await fsp.unlink(p); } catch (err) { /* ignore */ }
          }
        }
        return sendJSON(res, 200, { ok: true });
      }
    }
  }

  if (pathname === '/api/books' && method === 'GET') {
    return sendJSON(res, 200, { current: bookId(), books: await listAllBooks() });
  }
  if (pathname === '/api/books' && method === 'POST') {
    const body = await readBodyJSON(req);
    const title = String(body.title || '').trim().slice(0, 80) || '未命名作品';
    let id = newBookId();
    while (fs.existsSync(bookDir(id))) id = newBookId();
    await createBook(id, title);
    return sendJSON(res, 200, { ok: true, id });
  }
  {
    const bm = /^\/api\/books\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (bm && BOOK_ID_RE.test(bm[1])) {
      const id = bm[1];
      const dir = path.join(BOOKS_DIR, id);
      if (!fs.existsSync(dir)) return sendJSON(res, 404, { error: '没有这本书' });

      if (method === 'PATCH') {
        const body = await readBodyJSON(req);
        let proj = {};
        try {
          proj = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'));
        } catch (e) {
          proj = Object.assign({}, DEFAULT_PROJECT);
        }
        // 书名必填、其余是附属信息；只改传来的字段，没传的保持原样
        if ('title' in body) {
          const title = String(body.title || '').trim().slice(0, 80);
          if (!title) return sendJSON(res, 400, { error: '书名不能是空的' });
          proj.title = title;
        }
        for (const k of ['series', 'author', 'email', 'license']) {
          if (k in body) proj[k] = String(body[k] || '').trim().slice(0, 160);
        }
        proj.updatedAt = nowISO();
        await writeJSON(path.join(dir, 'project.json'), proj);
        return sendJSON(res, 200, { ok: true });
      }

      if (method === 'DELETE') {
        if (id === DEFAULT_BOOK && (await listAllBooks()).length <= 1) {
          return sendJSON(res, 400, { error: '这是最后一本书了，删了就没地方写字' });
        }
        // 不真删：挪进 books-trash，手滑了还能捞回来
        await fsp.mkdir(BOOK_TRASH_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.rename(dir, path.join(BOOK_TRASH_DIR, id + '-' + stamp));
        return sendJSON(res, 200, { ok: true });
      }
    }
  }

  if (pathname === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; Max-Age=0');
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/password' && method === 'POST') {
    const body = await readBodyJSON(req);
    const oldPw = String(body.old || '');
    const newPw = String(body.next || '');
    if (newPw.length < 4) return sendJSON(res, 400, { error: '新密码至少 4 位' });
    const hash = hashPassword(oldPw, CONFIG.salt);
    const a = Buffer.from(hash);
    const b = Buffer.from(CONFIG.passwordHash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return sendJSON(res, 400, { error: '原密码不对' });
    }
    CONFIG.passwordHash = hashPassword(newPw, CONFIG.salt);
    saveConfig();
    return sendJSON(res, 200, { ok: true });
  }

  // ---- 作品信息
  if (pathname === '/api/project') {
    if (method === 'GET') return sendJSON(res, 200, await getProject());
    if (method === 'PATCH') {
      const body = await readBodyJSON(req);
      const p = await getProject();
      for (const k of ['title', 'series', 'author', 'license']) {
        if (typeof body[k] === 'string') p[k] = body[k];
      }
      if (Array.isArray(body.labels)) p.labels = body.labels;
      if (Array.isArray(body.statuses)) p.statuses = body.statuses;
      if (body.goal && typeof body.goal === 'object') {
        p.goal = {
          daily: Number(body.goal.daily) || 0,
          total: Number(body.goal.total) || 0
        };
      }
      p.updatedAt = nowISO();
      await writeJSON(FILES.project(), p);
      broadcast({ type: 'project', project: p });
      return sendJSON(res, 200, p);
    }
  }

  // ---- 大纲树
  if (pathname === '/api/nodes' && method === 'GET') {
    const nodes = await getNodes();
    const out = [];
    for (const n of nodes) {
      const item = Object.assign({}, n);
      if (n.type === 'text') {
        const t = await readText(n.id);
        item.chars = countChars(t);
        item.totalChars = countAllChars(t);
      } else {
        const ids = subtreeIds(nodes, n.id);
        let sum = 0;
        for (const sid of ids) {
          const node = nodes.find(x => x.id === sid);
          if (node && node.type === 'text') {
            const t = await readText(sid);
            sum += countChars(t);
          }
        }
        item.chars = sum;
      }
      out.push(item);
    }
    return sendJSON(res, 200, { nodes: out });
  }

  if (pathname === '/api/nodes' && method === 'POST') {
    const body = await readBodyJSON(req);
    const nodes = await getNodes();
    const parentId = body.parentId || null;
    const type = body.type === 'folder' ? 'folder' : 'text';
    const siblings = nodes.filter(n => (n.parentId || null) === parentId);
    const node = {
      id: rid('n'),
      parentId,
      type,
      title: String(body.title || (type === 'folder' ? '新卷' : '第 章')).slice(0, 80),
      order: siblings.length + 1,
      summarySentence: '',
      summaryFull: '',
      status: 0,
      labels: [],
      goal: 0,
      compile: true,
      // 在「正文」里建出来的章节才进正文。大纲那边的结构节点一个都不动，
      // 所以正文视图可以从空白开始，而大纲仍旧是完整的那棵树。
      inText: body.inText === true,
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    // 插到指定节点后面
    if (body.afterId) {
      const after = nodes.find(n => n.id === body.afterId);
      if (after && (after.parentId || null) === parentId) {
        for (const n of siblings) {
          if (n.order > after.order) n.order++;
        }
        node.order = after.order + 1;
      }
    }
    nodes.push(node);
    await saveNodes(nodes);
    if (type === 'text') await atomicWrite(textPath(node.id), '');
    broadcast({ type: 'nodes' });
    return sendJSON(res, 200, { node });
  }

  // 拖拽排序：一次性把节点搬到目标父级的指定位置，避免前后端各算一半对不上
  const moveMatch = /^\/api\/nodes\/([A-Za-z0-9_-]+)\/move$/.exec(pathname);
  if (moveMatch && method === 'POST') {
    const id = moveMatch[1];
    const nodes = await getNodes();
    const node = nodes.find(n => n.id === id);
    if (!node) return sendJSON(res, 404, { error: '没有这个节点' });
    const body = await readBodyJSON(req);
    const targetParent = body.parentId || null;
    if (targetParent) {
      const target = nodes.find(n => n.id === targetParent);
      if (!target) return sendJSON(res, 400, { error: '目标节点不存在' });
      if (subtreeIds(nodes, id).includes(targetParent)) {
        return sendJSON(res, 400, { error: '不能把一章挪进它自己里面' });
      }
    }
    const oldParent = node.parentId || null;
    node.parentId = targetParent;
    const sibs = nodes
      .filter(n => (n.parentId || null) === targetParent && n.id !== id)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    let idx = sibs.length;
    if (body.afterId === null) idx = 0;
    else if (typeof body.afterId === 'string') {
      const i = sibs.findIndex(n => n.id === body.afterId);
      if (i >= 0) idx = i + 1;
    } else if (Number.isFinite(body.index)) {
      idx = Math.max(0, Math.min(sibs.length, body.index));
    }
    sibs.splice(idx, 0, node);
    sibs.forEach((n, i) => { n.order = i + 1; });
    if (oldParent !== targetParent) normalizeOrders(nodes, oldParent);
    node.updatedAt = nowISO();
    await saveNodes(nodes);
    broadcast({ type: 'nodes' });
    return sendJSON(res, 200, { node });
  }

  const nodeMatch = /^\/api\/nodes\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (nodeMatch) {
    const id = nodeMatch[1];
    const nodes = await getNodes();
    const node = nodes.find(n => n.id === id);
    if (!node) return sendJSON(res, 404, { error: '没有这个节点' });

    if (method === 'PATCH') {
      const body = await readBodyJSON(req);
      // 拖拽换父级
      if (body.parentId !== undefined && body.parentId !== node.parentId) {
        const target = body.parentId;
        if (target && subtreeIds(nodes, id).includes(target)) {
          return sendJSON(res, 400, { error: '不能把自己挪进自己里面' });
        }
        const ids = subtreeIds(nodes, id);
        const oldParent = node.parentId;
        node.parentId = target || null;
        const sibs = nodes.filter(n => (n.parentId || null) === (target || null) && !ids.includes(n.id));
        node.order = sibs.length + 1;
        normalizeOrders(nodes, oldParent);
      }
      for (const k of ['title', 'summarySentence', 'summaryFull']) {
        if (typeof body[k] === 'string') node[k] = body[k];
      }
      if (Number.isFinite(body.status)) node.status = body.status;
      if (Number.isFinite(body.goal)) node.goal = body.goal;
      if (Array.isArray(body.labels)) node.labels = body.labels;
      if (typeof body.compile === 'boolean') node.compile = body.compile;
      if (typeof body.inText === 'boolean') node.inText = body.inText;
      if (body.type === 'folder' || body.type === 'text') node.type = body.type;
      if (Number.isFinite(body.order)) node.order = body.order;
      node.updatedAt = nowISO();
      normalizeOrders(nodes, node.parentId);
      await saveNodes(nodes);
      broadcast({ type: 'nodes' });
      return sendJSON(res, 200, { node });
    }

    if (method === 'DELETE') {
      const ids = subtreeIds(nodes, id);
      const stamp = Date.now();
      await fsp.mkdir(path.join(trashDir(), String(stamp)), { recursive: true });
      const removed = [];
      for (const sid of ids) {
        const n = nodes.find(x => x.id === sid);
        if (!n) continue;
        removed.push(n);
        try {
          await fsp.rename(textPath(sid), path.join(trashDir(), String(stamp), sid + '.md'));
        } catch (e) {
          /* 没有正文 */
        }
        try {
          await fsp.rename(histPath(sid), path.join(trashDir(), String(stamp), sid + '-history'));
        } catch (e) {
          /* 没有历史 */
        }
      }
      await writeJSON(path.join(trashDir(), String(stamp), 'nodes.json'), removed);
      const parentId = node.parentId;
      const keep = nodes.filter(n => !ids.includes(n.id));
      normalizeOrders(keep, parentId);
      await saveNodes(keep);
      broadcast({ type: 'nodes' });
      return sendJSON(res, 200, { ok: true, trash: stamp, count: removed.length });
    }
  }

  // ---- 正文
  // 注意 sub 这一段必须能带文件名：历史版本的单条路径是
  // /api/text/<id>/history/<时间戳-随机>.md —— 两段。以前只允许一段
  // （\/[a-z]+），于是带文件名的请求整条匹配不上，落到最后的
  // 404「没有这个接口」，点哪个历史版本都读不出来。
  const textMatch = /^\/api\/text\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
  if (textMatch) {
    const id = textMatch[1];
    const sub = textMatch[2] || '';
    const nodes = await getNodes();
    const node = nodes.find(n => n.id === id);
    if (!node) return sendJSON(res, 404, { error: '没有这个节点' });

    if (!sub && method === 'GET') {
      const content = await readText(id);
      return sendJSON(res, 200, {
        content,
        meta: node,
        revision: node.revision || 0
      });
    }

    if (!sub && (method === 'PUT' || method === 'POST')) {
      const body = await readBodyJSON(req);
      if (typeof body.content !== 'string') return sendJSON(res, 400, { error: '缺少 content' });
      const old = await readText(id);
      const serverRev = node.revision || 0;
      if (Number.isFinite(body.baseRevision) && body.baseRevision < serverRev) {
        return sendJSON(res, 409, { conflict: true, content: old, revision: serverRev, meta: node });
      }
      if (old !== body.content) {
        await snapshot(id, old, false);
        await atomicWrite(textPath(id), body.content);
        const delta = countChars(body.content) - countChars(old);
        await addWords(delta);
      }
      if (typeof body.title === 'string' && body.title.trim()) node.title = body.title.trim().slice(0, 80);
      node.revision = serverRev + 1;
      node.chars = countChars(body.content);
      node.updatedAt = nowISO();
      await saveNodes(nodes);
      broadcast({ type: 'text', id, revision: node.revision, meta: node, origin: body.origin || null });
      return sendJSON(res, 200, { meta: node, revision: node.revision });
    }

    // 页面关闭时的最后一笔：无条件写入，先把被覆盖的那版留成快照
    if (sub === '/beacon' && method === 'POST') {
      let body;
      try {
        body = await readBodyJSON(req);
      } catch (e) {
        return sendJSON(res, 400, { error: 'bad' });
      }
      if (typeof body.content !== 'string') return sendJSON(res, 400, { error: 'bad' });
      const old = await readText(id);
      if (old !== body.content) {
        await snapshot(id, old, true);
        await atomicWrite(textPath(id), body.content);
        const delta = countChars(body.content) - countChars(old);
        await addWords(delta);
      }
      node.revision = (node.revision || 0) + 1;
      node.chars = countChars(body.content);
      node.updatedAt = nowISO();
      await saveNodes(nodes);
      broadcast({ type: 'text', id, revision: node.revision, meta: node });
      return sendJSON(res, 200, { meta: node });
    }

    if (sub === '/history' && method === 'GET') {
      return sendJSON(res, 200, { snapshots: await listSnapshots(id) });
    }

    const hist = /^\/history\/([^/]+)$/.exec(sub);
    if (hist && method === 'GET') {
      // 只认 history 目录里的快照文件名，别让 ../ 这类东西溜进来
      if (!/^[\w-]+\.md$/.test(hist[1])) return sendJSON(res, 400, { error: '文件名不对' });
      try {
        const body = await fsp.readFile(path.join(histPath(id), hist[1]), 'utf8');
        return sendJSON(res, 200, { content: body });
      } catch (e) {
        return sendJSON(res, 404, { error: '没有这个版本' });
      }
    }

    // 删掉某一个历史版本。只删那一份快照，不碰正文。
    if (hist && method === 'DELETE') {
      if (!/^[\w-]+\.md$/.test(hist[1])) return sendJSON(res, 400, { error: '文件名不对' });
      try {
        await fsp.unlink(path.join(histPath(id), hist[1]));
        return sendJSON(res, 200, { ok: true });
      } catch (e) {
        return sendJSON(res, 404, { error: '没有这个版本' });
      }
    }

    // 一次删掉一批历史版本（多选）。只删快照，不碰正文；最新那份永远留着。
    if (sub === '/history/delete' && method === 'POST') {
      const body = await readBodyJSON(req);
      const raw = Array.isArray(body.files) ? body.files : [];
      const want = raw.filter(f => typeof f === 'string' && /^[\w-]+\.md$/.test(f));
      if (!want.length) return sendJSON(res, 400, { error: '没说要删哪些' });
      const all = (await fsp.readdir(histPath(id)).catch(() => []))
        .filter(f => /\.md$/.test(f))
        .sort();
      const keep = all.length ? all[all.length - 1] : null;
      let gone = 0;
      let kept = 0;
      for (const f of want) {
        if (f === keep) {
          kept++; // 最新一版不给删，留着保底
          continue;
        }
        try {
          await fsp.unlink(path.join(histPath(id), f));
          gone++;
        } catch (e) {
          /* 已经不在了就算了，继续删下一个 */
        }
      }
      return sendJSON(res, 200, { ok: true, deleted: gone, kept });
    }

    if (sub === '/history/clear' && method === 'POST') {
      // 永远留最新的那一份：全清也只清到「只剩最后一版」。
      const names = (await fsp.readdir(histPath(id)).catch(() => []))
        .filter(f => /\.md$/.test(f))
        .sort();
      const keep = names.length ? names[names.length - 1] : null;
      let gone = 0;
      for (const f of names) {
        if (f === keep) continue;
        try {
          await fsp.unlink(path.join(histPath(id), f));
          gone++;
        } catch (e) {}
      }
      return sendJSON(res, 200, { ok: true, deleted: gone, kept: keep ? 1 : 0 });
    }

    if (sub === '/restore' && method === 'POST') {
      const body = await readBodyJSON(req);
      const file = String(body.file || '');
      if (!/^[\w-]+\.md$/.test(file)) return sendJSON(res, 400, { error: '文件名不对' });
      let content;
      try {
        content = await fsp.readFile(path.join(histPath(id), file), 'utf8');
      } catch (e) {
        return sendJSON(res, 404, { error: '没有这个版本' });
      }
      const cur = await readText(id);
      await snapshot(id, cur, true);
      await atomicWrite(textPath(id), content);
      node.revision = (node.revision || 0) + 1;
      node.chars = countChars(content);
      node.updatedAt = nowISO();
      await saveNodes(nodes);
      broadcast({ type: 'nodes' });
      broadcast({ type: 'text', id, revision: node.revision, meta: node });
      return sendJSON(res, 200, { content, revision: node.revision });
    }
  }

  // ---- 人物关系网：整份读 / 整份存（关系是扁平的边列表，不需要逐条 CRUD）
  if (pathname === '/api/net') {
    const file = FILES.relations();
    if (method === 'GET') {
      const raw = await readJSON(file, null);
      // 老数据是个数组，新数据是 { edges, types }，两种都认
      const obj = Array.isArray(raw)
        ? { edges: raw, types: [] }
        : (raw && typeof raw === 'object' ? raw : { edges: [], types: [] });
      return sendJSON(res, 200, {
        edges: Array.isArray(obj.edges) ? obj.edges : [],
        types: Array.isArray(obj.types) ? obj.types : [],
        defaultTypes: NET_TYPES_DEFAULT
      });
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readBodyJSON(req);
      const list = Array.isArray(body.edges) ? body.edges : [];
      const hex = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : '');
      // 只留结构对的边，顺手把 id 补上，避免前端漏传导致渲染时崩
      const clean = list
        .filter(e => e && typeof e.from === 'string' && typeof e.to === 'string' && e.from !== e.to)
        .map(e => ({
          id: String(e.id || 'r' + crypto.randomBytes(4).toString('hex')),
          from: e.from,
          to: e.to,
          label: String(e.label || '').slice(0, 40),
          color: hex(e.color),
          note: String(e.note || '').slice(0, 2000)
        }));
      // 关系类型表：一个名字配一个颜色，用户自己定「绿=朋友」这种
      const types = (Array.isArray(body.types) ? body.types : [])
        .filter(t => t && String(t.name || '').trim())
        .map(t => ({
          name: String(t.name).trim().slice(0, 20),
          color: hex(t.color) || '#7a736a'
        }))
        .slice(0, 40);
      await writeJSON(file, { edges: clean, types });
      broadcast({ type: 'net' });
      return sendJSON(res, 200, { ok: true, edges: clean, types });
    }
  }

  // ---- 卡片（角色 / 情节 / 物品）
  const cardsMatch = /^\/api\/cards\/(characters|plots|items)(?:\/([A-Za-z0-9_-]+))?$/.exec(pathname);
  if (cardsMatch) {
    const kind = cardsMatch[1];
    const cardsId = cardsMatch[2];
    const file = FILES[kind]();
    const list = await readJSON(file, []);

    // 拖拽排序：一次把整组的先后写下去，避免前端逐条 PATCH
    // 只动 order。分量绝不在这里批量改 —— 曾经允许它顺手改分量，
    // 结果一次拖拽把十几条卡的分量全写成 0。一个接口只干一件事。
    if (cardsId === 'reorder' && method === 'POST') {
      const body = await readBodyJSON(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      let i = 0;
      for (const id of ids) {
        const card = list.find(c => c.id === id);
        if (!card) continue;
        const want = ++i;
        if (card.order !== want) {
          card.order = want;
          card.updatedAt = nowISO();
        }
      }
      await atomicWrite(file, JSON.stringify(list, null, 2));
      broadcast({ type: 'cards', kind });
      return sendJSON(res, 200, { ok: true });
    }

    if (!cardsId && method === 'GET') return sendJSON(res, 200, { items: list });

    if (!cardsId && method === 'POST') {
      const body = await readBodyJSON(req);
      const prefix = kind === 'characters' ? 'c' : kind === 'plots' ? 'p' : 'i';
      const card = Object.assign(
        {
          id: rid(prefix),
          name: '新' + (kind === 'characters' ? '角色' : kind === 'plots' ? '情节' : '物品'),
          order: list.length + 1,
          createdAt: nowISO(),
          updatedAt: nowISO()
        },
        kind === 'characters'
          ? { importance: 0, pov: false, motivation: '', goal: '', conflict: '', epiphany: '', phraseSummary: '', paragraphSummary: '', summaryFull: '', color: '', custom: {} }
          : kind === 'plots'
            ? { importance: 0, characters: [], description: '', result: '' }
            : { description: '', quantity: '', owner: '' },
        body || {}
      );
      list.push(card);
      await atomicWrite(file, JSON.stringify(list, null, 2));
      broadcast({ type: 'cards', kind });
      return sendJSON(res, 200, { card });
    }

    if (cardsId) {
      const idx = list.findIndex(c => c.id === cardsId);
      if (idx < 0) return sendJSON(res, 404, { error: '没有这张卡' });
      if (method === 'PATCH') {
        const body = await readBodyJSON(req);
        const card = list[idx];
        for (const k of Object.keys(body)) {
          if (k === 'id' || k === 'createdAt') continue;
          card[k] = body[k];
        }
        card.updatedAt = nowISO();
        await atomicWrite(file, JSON.stringify(list, null, 2));
        broadcast({ type: 'cards', kind });
        return sendJSON(res, 200, { card });
      }
      if (method === 'DELETE') {
        const [card] = list.splice(idx, 1);
        await atomicWrite(file, JSON.stringify(list, null, 2));
        const stamp = Date.now();
        await fsp.mkdir(path.join(trashDir(), String(stamp)), { recursive: true });
        await writeJSON(path.join(trashDir(), String(stamp), kind + '.json'), [card]);
        broadcast({ type: 'cards', kind });
        return sendJSON(res, 200, { ok: true });
      }
    }
  }

  // ---- 世界观树
  if (pathname === '/api/world') {
    const file = FILES.world();
    const list = await readJSON(file, []);
    if (method === 'GET') return sendJSON(res, 200, { items: list });
    if (method === 'POST') {
      const body = await readBodyJSON(req);
      const parentId = body.parentId || null;
      const sibs = list.filter(n => (n.parentId || null) === parentId);
      const node = {
        id: rid('w'),
        parentId,
        title: String(body.title || '新条目').slice(0, 80),
        content: '',
        order: sibs.length + 1,
        createdAt: nowISO(),
        updatedAt: nowISO()
      };
      list.push(node);
      await atomicWrite(file, JSON.stringify(list, null, 2));
      broadcast({ type: 'world' });
      return sendJSON(res, 200, { node });
    }
  }

  const worldMatch = /^\/api\/world\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (worldMatch) {
    const id = worldMatch[1];
    const file = FILES.world();
    const list = await readJSON(file, []);
    const node = list.find(n => n.id === id);
    if (!node) return sendJSON(res, 404, { error: '没有这个条目' });
    if (method === 'PATCH') {
      const body = await readBodyJSON(req);
      for (const k of ['title', 'content']) {
        if (typeof body[k] === 'string') node[k] = body[k];
      }
      if (Number.isFinite(body.order)) node.order = body.order;
      if (body.parentId !== undefined) node.parentId = body.parentId || null;
      node.updatedAt = nowISO();
      await atomicWrite(file, JSON.stringify(list, null, 2));
      broadcast({ type: 'world' });
      return sendJSON(res, 200, { node });
    }
    if (method === 'DELETE') {
      const ids = [id];
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        for (const n of list) {
          if (n.parentId === cur) {
            ids.push(n.id);
            stack.push(n.id);
          }
        }
      }
      const keep = list.filter(n => !ids.includes(n.id));
      const stamp = Date.now();
      await fsp.mkdir(path.join(trashDir(), String(stamp)), { recursive: true });
      await writeJSON(path.join(trashDir(), String(stamp), 'world.json'), list.filter(n => ids.includes(n.id)));
      await atomicWrite(file, JSON.stringify(keep, null, 2));
      broadcast({ type: 'world' });
      return sendJSON(res, 200, { ok: true });
    }
  }

  // ---- 统计
  if (pathname === '/api/stats' && method === 'GET') {
    const stats = await getStats();
    const nodes = await getNodes();
    let total = 0;
    const perNode = {};
    for (const n of nodes) {
      if (n.type !== 'text') continue;
      const t = await readText(n.id);
      const c = countChars(t);
      perNode[n.id] = c;
      total += c;
    }
    let streak = 0;
    const days = stats.days || {};
    const d = new Date();
    for (;;) {
      const key = localDay(d);
      if ((days[key] || 0) > 0) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else if (key === localDay()) {
        d.setDate(d.getDate() - 1);
        if ((days[localDay(d)] || 0) > 0) streak++;
        else break;
      } else break;
      if (streak > 3650) break;
    }
    return sendJSON(res, 200, {
      days,
      total,
      perNode,
      today: days[localDay()] || 0,
      streak,
      goal: (await getProject()).goal
    });
  }

  // ---- 搜索
  if (pathname === '/api/search' && method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return sendJSON(res, 200, { hits: [] });
    const nodes = await getNodes();
    const hits = [];
    const lower = q.toLowerCase();
    for (const n of nodes) {
      if (n.type === 'text') {
        const t = await readText(n.id);
        const idx = t.toLowerCase().indexOf(lower);
        if (idx >= 0) {
          hits.push({
            kind: 'text',
            id: n.id,
            title: n.title,
            snippet: t.slice(Math.max(0, idx - 40), idx + q.length + 60).replace(/\n/g, ' ')
          });
        }
      }
      for (const field of ['title', 'summarySentence', 'summaryFull']) {
        if (String(n[field] || '').toLowerCase().includes(lower)) {
          hits.push({ kind: 'node', id: n.id, title: n.title, field, snippet: String(n[field]).slice(0, 100) });
        }
      }
    }
    for (const kind of ['characters', 'plots', 'items']) {
      const list = await readJSON(FILES[kind](), []);
      for (const c of list) {
        const blob = JSON.stringify(c).toLowerCase();
        if (blob.includes(lower)) {
          hits.push({ kind, id: c.id, title: c.name, snippet: (c.description || c.summaryFull || c.goal || '').slice(0, 100) });
        }
      }
    }
    const world = await readJSON(FILES.world(), []);
    for (const w of world) {
      if ((w.title + ' ' + w.content).toLowerCase().includes(lower)) {
        hits.push({ kind: 'world', id: w.id, title: w.title, snippet: String(w.content || '').slice(0, 100) });
      }
    }
    return sendJSON(res, 200, { hits: hits.slice(0, 80) });
  }

  // ---- 导出
  if (pathname === '/api/export' && method === 'GET') {
    const format = String(url.searchParams.get('format') || 'md');
    const nodes = await getNodes();
    const project = await getProject();

    const build = (parentId, depth, out) => {
      const kids = nodes
        .filter(n => (n.parentId || null) === (parentId || null) && n.compile !== false)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const n of kids) {
        if (n.type === 'folder') {
          if (format === 'md' || format === 'html') out.push('#'.repeat(Math.min(6, depth + 1)) + ' ' + n.title);
          build(n.id, depth + 1, out);
        } else {
          if (format === 'md' || format === 'html') out.push('#'.repeat(Math.min(6, depth + 1)) + ' ' + n.title);
          out.push('@@TEXT:' + n.id + '@@');
        }
      }
    };
    const parts = [];
    if (format === 'md' || format === 'html') parts.push('# ' + project.title);
    build(null, 0, parts);

    let text = '';
    for (const p of parts) {
      if (p.startsWith('@@TEXT:')) {
        const id = p.slice(7, -2);
        text += (await readText(id)) + '\n\n';
      } else {
        text += p + '\n\n';
      }
    }
    if (format === 'txt') {
      text = text.replace(/^#+\s*/gm, '');
    }
    return sendJSON(res, 200, { format, content: text });
  }

  // ---- 打包带走：程序 + 数据 + 部署说明，换电脑解压即用
  if (pathname === '/api/package' && method === 'GET') {
    console.log('[pkg] 开始打包');
    const pkg = await buildPackage();
    console.log('[pkg] 打好', pkg.buffer.length, '字节', pkg.name);
    // HTTP 头只能放 ASCII。文件名想用中文，就得走 RFC 5987 的 filename*，
    // 再配一个纯英文的 filename 给不认 filename* 的老浏览器兜底。
    const ascii = 'mo-writer-' + pkg.stamp + '.zip';
    console.log('[pkg] ascii 名', ascii);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': pkg.buffer.length,
      'Content-Disposition':
        'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(pkg.name),
      'Cache-Control': 'no-store'
    });
    console.log('[pkg] 头已写');
    res.end(pkg.buffer);
    console.log('[pkg] 已发送');
    return;
  }

  // ---- SSE
  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (e) {
        clearInterval(ping);
        clients.delete(res);
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  return sendJSON(res, 404, { error: '没有这个接口' });
}

// ---------------------------------------------------------------- 静态文件

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const { makeZip } = require('./zipper');

// ---------------------------------------------------------------- 打包带走


/** 收集要打进 zip 的文件 */
async function buildPackage() {
  const files = [];
  const seen = new Set();

  const add = async (relFromRoot, nameInZip) => {
    const full = path.join(ROOT, relFromRoot);
    const name = nameInZip || '茉写作/' + relFromRoot.split(path.sep).join('/');
    if (seen.has(name)) return;
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) return;
      files.push({ name, data: await fsp.readFile(full) });
      seen.add(name);
    } catch (e) {
      /* 文件不在就跳过，别让打包整体失败 */
    }
  };

  // 程序本体
  for (const f of [
    'server.js',
    'zipper.js',
    'import-manuskript.js',
    'run-loop.bat',
    'autostart.vbs',
    'config.json',
    '密码.txt',
    'Setup.exe',
    '茉写作.apk'
  ]) {
    await add(f);
  }

  // 前端
  try {
    for (const f of await fsp.readdir(PUBLIC_DIR)) {
      await add(path.join('public', f));
    }
  } catch (e) {
    /* ignore */
  }

  // 数据：只带当前这本书（data/books/<id>/），历史快照和回收站不带（动辄几百 MB）
  const bookRel = path.join('data', 'books', bookId());
  for (const f of ['project.json', 'nodes.json', 'world.json', 'characters.json', 'plots.json', 'items.json', 'stats.json']) {
    await add(path.join(bookRel, f));
  }
  try {
    for (const f of await fsp.readdir(textDir())) {
      await add(path.join(bookRel, 'text', f));
    }
  } catch (e) {
    /* ignore */
  }
  // 最近一天的备份，留个后悔药
  try {
    const days = (await fsp.readdir(backupDir())).sort();
    const last = days[days.length - 1];
    if (last) {
      for (const f of await fsp.readdir(path.join(backupDir(), last))) {
        await add(path.join(bookRel, 'backups', last, f));
      }
    }
  } catch (e) {
    /* ignore */
  }

  const d = new Date();
  const stamp =
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0') +
    '-' +
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0');

  return {
    name: '茉写作-' + stamp + '.zip',
    stamp,
    buffer: makeZip(files),
    count: files.length
  };
}

// ---------------------------------------------------------------- 静态文件

async function assetVersion(name) {
  try {
    const st = await fsp.stat(path.join(PUBLIC_DIR, name));
    return Math.round(st.mtimeMs).toString(36) + st.size.toString(36);
  } catch (e) {
    return '0';
  }
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel.split('?')[0]);
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([\\/])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    let data = await fsp.readFile(full);
    const ext = path.extname(full).toLowerCase();

    if (ext === '.html') {
      const names = ['app.js', 'core.js', 'view-tree.js', 'view-cards.js', 'view-world.js', 'view-stats.js', 'style.css'];
      const vers = {};
      for (const n of names) vers[n] = await assetVersion(n);
      let html = data.toString('utf8');
      for (const n of names) {
        const esc = n.replace('.', '\\.');
        html = html.replace(new RegExp('(["\'])' + esc + '(\\?[^"\']*)?', 'g'), '$1' + n + '?v=' + vers[n]);
      }
      data = Buffer.from(html, 'utf8');
    }

    const etag = '"' + crypto.createHash('sha1').update(data).digest('hex').slice(0, 20) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('找不到这个文件');
  }
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push({ name, address: info.address });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 备份

let backupRunning = null;
async function runBackup(reason) {
  if (backupRunning) return backupRunning;
  backupRunning = (async () => {
    try {
      const day = localDay();
      const dest = path.join(backupDir(), day);
      if (reason === 'daily' && fs.existsSync(dest)) return;
      await fsp.mkdir(dest, { recursive: true });
      const copyDir = async (from, to) => {
        await fsp.mkdir(to, { recursive: true });
        const files = await fsp.readdir(from).catch(() => []);
        for (const f of files) {
          const st = await fsp.stat(path.join(from, f)).catch(() => null);
          if (!st) continue;
          if (st.isDirectory()) await copyDir(path.join(from, f), path.join(to, f));
          else await fsp.copyFile(path.join(from, f), path.join(to, f)).catch(() => {});
        }
      };
      await copyDir(textDir(), path.join(dest, 'text'));
      for (const k of ['project', 'nodes', 'world', 'characters', 'plots', 'items', 'stats']) {
        await fsp.copyFile(FILES[k](), path.join(dest, k + '.json')).catch(() => {});
      }
      const entries = await fsp.readdir(backupDir()).catch(() => []);
      const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400 * 1000;
      for (const e of entries) {
        const t = Date.parse(e);
        if (Number.isFinite(t) && t < cutoff) {
          await fsp.rm(path.join(backupDir(), e), { recursive: true, force: true });
        }
      }
    } catch (e) {
      console.error('[backup]', e.message);
    } finally {
      backupRunning = null;
    }
  })();
  return backupRunning;
}

// ---------------------------------------------------------------- 启动

async function ensureDirs() {
  for (const d of [BOOKS_DIR, dataDir(), textDir(), histDir(), trashDir(), PUBLIC_DIR]) {
    await fsp.mkdir(d, { recursive: true });
  }
  for (const k of ['project', 'nodes', 'world', 'characters', 'plots', 'items', 'stats']) {
    const f = FILES[k]();
    if (!fs.existsSync(f)) {
      await writeJSON(f, k === 'project' ? DEFAULT_PROJECT : k === 'stats' ? { days: {} } : []);
    }
  }
}

// ---------------------------------------------------------------- 访问日志

// 手机连不上时，「日志里有没有你手机那条」是唯一能分辨的线索：
// 有 = 包到了、被应用层挡了；没有 = 根本没到这台机器（防火墙或不在同一张网）。
const ACCESS_LOG = path.join(ROOT, 'data', 'access.log');

function logAccess(req, pathname) {
  // 静态资源会刷屏，只记页面和接口
  if (/\.(css|js|png|jpe?g|gif|svg|ico|woff2?|map)$/i.test(pathname)) return;
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fsp.appendFile(ACCESS_LOG, `${stamp}  ${ip.padEnd(15)}  ${req.method} ${pathname}\n`).catch(() => {});
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  // 这个请求在看哪本书：由前端用 x-book 头带过来。
  // 整个请求全程都跑在 bookCtx 里，所以底下所有数据读写都会落到那本书的目录。
  const raw = String(req.headers['x-book'] || '').trim();
  const bid = BOOK_ID_RE.test(raw) ? raw : DEFAULT_BOOK;
  bookCtx.run(bid, () => handleRequest(req, res, url, pathname)).catch(e => {
    console.error('[http]', e);
    if (!res.headersSent) sendJSON(res, 500, { error: '服务端出错' });
  });
});

async function handleRequest(req, res, url, pathname) {

  // 记一行访问日志：手机连不上时，这条日志能判断出「包到底有没有到」
  logAccess(req, pathname);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  // 手机 App：放在 /api/ 外面，因为浏览器直接用这个网址下载，不带 Cookie 也没关系
  //（这是公开的安装包，不含任何作品内容）
  if (pathname === '/app.apk' && req.method === 'GET') {
    try {
      const buf = await fsp.readFile(path.join(ROOT, '茉写作.apk'));
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': buf.length,
        'Content-Disposition':
          'attachment; filename="MoWriter.apk"; filename*=UTF-8\'\'' +
          encodeURIComponent('茉写作.apk'),
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('还没打包 APK。在 mo-android 目录跑一次 build.ps1。');
    }
    return;
  }

  // 电脑安装包：和 app.apk 一样是公开的（不含任何作品内容），
  // 让「设置 → 手机 / 平板」旁边那个「装到这台电脑」按钮能直接下。
  if (pathname === '/setup.exe' && req.method === 'GET') {
    // 装好的目录里没有 Setup.exe —— 安装器只把自己复制成「卸载茉写作.exe」。
    // 但两者是同一个程序（靠文件名 / 参数分辨是装还是卸），所以退一步用
    // 卸载器那份就是完整可用的安装包，双击进去一样是安装界面。
    let buf = null;
    for (const name of ['Setup.exe', '卸载茉写作.exe']) {
      try {
        buf = await fsp.readFile(path.join(ROOT, name));
        break;
      } catch (e) { /* 换下一个 */ }
    }
    if (buf) {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.microsoft.portable-executable',
        'Content-Length': buf.length,
        'Content-Disposition':
          'attachment; filename="MoWriter-Setup.exe"; filename*=UTF-8\'\'' +
          encodeURIComponent('茉写作安装.exe'),
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('这个副本里没有安装包。到源码目录 mo-desktop 跑一次 build.ps1 生成 Setup.exe。');
    }
    return;
  }

  if (pathname.startsWith('/api/')) {
    try {
      await handleAPI(req, res, pathname, url);
    } catch (e) {
      console.error('[http]', e);
      if (!res.headersSent) sendJSON(res, 500, { error: '服务端出错' });
    }
    return;
  }
  return serveStatic(req, res, pathname);
}

async function main() {
  ensureConfig();
  await ensureDirs();
  const port = Number(process.env.MO_PORT || CONFIG.port || DEFAULT_PORT);
  const bind = process.env.MO_BIND || CONFIG.bind || '0.0.0.0';

  setTimeout(() => runBackup('daily').catch(() => {}), 20 * 1000);
  setInterval(() => runBackup('daily').catch(() => {}), 30 * 60 * 1000).unref();

  server.listen(port, bind, () => {
    const addrs = lanAddresses();
    // 每次启动清空访问日志：排查「手机连不上」只看本次开机之后发生了什么
    fsp.writeFile(ACCESS_LOG, '').catch(() => {});
    console.log('');
    console.log('  茉 · 写作台');
    console.log('  ────────────────────────────────────────');
    console.log('  本机:   http://127.0.0.1:' + port);
    for (const a of addrs) {
      console.log('  局域网: http://' + a.address + ':' + port + '   (' + a.name + ')');
    }
    console.log('  书架:   ' + BOOKS_DIR);
    console.log('  访问日志: ' + ACCESS_LOG);
    console.log('  ────────────────────────────────────────');
    console.log('');
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.log('[' + nowISO() + '] 端口 ' + port + ' 已被占用，本次不启动。');
      process.exit(0);
    }
    console.error('[server]', e);
    process.exit(1);
  });

  try {
    const logPath = path.join(ROOT, 'data', 'server.log');
    const st = fs.statSync(logPath);
    if (st.size > 5 * 1024 * 1024) fs.truncateSync(logPath, 0);
  } catch (e) {
    /* ignore */
  }
}

process.on('uncaughtException', e => console.error('[uncaught]', e));
process.on('unhandledRejection', e => console.error('[unhandled]', e));

main();
