// Sonari — этапы 1–3: аккаунты, серверы, каналы, сообщения
// База: хранилище на массивах + файл sonari.json (без нативных модулей)
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const DB_FILE = path.join(__dirname, 'sonari.json');

const store = {
  users: [], sessions: [], servers: [], members: [], channels: [], messages: [],
  seq: { users: 1, sessions: 1, servers: 1, channels: 1, messages: 1 }
};

const db = {
  users: {
    all: () => store.users,
    byId: id => store.users.find(u => u.id === Number(id)),
    byEmail: e => store.users.find(u => u.email === String(e).toLowerCase()),
    byUsername: u => store.users.find(x => x.username.toLowerCase() === String(u).toLowerCase()),
    insert: o => { const id = store.seq.users++; const row = Object.assign({ id }, o); store.users.push(row); return row; },
    update: (id, patch) => { const r = store.users.find(u => u.id === Number(id)); if (r) Object.assign(r, patch); },
    remove: id => { store.users = store.users.filter(u => u.id !== Number(id)); }
  },
  sessions: {
    insert: o => store.sessions.push(o),
    find: t => store.sessions.find(s => s.token === t && s.expires_at > Date.now()),
    byUser: id => store.sessions.filter(s => s.user_id === Number(id) && s.expires_at > Date.now())
      .sort((a, b) => b.created_at - a.created_at),
    delete: t => { store.sessions = store.sessions.filter(s => s.token !== t); },
    deleteOthers: (uid, token) => { store.sessions = store.sessions.filter(s => !(s.user_id === Number(uid) && s.token !== token)); },
    deleteByUser: uid => { store.sessions = store.sessions.filter(s => s.user_id !== Number(uid)); }
  },
  servers: {
    all: () => store.servers,
    byId: id => store.servers.find(s => s.id === Number(id)),
    byInvite: c => store.servers.find(s => s.invite_code === String(c)),
    mine: uid => store.members.filter(m => m.user_id === Number(uid))
      .sort((a, b) => a.joined_at - b.joined_at)
      .map(m => store.servers.find(s => s.id === m.server_id)).filter(Boolean),
    insert: o => { const id = store.seq.servers++; const row = Object.assign({ id }, o); store.servers.push(row); return row; },
    update: (id, patch) => { const r = store.servers.find(s => s.id === Number(id)); if (r) Object.assign(r, patch); },
    remove: id => {
      const sid = Number(id);
      store.servers = store.servers.filter(s => s.id !== sid);
      store.members = store.members.filter(m => m.server_id !== sid);
      const chans = store.channels.filter(c => c.server_id === sid).map(c => c.id);
      store.channels = store.channels.filter(c => c.server_id !== sid);
      store.messages = store.messages.filter(m => !chans.includes(m.channel_id));
    }
  },
  members: {
    get: (sid, uid) => store.members.find(m => m.server_id === Number(sid) && m.user_id === Number(uid)),
    count: sid => store.members.filter(m => m.server_id === Number(sid)).length,
    add: o => { store.members.push(o); },
    remove: (sid, uid) => { store.members = store.members.filter(m => !(m.server_id === Number(sid) && m.user_id === Number(uid))); },
    list: sid => store.members.filter(m => m.server_id === Number(sid))
      .map(m => ({ id: m.user_id, username: (store.users.find(u => u.id === m.user_id) || {}).username || '?', role: m.role }))
      .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.username.localeCompare(b.username)))
  },
  channels: {
    byId: id => store.channels.find(c => c.id === Number(id)),
    byServer: sid => store.channels.filter(c => c.server_id === Number(sid)).sort((a, b) => a.position - b.position || a.id - b.id),
    exists: (sid, name, except) => store.channels.find(c => c.server_id === Number(sid) && c.name.toLowerCase() === String(name).toLowerCase() && c.id !== Number(except || 0)),
    nextPos: sid => store.channels.filter(c => c.server_id === Number(sid)).reduce((mx, c) => Math.max(mx, c.position + 1), 0),
    insert: o => { const id = store.seq.channels++; const row = Object.assign({ id }, o); store.channels.push(row); return row; },
    update: (id, patch) => { const r = store.channels.find(c => c.id === Number(id)); if (r) Object.assign(r, patch); },
    remove: id => { store.channels = store.channels.filter(c => c.id !== Number(id)); }
  },
  messages: {
    byId: id => store.messages.find(m => m.id === Number(id)),
    byChannel: cid => store.messages.filter(m => m.channel_id === Number(cid))
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id),
    insert: o => { const id = store.seq.messages++; const row = Object.assign({ id }, o); store.messages.push(row); return row; },
    update: (id, patch) => { const r = store.messages.find(m => m.id === Number(id)); if (r) Object.assign(r, patch); },
    remove: id => { store.messages = store.messages.filter(m => m.id !== Number(id)); }
  },
  save: () => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(store)); } catch (e) { /* диск только для чтения */ }
  }
};

