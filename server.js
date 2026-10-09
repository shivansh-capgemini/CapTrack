// CapTrack — attendance tracking for local events.
// Run with `node server.js`. Set DATABASE_URL to store data in Postgres
// (needed on hosts like Render whose disk is wiped on restart).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Behind a hosting proxy every request arrives from the proxy, so read the
// visitor's address from X-Forwarded-For instead. Render sets RENDER=true.
const TRUST_PROXY = Boolean(process.env.TRUST_PROXY || process.env.RENDER);

const ATTENDEE_COOKIE = 'ct_att';
const ADMIN_COOKIE = 'ct_admin';
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const ATTENDEE_COOKIE_MAX_AGE = 2 * 365 * 24 * 60 * 60; // seconds

// ---------------------------------------------------------------------------
// Storage: the whole state is one JSON document, kept in memory and saved
// after every change (see store.js).
// ---------------------------------------------------------------------------

function freshDb() {
  return {
    settings: {
      passwordHash: null,
      sessionSecret: crypto.randomBytes(32).toString('hex'),
      sessionVersion: 1,
      allowedDomains: ['capgemini.com'],
    },
    events: [],
    attendees: [],
    checkins: [],
  };
}

const store = createStore({ databaseUrl: process.env.DATABASE_URL, dataDir: DATA_DIR });
let db = freshDb();
const save = () => store.save(db);

const ready = (async () => {
  const loaded = await store.load();
  if (loaded) {
    db = loaded;
    db.settings = { ...freshDb().settings, ...db.settings };
    db.events ||= [];
    db.attendees ||= [];
    db.checkins ||= [];
  }
  // Lets a hosted deployment set the first admin password without exposing
  // the one-time setup screen to whoever finds the site first.
  if (!db.settings.passwordHash && process.env.ADMIN_PASSWORD) {
    db.settings.passwordHash = hashPassword(process.env.ADMIN_PASSWORD);
  }
  await save();
})();

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9-]+\.)+[a-z]{2,}$/;

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function normalizeDomain(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^@+/, '');
}

function validateEmail(raw) {
  const email = normalizeEmail(raw);
  if (!email) return { error: 'Enter your work email address.' };
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { error: 'That doesn’t look like a valid email address. Check for typos.' };
  }
  const domain = email.split('@')[1];
  const allowed = db.settings.allowedDomains;
  if (!allowed.includes(domain)) {
    const list = allowed.map((d) => '@' + d).join(', ');
    return { error: `Use your work email ending in ${list}.` };
  }
  return { email };
}

function eventStatus(ev, now = Date.now()) {
  if (ev.endedAt) return 'ended';
  if (ev.override === 'open') return 'open';
  if (now >= Date.parse(ev.endAt)) return 'ended';
  if (ev.override === 'closed') return 'paused';
  if (now < Date.parse(ev.startAt)) return 'scheduled';
  return 'open';
}

function checkinsFor(eventId) {
  return db.checkins
    .filter((c) => c.eventId === eventId)
    .map((c) => {
      const a = db.attendees.find((x) => x.id === c.attendeeId);
      return { attendeeId: c.attendeeId, email: a ? a.email : '(removed)', at: c.at, method: c.method };
    })
    .sort((x, y) => x.at.localeCompare(y.at));
}

function publicEvent(ev) {
  return {
    id: ev.id,
    title: ev.title,
    description: ev.description,
    location: ev.location,
    startAt: ev.startAt,
    endAt: ev.endAt,
    status: eventStatus(ev),
  };
}

function adminEvent(ev) {
  return {
    ...publicEvent(ev),
    override: ev.override,
    endedAt: ev.endedAt,
    createdAt: ev.createdAt,
    count: db.checkins.filter((c) => c.eventId === ev.id).length,
  };
}

function shortId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id;
  do {
    id = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
  } while (db.events.some((e) => e.id === id));
  return id;
}

