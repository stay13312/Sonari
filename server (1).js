// Sonari — этапы 1–2: аккаунты, серверы, каналы
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
const db = new Database(path.join(__dirname, 'sonari.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  bio TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS servers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  icon TEXT DEFAULT '',
  invite_code TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members(
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(server_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);`);

app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DAY = 86400000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NICK_RE = /^[a-zA-Z0-9_.]{3,32}$/;
const CHAN_RE = /^[a-zA-Zа-яА-Я0-9 _\-]{1,40}$/;

function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return o;
}
function setCookie(req, res, value, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  const age = maxAgeSec === undefined ? '' : '; Max-Age=' + maxAgeSec;
  res.setHeader('Set-Cookie', 'sid=' + value + '; HttpOnly; Path=/; SameSite=Lax' + age + secure);
}
function createSession(req, res, userId, remember) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)')
    .run(token, userId, (req.headers['user-agent'] || '').slice(0, 200), now, now + (remember ? 30 * DAY : DAY));
  setCookie(req, res, token, remember ? 30 * 86400 : undefined);
}
function auth(req, res, next) {
  const t = cookies(req).sid;
  const s = t && db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(t, Date.now());
  if (!s) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  req.user = db.prepare('SELECT id,email,username,bio,created_at FROM users WHERE id=?').get(s.user_id);
  if (!req.user) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  req.token = t;
  next();
}

const attempts = new Map();
function limited(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter(x => now - x < 15 * 60000);
  a.push(now); attempts.set(key, a);
  return a.length > 10;
}

// ---------- аккаунты ----------
app.post('/api/register', (req, res) => {
  const { email, username, password, remember } = req.body || {};
  if (!EMAIL_RE.test(email || '')) return res.status(400).json({ error: 'Некорректная почта' });
  if (!NICK_RE.test(username || '')) return res.status(400).json({ error: 'Ник: 3–32 символа, латиница, цифры, _ и .' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email.toLowerCase())) return res.status(409).json({ error: 'Эта почта уже занята' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(409).json({ error: 'Этот ник уже занят' });
  const r = db.prepare('INSERT INTO users(email,username,password_hash,created_at) VALUES(?,?,?,?)')
    .run(email.toLowerCase(), username, bcrypt.hashSync(password, 10), Date.now());
  createSession(req, res, r.lastInsertRowid, !!remember);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { login, password, remember } = req.body || {};
  if (limited(req.ip)) return res.status(429).json({ error: 'Слишком много попыток, подожди 15 минут' });
  const u = db.prepare('SELECT * FROM users WHERE email=? OR username=?').get(String(login || '').toLowerCase(), login || '');
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) return res.status(401).json({ error: 'Неверный логин или пароль' });
  createSession(req, res, u.id, !!remember);
  res.json({ ok: true });
});

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(req.token);
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.post('/api/logout-all', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(req.user.id, req.token);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

app.patch('/api/me', auth, (req, res) => {
  const { username, bio } = req.body || {};
  if (username !== undefined && username !== req.user.username) {
    if (!NICK_RE.test(username)) return res.status(400).json({ error: 'Ник: 3–32 символа, латиница, цифры, _ и .' });
    if (db.prepare('SELECT 1 FROM users WHERE username=? AND id<>?').get(username, req.user.id)) return res.status(409).json({ error: 'Этот ник уже занят' });
    db.prepare('UPDATE users SET username=? WHERE id=?').run(username, req.user.id);
  }
  if (bio !== undefined) db.prepare('UPDATE users SET bio=? WHERE id=?').run(String(bio).slice(0, 190), req.user.id);
  res.json(db.prepare('SELECT id,email,username,bio,created_at FROM users WHERE id=?').get(req.user.id));
});

app.post('/api/password', auth, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(current || '', u.password_hash)) return res.status(400).json({ error: 'Текущий пароль неверный' });
  if (!next || next.length < 8) return res.status(400).json({ error: 'Новый пароль минимум 8 символов' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(next, 10), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(req.user.id, req.token);
  res.json({ ok: true });
});

app.get('/api/sessions', auth, (req, res) => {
  const rows = db.prepare('SELECT token,user_agent,created_at FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC')
    .all(req.user.id, Date.now());
  res.json(rows.map(r => ({ id: r.token.slice(0, 12), current: r.token === req.token, user_agent: r.user_agent, created_at: r.created_at })));
});

app.delete('/api/me', auth, (req, res) => {
  const u = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync((req.body || {}).password || '', u.password_hash)) return res.status(400).json({ error: 'Неверный пароль' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.user.id);
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});

// ---------- серверы ----------
function membership(serverId, userId) {
  return db.prepare('SELECT role FROM members WHERE server_id=? AND user_id=?').get(serverId, userId);
}
function makeInvite() {
  let code;
  do { code = crypto.randomBytes(5).toString('hex'); }
  while (db.prepare('SELECT 1 FROM servers WHERE invite_code=?').get(code));
  return code;
}
function serverInfo(s, userId) {
  return {
    id: s.id, name: s.name, icon: s.icon, owner: s.owner_id === userId,
    invite: s.invite_code,
    members: db.prepare('SELECT COUNT(*) c FROM members WHERE server_id=?').get(s.id).c
  };
}

app.get('/api/servers', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.* FROM servers s JOIN members m ON m.server_id = s.id
    WHERE m.user_id = ? ORDER BY m.joined_at ASC`).all(req.user.id);
  res.json(rows.map(s => serverInfo(s, req.user.id)));
});