// --- живая доставка событий (Server-Sent Events) ---
const listeners = new Map(); // userId -> Set(res)
function subscribe(userId, res) {
  if (!listeners.has(userId)) listeners.set(userId, new Set());
  listeners.get(userId).add(res);
  res.on('close', () => {
    const set = listeners.get(userId);
    if (set) { set.delete(res); if (!set.size) listeners.delete(userId); }
  });
}
function emitTo(userIds, event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  userIds.forEach(uid => {
    const set = listeners.get(Number(uid));
    if (set) set.forEach(res => { try { res.write(payload); } catch (e) {} });
  });
}
function serverAudience(serverId) {
  return store.members.filter(m => m.server_id === Number(serverId)).map(m => m.user_id);
}

if (fs.existsSync(DB_FILE)) {
  try { Object.assign(store, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch (e) { console.log('Не удалось прочитать базу, начинаем с пустой'); }
}
setInterval(() => db.save(), 5000);

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
  db.sessions.insert({ token, user_id: userId, user_agent: (req.headers['user-agent'] || '').slice(0, 200), created_at: now, expires_at: now + (remember ? 30 * DAY : DAY) });
  setCookie(req, res, token, remember ? 30 * 86400 : undefined);
}
function auth(req, res, next) {
  const t = cookies(req).sid;
  const s = t && db.sessions.find(t);
  if (!s) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  const u = db.users.byId(s.user_id);
  if (!u) return res.status(401).json({ error: 'Нужно войти в аккаунт' });
  req.user = { id: u.id, email: u.email, username: u.username, bio: u.bio || '', created_at: u.created_at };
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
  if (db.users.byEmail(email)) return res.status(409).json({ error: 'Эта почта уже занята' });
  if (db.users.byUsername(username)) return res.status(409).json({ error: 'Этот ник уже занят' });
  const u = db.users.insert({ email: String(email).toLowerCase(), username, password_hash: bcrypt.hashSync(password, 10), bio: '', created_at: Date.now() });
  createSession(req, res, u.id, !!remember);
  db.save();
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { login, password, remember } = req.body || {};
  if (limited(req.ip)) return res.status(429).json({ error: 'Слишком много попыток, подожди 15 минут' });
  const u = db.users.byEmail(login) || db.users.byUsername(login);
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) return res.status(401).json({ error: 'Неверный логин или пароль' });
  createSession(req, res, u.id, !!remember);
  db.save();
  res.json({ ok: true });
});