function firstNameFrom(email) {
  const local = email.split('@')[0].split(/[._-]/)[0] || '';
  return local ? local[0].toUpperCase() + local.slice(1) : '';
}

function readEventInput(body, existing) {
  const title = String(body.title ?? existing?.title ?? '').trim();
  const description = String(body.description ?? existing?.description ?? '').trim();
  const location = String(body.location ?? existing?.location ?? '').trim();
  const startAt = body.startAt ?? existing?.startAt;
  const endAt = body.endAt ?? existing?.endAt;
  if (!title) return { error: 'Give the event a title.' };
  if (title.length > 120) return { error: 'Keep the title under 120 characters.' };
  if (description.length > 1000) return { error: 'Keep the description under 1000 characters.' };
  if (location.length > 200) return { error: 'Keep the location under 200 characters.' };
  const s = Date.parse(startAt);
  const e = Date.parse(endAt);
  if (Number.isNaN(s) || Number.isNaN(e)) return { error: 'Set when check-in opens and closes.' };
  if (e <= s) return { error: 'Check-in must close after it opens.' };
  return {
    value: {
      title,
      description,
      location,
      startAt: new Date(s).toISOString(),
      endAt: new Date(e).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sign(value) {
  return crypto
    .createHmac('sha256', db.settings.sessionSecret)
    .update(`${value}.${db.settings.sessionVersion}`)
    .digest('hex');
}

function makeAdminToken() {
  const exp = String(Date.now() + ADMIN_SESSION_MS);
  return `${exp}.${sign(exp)}`;
}

function isAdmin(req) {
  const token = req.cookies[ADMIN_COOKIE];
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use at least 8 characters for the password.';
  if (pw.length > 200) return 'Keep the password under 200 characters.';
  return null;
}

function clientIp(req) {
  const fwd = TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress;
}

// Simple in-memory brute-force guard for the login endpoint.
const loginFailures = new Map();
function loginBlocked(ip) {
  const rec = loginFailures.get(ip);
  return rec && rec.count >= 5 && Date.now() - rec.first < 15 * 60 * 1000;
}
function noteLoginFailure(ip) {
  const rec = loginFailures.get(ip);
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000) loginFailures.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(req, name, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    secure ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

const fail = (res, status, message) => send(res, status, { error: message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) {
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

// Tiny router: [method, pattern, handler]. Patterns use :params.
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'
  );
  routes.push({ method, re, keys, handler });
}

function requireAdmin(handler) {
  return (req, res, ctx) => (isAdmin(req) ? handler(req, res, ctx) : fail(res, 401, 'Sign in to continue.'));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function currentAttendee(req) {
  const token = req.cookies[ATTENDEE_COOKIE];
  return token ? db.attendees.find((a) => a.token === token) || null : null;
}

function meView(att) {
  return att ? { email: att.email, firstName: firstNameFrom(att.email) } : null;
}

route('GET', '/api/public/events', (req, res) => {
  const att = currentAttendee(req);
  const open = db.events
    .filter((e) => eventStatus(e) === 'open')
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .map((e) => {
      const c = att && db.checkins.find((x) => x.eventId === e.id && x.attendeeId === att.id);
      return { ...publicEvent(e), checkedInAt: c ? c.at : null };
    });
  send(res, 200, { events: open, me: meView(att), domains: db.settings.allowedDomains });
});

route('GET', '/api/public/events/:id', (req, res, { id }) => {
  const ev = db.events.find((e) => e.id === id);
  if (!ev) return fail(res, 404, 'This event link isn’t valid. Ask the organiser for the right one.');
  const att = currentAttendee(req);
  const c = att && db.checkins.find((x) => x.eventId === ev.id && x.attendeeId === att.id);
  send(res, 200, {
    event: { ...publicEvent(ev), checkedInAt: c ? c.at : null },
    me: meView(att),
    domains: db.settings.allowedDomains,
  });
});

route('POST', '/api/public/checkin', async (req, res) => {
  const body = await readBody(req);
  const ev = db.events.find((e) => e.id === body.eventId);
  if (!ev) return fail(res, 404, 'That event no longer exists.');
  const status = eventStatus(ev);
  if (status !== 'open') {
    const why = {
      scheduled: 'Check-in for this event hasn’t opened yet.',
      paused: 'Check-in for this event is paused right now.',
      ended: 'Check-in for this event has closed.',
    }[status];
    return fail(res, 409, why);
  }

  let att = currentAttendee(req);
  const headers = {};
  let method = 'auto';
  if (body.email !== undefined) {
    const v = validateEmail(body.email);
    if (v.error) return fail(res, 422, v.error);
    method = 'manual';
    att = db.attendees.find((a) => a.email === v.email);
    if (!att) {
      att = {
        id: crypto.randomUUID(),
        email: v.email,
        token: crypto.randomBytes(24).toString('hex'),
        createdAt: new Date().toISOString(),
      };
      db.attendees.push(att);
    }
    headers['Set-Cookie'] = cookie(req, ATTENDEE_COOKIE, att.token, ATTENDEE_COOKIE_MAX_AGE);
  }
  if (!att) return fail(res, 422, 'Enter your work email address.');

  let checkin = db.checkins.find((c) => c.eventId === ev.id && c.attendeeId === att.id);
  const already = Boolean(checkin);
  if (!checkin) {
    checkin = { eventId: ev.id, attendeeId: att.id, at: new Date().toISOString(), method };
    db.checkins.push(checkin);
  }
  await save();
  send(
    res,
    200,
    { event: publicEvent(ev), me: meView(att), checkedInAt: checkin.at, alreadyCheckedIn: already },
    headers
  );
});

// Correct the email remembered on this device. Updates every past check-in too.
route('PATCH', '/api/public/me', async (req, res) => {
  const body = await readBody(req);
  const att = currentAttendee(req);
  if (!att) return fail(res, 404, 'This device doesn’t have a saved email yet. Check in first.');
  const v = validateEmail(body.email);
  if (v.error) return fail(res, 422, v.error);
  if (v.email === att.email) return send(res, 200, { me: meView(att) });

  const other = db.attendees.find((a) => a.email === v.email);
  if (other) {
    // The new address already exists: fold this record's check-ins into it.
    for (const c of db.checkins.filter((x) => x.attendeeId === att.id)) {
      const dup = db.checkins.some((x) => x.attendeeId === other.id && x.eventId === c.eventId);
      if (!dup) c.attendeeId = other.id;
    }
    db.checkins = db.checkins.filter((x) => x.attendeeId !== att.id);
    db.attendees = db.attendees.filter((a) => a.id !== att.id);
    await save();
    return send(res, 200, { me: meView(other) }, {
      'Set-Cookie': cookie(req, ATTENDEE_COOKIE, other.token, ATTENDEE_COOKIE_MAX_AGE),
    });
  }
  att.email = v.email;
  att.updatedAt = new Date().toISOString();
  await save();
  send(res, 200, { me: meView(att) });
});

route('POST', '/api/public/forget', (req, res) => {
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, ATTENDEE_COOKIE, '', 0) });
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

route('GET', '/api/admin/session', (req, res) => {
  send(res, 200, { setupRequired: !db.settings.passwordHash, authenticated: isAdmin(req) });
});

route('POST', '/api/admin/setup', async (req, res) => {
  if (db.settings.passwordHash) return fail(res, 409, 'An admin password is already set. Sign in instead.');
  const { password } = await readBody(req);
  const err = validatePassword(password);
  if (err) return fail(res, 422, err);
  db.settings.passwordHash = hashPassword(password);
  await save();
  send(res, 200, { ok: true }, {
    'Set-Cookie': cookie(req, ADMIN_COOKIE, makeAdminToken(), ADMIN_SESSION_MS / 1000),
  });
});

route('POST', '/api/admin/login', async (req, res) => {
  const ip = clientIp(req);
  if (loginBlocked(ip)) return fail(res, 429, 'Too many attempts. Wait 15 minutes and try again.');
  const { password } = await readBody(req);
  if (typeof password !== 'string' || !verifyPassword(password, db.settings.passwordHash)) {
    noteLoginFailure(ip);
    return fail(res, 401, 'That password is incorrect.');
  }
  loginFailures.delete(ip);
  send(res, 200, { ok: true }, {
    'Set-Cookie': cookie(req, ADMIN_COOKIE, makeAdminToken(), ADMIN_SESSION_MS / 1000),
  });
});

route('POST', '/api/admin/logout', (req, res) => {
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, ADMIN_COOKIE, '', 0) });
});

route('POST', '/api/admin/password', requireAdmin(async (req, res) => {
  const { current, next } = await readBody(req);
  if (typeof current !== 'string' || !verifyPassword(current, db.settings.passwordHash)) {
    return fail(res, 401, 'Your current password is incorrect.');
  }
  const err = validatePassword(next);
  if (err) return fail(res, 422, err);
  db.settings.passwordHash = hashPassword(next);
  db.settings.sessionVersion++; // signs out every other session
  await save();
  send(res, 200, { ok: true }, {
    'Set-Cookie': cookie(req, ADMIN_COOKIE, makeAdminToken(), ADMIN_SESSION_MS / 1000),
  });
}));

route('GET', '/api/admin/settings', requireAdmin((req, res) => {
  send(res, 200, { allowedDomains: db.settings.allowedDomains });
}));

route('PUT', '/api/admin/settings', requireAdmin(async (req, res) => {
  const body = await readBody(req);
  if (!Array.isArray(body.allowedDomains)) return fail(res, 422, 'Send a list of domains.');
  const domains = [...new Set(body.allowedDomains.map(normalizeDomain).filter(Boolean))];
  const bad = domains.find((d) => !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d));
  if (bad) return fail(res, 422, `"${bad}" isn’t a valid domain. Use a format like sogeti.com.`);
  if (!domains.length) return fail(res, 422, 'Keep at least one allowed domain, or nobody can check in.');
  db.settings.allowedDomains = domains;
  await save();
  send(res, 200, { allowedDomains: domains });
}));