app.post('/api/servers', auth, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Название сервера: 2–40 символов' });
  const icon = String((req.body || {}).icon || '').trim().slice(0, 4);
  const now = Date.now();
  const r = db.prepare('INSERT INTO servers(name,owner_id,icon,invite_code,created_at) VALUES(?,?,?,?,?)')
    .run(name, req.user.id, icon, makeInvite(), now);
  const sid = r.lastInsertRowid;
  db.prepare('INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)').run(sid, req.user.id, 'owner', now);
  const text = db.prepare('INSERT INTO channels(server_id,name,type,position,created_at) VALUES(?,?,?,?,?)').run(sid, 'общий', 'text', 0, now);
  db.prepare('INSERT INTO channels(server_id,name,type,position,created_at) VALUES(?,?,?,?,?)').run(sid, 'Основной', 'voice', 1, now);
  res.json({ id: sid, name, icon, owner: true, invite: db.prepare('SELECT invite_code FROM servers WHERE id=?').get(sid).invite_code, members: 1, firstChannel: text.lastInsertRowid });
});

app.get('/api/servers/:id', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  const m = membership(s.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Ты не участник этого сервера' });
  const channels = db.prepare('SELECT id,name,type,position FROM channels WHERE server_id=? ORDER BY position,id').all(s.id);
  const members = db.prepare(`
    SELECT u.id,u.username,m.role FROM members m JOIN users u ON u.id=m.user_id
    WHERE m.server_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.username`).all(s.id);
  res.json({ ...serverInfo(s, req.user.id), myRole: m.role, channels, members });
});

app.patch('/api/servers/:id', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  const m = membership(s.id, req.user.id);
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) return res.status(403).json({ error: 'Менять сервер может только владелец' });
  const name = req.body && req.body.name !== undefined ? String(req.body.name).trim() : null;
  const icon = req.body && req.body.icon !== undefined ? String(req.body.icon).trim().slice(0, 4) : null;
  if (name !== null) {
    if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Название сервера: 2–40 символов' });
    db.prepare('UPDATE servers SET name=? WHERE id=?').run(name, s.id);
  }
  if (icon !== null) db.prepare('UPDATE servers SET icon=? WHERE id=?').run(icon, s.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/invite', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  const m = membership(s.id, req.user.id);
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) return res.status(403).json({ error: 'Обновить ссылку может только владелец' });
  const code = makeInvite();
  db.prepare('UPDATE servers SET invite_code=? WHERE id=?').run(code, s.id);
  res.json({ invite: code });
});

app.delete('/api/servers/:id', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'Удалить сервер может только владелец' });
  db.prepare('DELETE FROM servers WHERE id=?').run(s.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/leave', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  if (s.owner_id === req.user.id) return res.status(400).json({ error: 'Владелец не может выйти: удали сервер или передай его позже' });
  db.prepare('DELETE FROM members WHERE server_id=? AND user_id=?').run(s.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/join/:code', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE invite_code=?').get(String(req.params.code || '').trim());
  if (!s) return res.status(404).json({ error: 'Приглашение не найдено' });
  if (membership(s.id, req.user.id)) return res.json({ id: s.id, already: true });
  db.prepare('INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)').run(s.id, req.user.id, 'member', Date.now());
  res.json({ id: s.id, name: s.name });
});

// ---------- каналы ----------
app.post('/api/servers/:id/channels', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  const m = membership(s.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Ты не участник этого сервера' });
  if (m.role !== 'owner' && m.role !== 'admin') return res.status(403).json({ error: 'Создавать каналы может владелец' });
  const name = String((req.body || {}).name || '').trim();
  const type = (req.body || {}).type === 'voice' ? 'voice' : 'text';
  if (!CHAN_RE.test(name)) return res.status(400).json({ error: 'Название канала: 1–40 символов' });
  if (db.prepare('SELECT 1 FROM channels WHERE server_id=? AND name=? COLLATE NOCASE').get(s.id, name))
    return res.status(409).json({ error: 'Канал с таким названием уже есть' });
  const pos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 p FROM channels WHERE server_id=?').get(s.id).p;
  const r = db.prepare('INSERT INTO channels(server_id,name,type,position,created_at) VALUES(?,?,?,?,?)').run(s.id, name, type, pos, Date.now());
  res.json({ id: r.lastInsertRowid, name, type, position: pos });
});

app.patch('/api/channels/:id', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM channels WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Канал не найден' });
  const m = membership(c.server_id, req.user.id);
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) return res.status(403).json({ error: 'Переименовать канал может только владелец' });
  const name = String((req.body || {}).name || '').trim();
  if (!CHAN_RE.test(name)) return res.status(400).json({ error: 'Название канала: 1–40 символов' });
  if (db.prepare('SELECT 1 FROM channels WHERE server_id=? AND name=? COLLATE NOCASE AND id<>?').get(c.server_id, name, c.id))
    return res.status(409).json({ error: 'Канал с таким названием уже есть' });
  db.prepare('UPDATE channels SET name=? WHERE id=?').run(name, c.id);
  res.json({ ok: true, name });
});

app.delete('/api/channels/:id', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM channels WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Канал не найден' });
  const m = membership(c.server_id, req.user.id);
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) return res.status(403).json({ error: 'Удалить канал может только владелец' });
  db.prepare('DELETE FROM channels WHERE id=?').run(c.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Sonari запущен на порту ' + PORT));