app.post('/api/logout', auth, (req, res) => {
  db.sessions.delete(req.token);
  db.save();
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.post('/api/logout-all', auth, (req, res) => {
  db.sessions.deleteOthers(req.user.id, req.token);
  db.save();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

app.patch('/api/me', auth, (req, res) => {
  const { username, bio } = req.body || {};
  if (username !== undefined && username !== req.user.username) {
    if (!NICK_RE.test(username)) return res.status(400).json({ error: 'Ник: 3–32 символа, латиница, цифры, _ и .' });
    const other = db.users.byUsername(username);
    if (other && other.id !== req.user.id) return res.status(409).json({ error: 'Этот ник уже занят' });
    db.users.update(req.user.id, { username });
    req.user.username = username;
  }
  if (bio !== undefined) { const b = String(bio).slice(0, 190); db.users.update(req.user.id, { bio: b }); req.user.bio = b; }
  db.save();
  res.json(req.user);
});

app.post('/api/password', auth, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.users.byId(req.user.id);
  if (!bcrypt.compareSync(current || '', u.password_hash)) return res.status(400).json({ error: 'Текущий пароль неверный' });
  if (!next || next.length < 8) return res.status(400).json({ error: 'Новый пароль минимум 8 символов' });
  db.users.update(req.user.id, { password_hash: bcrypt.hashSync(next, 10) });
  db.sessions.deleteOthers(req.user.id, req.token);
  db.save();
  res.json({ ok: true });
});

app.get('/api/sessions', auth, (req, res) => {
  res.json(db.sessions.byUser(req.user.id).map(s => ({
    id: s.token.slice(0, 12), current: s.token === req.token, user_agent: s.user_agent, created_at: s.created_at
  })));
});

app.delete('/api/me', auth, (req, res) => {
  const u = db.users.byId(req.user.id);
  if (!bcrypt.compareSync((req.body || {}).password || '', u.password_hash)) return res.status(400).json({ error: 'Неверный пароль' });
  store.servers = store.servers.filter(s => s.owner_id !== req.user.id);
  store.members = store.members.filter(m => m.user_id !== req.user.id);
  db.sessions.deleteByUser(req.user.id);
  db.users.remove(req.user.id);
  db.save();
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});
// ---------- серверы ----------
function membership(serverId, userId) { return db.members.get(serverId, userId); }
function makeInvite() {
  let code;
  do { code = crypto.randomBytes(5).toString('hex'); } while (db.servers.byInvite(code));
  return code;
}
function serverInfo(s, userId) {
  return { id: s.id, name: s.name, icon: s.icon, owner: s.owner_id === userId, invite: s.invite_code, members: db.members.count(s.id) };
}

app.get('/api/servers', auth, (req, res) => {
  res.json(db.servers.mine(req.user.id).map(s => serverInfo(s, req.user.id)));
});

app.post('/api/servers', auth, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Название сервера: 2–40 символов' });
  const icon = String((req.body || {}).icon || '').trim().slice(0, 4);
  const now = Date.now();
  const s = db.servers.insert({ name, owner_id: req.user.id, icon, invite_code: makeInvite(), created_at: now });
  db.members.add({ server_id: s.id, user_id: req.user.id, role: 'owner', joined_at: now });
  const first = db.channels.insert({ server_id: s.id, name: 'общий', type: 'text', position: 0, created_at: now });
  db.channels.insert({ server_id: s.id, name: 'Основной', type: 'voice', position: 1, created_at: now });
  db.save();
  res.json({ id: s.id, name, icon, owner: true, invite: s.invite_code, members: 1, firstChannel: first.id });
});

app.get('/api/servers/:id', auth, (req, res) => {
  const s = db.servers.byId(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  const m = membership(s.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Ты не участник этого сервера' });
  res.json({
    ...serverInfo(s, req.user.id), myRole: m.role,
    channels: db.channels.byServer(s.id).map(c => ({ id: c.id, name: c.name, type: c.type, position: c.position })),
    members: db.members.list(s.id)
  });
});

app.patch('/api/servers/:id', auth, (req, res) => {
  const s = db.servers.byId(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  const m = membership(s.id, req.user.id);
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) return res.status(403).json({ error: 'Менять сервер может только владелец' });
  const name = req.body && req.body.name !== undefined ? String(req.body.name).trim() : null;
  const icon = req.body && req.body.icon !== undefined ? String(req.body.icon).trim().slice(0, 4) : null;
  if (name !== null) {
    if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Название сервера: 2–40 символов' });
    db.servers.update(s.id, { name });
  }
  if (icon !== null) db.servers.update(s.id, { icon });
  db.save();
  res.json({ ok: true });
});

app.post('/api/servers/:id/invite', auth, (req, res) => {
  const s = db.servers.byId(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  const m = membership(s.id, req.user.id);
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) return res.status(403).json({ error: 'Обновить ссылку может только владелец' });
  const code = makeInvite();
  db.servers.update(s.id, { invite_code: code });
  db.save();
  res.json({ invite: code });
});

app.delete('/api/servers/:id', auth, (req, res) => {
  const s = db.servers.byId(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'Удалить сервер может только владелец' });
  db.servers.remove(s.id);
  db.save();
  res.json({ ok: true });
});

app.post('/api/servers/:id/leave', auth, (req, res) => {
  const s = db.servers.byId(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  if (s.owner_id === req.user.id) return res.status(400).json({ error: 'Владелец не может выйти: удали сервер' });
  db.members.remove(s.id, req.user.id);
  db.save();
  res.json({ ok: true });
});

app.post('/api/join/:code', auth, (req, res) => {
  const s = db.servers.byInvite(String(req.params.code || '').trim());
  if (!s) return res.status(404).json({ error: 'Приглашение не найдено' });
  if (membership(s.id, req.user.id)) return res.json({ id: s.id, already: true });
  db.members.add({ server_id: s.id, user_id: req.user.id, role: 'member', joined_at: Date.now() });
  db.save();
  res.json({ id: s.id, name: s.name });
});

// ---------- поток событий ----------
app.get('/api/events', auth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('event: hello\ndata: {}\n\n');
  subscribe(req.user.id, res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => clearInterval(ping));
});

// ---------- сообщения ----------
function channelAccess(channelId, userId) {
  const c = db.channels.byId(channelId);
  if (!c) return { error: 'Канал не найден' };
  const m = db.members.get(c.server_id, userId);
  if (!m) return { error: 'Ты не участник этого сервера' };
  return { channel: c, member: m };
}
function publicMessage(m) {
  const u = db.users.byId(m.user_id) || {};
  const parent = m.reply_to ? db.messages.byId(m.reply_to) : null;
  return {
    id: m.id, channel_id: m.channel_id, user_id: m.user_id,
    username: u.username || '?', text: m.text,
    reply_to: m.reply_to || null,
    reply_text: parent ? parent.text.slice(0, 90) : null,
    reply_username: parent ? ((db.users.byId(parent.user_id) || {}).username || '?') : null,
    created_at: m.created_at, edited_at: m.edited_at || null
  };
}

app.get('/api/channels/:id/messages', auth, (req, res) => {
  const acc = channelAccess(req.params.id, req.user.id);
  if (acc.error) return res.status(403).json({ error: acc.error });
  const all = db.messages.byChannel(acc.channel.id);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const before = req.query.before ? Number(req.query.before) : null;
  let slice = all;
  if (before) slice = all.filter(m => m.id < before);
  const out = slice.slice(-limit);
  res.json({
    channel: { id: acc.channel.id, name: acc.channel.name, type: acc.channel.type, server_id: acc.channel.server_id },
    messages: out.map(publicMessage),
    has_more: slice.length > out.length
  });
});

app.post('/api/channels/:id/messages', auth, (req, res) => {
  const acc = channelAccess(req.params.id, req.user.id);
  if (acc.error) return res.status(403).json({ error: acc.error });
  if (acc.channel.type !== 'text') return res.status(400).json({ error: 'В голосовой канал писать нельзя' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Сообщение не может быть пустым' });
  if (text.length > 2000) return res.status(400).json({ error: 'Слишком длинное сообщение (максимум 2000)' });
  let replyTo = null;
  if ((req.body || {}).reply_to) {
    const parent = db.messages.byId(req.body.reply_to);
    if (parent && parent.channel_id === acc.channel.id) replyTo = parent.id;
  }
  const m = db.messages.insert({ channel_id: acc.channel.id, user_id: req.user.id, text, reply_to: replyTo, created_at: Date.now(), edited_at: null });
  db.save();
  const out = publicMessage(m);
  emitTo(serverAudience(acc.channel.server_id), 'message', out);
  res.json(out);
});

app.patch('/api/messages/:id', auth, (req, res) => {
  const m = db.messages.byId(req.params.id);
  if (!m) return res.status(404).json({ error: 'Сообщение не найдено' });
  const acc = channelAccess(m.channel_id, req.user.id);
  if (acc.error) return res.status(403).json({ error: acc.error });
  if (m.user_id !== req.user.id) return res.status(403).json({ error: 'Можно править только свои сообщения' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Сообщение не может быть пустым' });
  if (text.length > 2000) return res.status(400).json({ error: 'Слишком длинное сообщение' });
  db.messages.update(m.id, { text, edited_at: Date.now() });
  db.save();
  const out = publicMessage(db.messages.byId(m.id));
  emitTo(serverAudience(acc.channel.server_id), 'message-edit', out);
  res.json(out);
});

app.delete('/api/messages/:id', auth, (req, res) => {
  const m = db.messages.byId(req.params.id);
  if (!m) return res.status(404).json({ error: 'Сообщение не найдено' });
  const acc = channelAccess(m.channel_id, req.user.id);
  if (acc.error) return res.status(403).json({ error: acc.error });
  const canModerate = acc.member.role === 'owner' || acc.member.role === 'admin';
  if (m.user_id !== req.user.id && !canModerate) return res.status(403).json({ error: 'Можно удалять только свои сообщения' });
  db.messages.remove(m.id);
  db.save();
  emitTo(serverAudience(acc.channel.server_id), 'message-delete', { id: m.id, channel_id: m.channel_id });
  res.json({ ok: true });
});

app.get('/api/channels/:id/search', auth, (req, res) => {
  const acc = channelAccess(req.params.id, req.user.id);
  if (acc.error) return res.status(403).json({ error: acc.error });
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ messages: [] });
  const found = db.messages.byChannel(acc.channel.id).filter(m => m.text.toLowerCase().includes(q)).slice(-50);
  res.json({ messages: found.map(publicMessage) });
});

// ---------- каналы ----------
app.post('/api/servers/:id/channels', auth, (req, res) => {
  const s = db.servers.byId(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  const m = membership(s.id, req.user.id);
  if (!m) return res.status(403).json({ error: 'Ты не участник этого сервера' });
  if (m.role !== 'owner' && m.role !== 'admin') return res.status(403).json({ error: 'Создавать каналы может владелец' });
  const name = String((req.body || {}).name || '').trim();
  const type = (req.body || {}).type === 'voice' ? 'voice' : 'text';
  if (!CHAN_RE.test(name)) return res.status(400).json({ error: 'Название канала: 1–40 символов' });
  if (db.channels.exists(s.id, name)) return res.status(409).json({ error: 'Канал с таким названием уже есть' });
  const pos = db.channels.nextPos(s.id);
  const c = db.channels.insert({ server_id: s.id, name, type, position: pos, created_at: Date.now() });
  db.save();
  res.json({ id: c.id, name, type, position: pos });
});

app.patch('/api/channels/:id', auth, (req, res) => {
  const c = db.channels.byId(req.params.id);
  if (!c) return res.status(404).json({ error: 'Канал не найден' });
  const m = membership(c.server_id, req.user.id);
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) return res.status(403).json({ error: 'Переименовать канал может только владелец' });
  const name = String((req.body || {}).name || '').trim();
  if (!CHAN_RE.test(name)) return res.status(400).json({ error: 'Название канала: 1–40 символов' });
  if (db.channels.exists(c.server_id, name, c.id)) return res.status(409).json({ error: 'Канал с таким названием уже есть' });
  db.channels.update(c.id, { name });
  db.save();
  res.json({ ok: true, name });
});

app.delete('/api/channels/:id', auth, (req, res) => {
  const c = db.channels.byId(req.params.id);
  if (!c) return res.status(404).json({ error: 'Канал не найден' });
  const m = membership(c.server_id, req.user.id);
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) return res.status(403).json({ error: 'Удалить канал может только владелец' });
  store.messages = store.messages.filter(x => x.channel_id !== c.id);
  db.channels.remove(c.id);
  db.save();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Sonari запущен на порту ' + PORT));