route('GET', '/api/admin/events', requireAdmin((req, res) => {
  const events = db.events.map(adminEvent).sort((a, b) => b.startAt.localeCompare(a.startAt));
  send(res, 200, { events, totalAttendees: db.attendees.length });
}));

route('POST', '/api/admin/events', requireAdmin(async (req, res) => {
  const input = readEventInput(await readBody(req));
  if (input.error) return fail(res, 422, input.error);
  const ev = {
    id: shortId(),
    ...input.value,
    override: null,
    endedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.events.push(ev);
  await save();
  send(res, 201, { event: adminEvent(ev) });
}));

function findEvent(res, id) {
  const ev = db.events.find((e) => e.id === id);
  if (!ev) fail(res, 404, 'That event doesn’t exist.');
  return ev;
}

route('GET', '/api/admin/events/:id', requireAdmin((req, res, { id }) => {
  const ev = findEvent(res, id);
  if (ev) send(res, 200, { event: adminEvent(ev), checkins: checkinsFor(ev.id) });
}));

route('PUT', '/api/admin/events/:id', requireAdmin(async (req, res, { id }) => {
  const ev = findEvent(res, id);
  if (!ev) return;
  const input = readEventInput(await readBody(req), ev);
  if (input.error) return fail(res, 422, input.error);
  Object.assign(ev, input.value);
  await save();
  send(res, 200, { event: adminEvent(ev) });
}));

route('DELETE', '/api/admin/events/:id', requireAdmin(async (req, res, { id }) => {
  const ev = findEvent(res, id);
  if (!ev) return;
  db.events = db.events.filter((e) => e.id !== id);
  db.checkins = db.checkins.filter((c) => c.eventId !== id);
  await save();
  send(res, 200, { ok: true });
}));

route('POST', '/api/admin/events/:id/state', requireAdmin(async (req, res, { id }) => {
  const ev = findEvent(res, id);
  if (!ev) return;
  const { action } = await readBody(req);
  switch (action) {
    case 'start': ev.override = 'open'; ev.endedAt = null; break;
    case 'stop': ev.override = 'closed'; break;
    case 'schedule': ev.override = null; break;
    case 'end': ev.override = null; ev.endedAt = new Date().toISOString(); break;
    default: return fail(res, 422, 'Unknown action.');
  }
  await save();
  send(res, 200, { event: adminEvent(ev) });
}));

route('POST', '/api/admin/events/:id/checkins', requireAdmin(async (req, res, { id }) => {
  const ev = findEvent(res, id);
  if (!ev) return;
  const v = validateEmail((await readBody(req)).email);
  if (v.error) return fail(res, 422, v.error);
  let att = db.attendees.find((a) => a.email === v.email);
  if (!att) {
    att = {
      id: crypto.randomUUID(),
      email: v.email,
      token: crypto.randomBytes(24).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    db.attendees.push(att);
  }
  if (db.checkins.some((c) => c.eventId === ev.id && c.attendeeId === att.id)) {
    return fail(res, 409, `${att.email} is already on the list.`);
  }
  db.checkins.push({ eventId: ev.id, attendeeId: att.id, at: new Date().toISOString(), method: 'admin' });
  await save();
  send(res, 201, { checkins: checkinsFor(ev.id) });
}));

route('DELETE', '/api/admin/events/:id/checkins/:attendeeId', requireAdmin(async (req, res, { id, attendeeId }) => {
  const ev = findEvent(res, id);
  if (!ev) return;
  db.checkins = db.checkins.filter((c) => !(c.eventId === ev.id && c.attendeeId === attendeeId));
  await save();
  send(res, 200, { checkins: checkinsFor(ev.id) });
}));

route('GET', '/api/admin/events/:id/export.csv', requireAdmin((req, res, { id }) => {
  const ev = findEvent(res, id);
  if (!ev) return;
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const rows = [['email', 'checked_in_at', 'method'], ...checkinsFor(ev.id).map((c) => [c.email, c.at, c.method])];
  const csv = rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
  const name = ev.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'event';
  send(res, 200, csv, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}-attendance.csv"`,
  });
}));

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const PAGES = {
  '/': 'index.html',
  '/admin': 'admin.html',
};

const server = http.createServer(async (req, res) => {
  req.cookies = parseCookies(req.headers.cookie);
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (pathname.startsWith('/api/')) {
      // Writes must be JSON: blocks cross-site form posts riding on cookies.
      if (req.method !== 'GET' && req.method !== 'DELETE' && !/application\/json/.test(req.headers['content-type'] || '')) {
        return fail(res, 415, 'Send requests as JSON.');
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return await r.handler(req, res, params);
      }
      return fail(res, 404, 'Not found.');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (PAGES[pathname]) return serveFile(res, path.join(PUBLIC_DIR, PAGES[pathname]));
    if (/^\/e\/[a-z0-9]+$/.test(pathname)) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));

    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
    return serveFile(res, file);
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message);
    console.error(err);
    return fail(res, 500, 'Something went wrong on the server. Try again.');
  }
});

if (require.main === module) {
  ready
    .then(() => {
      server.listen(PORT, () => {
        console.log(`CapTrack is running (data: ${store.describe})`);
        console.log(`  Check-in page: http://localhost:${PORT}/`);
        console.log(`  Admin portal:  http://localhost:${PORT}/admin`);
        if (!db.settings.passwordHash) console.log('  First visit to /admin will ask you to set the admin password.');
      });
    })
    .catch((err) => {
      console.error('Could not load CapTrack data:', err.message);
      process.exit(1);
    });
}

module.exports = { server, ready, eventStatus };
