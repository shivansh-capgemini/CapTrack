// End-to-end API tests. Run with `npm test`.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'captrack-test-'));
process.env.TRUST_PROXY = '1';
// Data written by the first version kept the device cookie on the attendee.
fs.writeFileSync(path.join(process.env.DATA_DIR, 'db.json'), JSON.stringify({
  settings: { allowedDomains: ['capgemini.com'] },
  events: [{ id: 'oldevt', title: 'Old', description: '', location: '', startAt: '2026-01-01T09:00:00.000Z', endAt: '2026-01-01T10:00:00.000Z', override: null, endedAt: null }],
  attendees: [{ id: 'a-old', email: 'old@capgemini.com', token: 'legacytoken', createdAt: '2026-01-01T09:00:00.000Z' }],
  checkins: [{ eventId: 'oldevt', attendeeId: 'a-old', at: '2026-01-01T09:05:00.000Z', method: 'manual' }],
}));
const { server, ready } = require('../server');

let base;
test.before(async () => { await ready; await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })); });
test.after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

// Minimal cookie-jar client.
function client() {
  const jar = {};
  return async (method, url, body, { raw = false, headers = {} } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return { status: res.status, body: raw ? await res.text() : await res.json(), headers: res.headers };
  };
}

const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

const admin = client();

test('devices remembered by the old data format keep working', async () => {
  const legacy = client();
  const r = await legacy('GET', '/api/public/events', undefined, { headers: { Cookie: 'ct_att=legacytoken' } });
  assert.strictEqual(r.body.me.email, 'old@capgemini.com');
});
let live, later;

test('first run: setup sets the password once, then requires sign-in', async () => {
  assert.deepStrictEqual((await admin('GET', '/api/admin/session')).body, { setupRequired: true, authenticated: false });
  assert.strictEqual((await admin('POST', '/api/admin/setup', { password: 'short' })).status, 422);
  assert.strictEqual((await admin('POST', '/api/admin/setup', { password: 'secret123' })).status, 200);
  assert.strictEqual((await client()('POST', '/api/admin/setup', { password: 'other1234' })).status, 409);
  assert.strictEqual((await client()('GET', '/api/admin/events')).status, 401);
  assert.strictEqual((await client()('POST', '/api/admin/login', { password: 'wrongpass' })).status, 401);
  const other = client();
  assert.strictEqual((await other('POST', '/api/admin/login', { password: 'secret123' })).status, 200);
  assert.strictEqual((await other('GET', '/api/admin/events')).status, 200);
});

test('admin creates events with validation', async () => {
  assert.strictEqual((await admin('POST', '/api/admin/events', { title: '', startAt: hours(0), endAt: hours(1) })).status, 422);
  assert.strictEqual((await admin('POST', '/api/admin/events', { title: 'X', startAt: hours(2), endAt: hours(1) })).status, 422);
  live = (await admin('POST', '/api/admin/events', { title: 'GenAI Talk', location: 'Auditorium', startAt: hours(-0.1), endAt: hours(2) })).body.event;
  later = (await admin('POST', '/api/admin/events', { title: 'Town Hall', startAt: hours(24), endAt: hours(26) })).body.event;
  assert.strictEqual(live.status, 'open');
  assert.strictEqual(later.status, 'scheduled');
});

test('public sees only open events', async () => {
  const r = await client()('GET', '/api/public/events');
  assert.deepStrictEqual(r.body.events.map((e) => e.id), [live.id]);
  assert.deepStrictEqual(r.body.domains, ['capgemini.com']);
  assert.strictEqual(r.body.me, null);
});

const jane = client();

test('check-in enforces allowed domains and remembers the device', async () => {
  const bad = await jane('POST', '/api/public/checkin', { eventId: live.id, email: 'jane@gmail.com' });
  assert.strictEqual(bad.status, 422);
  assert.match(bad.body.error, /@capgemini\.com/);

  const r = await jane('POST', '/api/public/checkin', { eventId: live.id, email: '  Jane.Doe@Capgemini.COM ' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.me.email, 'jane.doe@capgemini.com');
  assert.strictEqual(r.body.me.firstName, 'Jane');
  assert.strictEqual(r.body.alreadyCheckedIn, false);

  const again = await jane('POST', '/api/public/checkin', { eventId: live.id });
  assert.strictEqual(again.body.alreadyCheckedIn, true);
  const ev = (await jane('GET', '/api/public/events')).body;
  assert.strictEqual(ev.me.email, 'jane.doe@capgemini.com');
  assert.ok(ev.events[0].checkedInAt);
});

test('no check-in until an event opens; admin start opens it', async () => {
  assert.strictEqual((await jane('POST', '/api/public/checkin', { eventId: later.id })).status, 409);
  assert.strictEqual((await admin('POST', `/api/admin/events/${later.id}/state`, { action: 'start' })).body.event.status, 'open');
  const r = await jane('POST', '/api/public/checkin', { eventId: later.id });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.me.email, 'jane.doe@capgemini.com');
  assert.strictEqual((await admin('POST', `/api/admin/events/${later.id}/state`, { action: 'stop' })).body.event.status, 'paused');
  assert.strictEqual((await admin('POST', `/api/admin/events/${later.id}/state`, { action: 'schedule' })).body.event.status, 'scheduled');
});

test('editing email fixes every past check-in', async () => {
  const r = await jane('PATCH', '/api/public/me', { email: 'jane.doe2@capgemini.com' });
  assert.strictEqual(r.body.me.email, 'jane.doe2@capgemini.com');
  for (const id of [live.id, later.id]) {
    const d = (await admin('GET', `/api/admin/events/${id}`)).body;
    assert.deepStrictEqual(d.checkins.map((c) => c.email), ['jane.doe2@capgemini.com']);
  }
});

test('editing to an existing email merges without duplicates', async () => {
  const sam = client();
  await sam('POST', '/api/public/checkin', { eventId: live.id, email: 'sam@capgemini.com' });
  const r = await jane('PATCH', '/api/public/me', { email: 'sam@capgemini.com' });
  assert.strictEqual(r.body.me.email, 'sam@capgemini.com');
  assert.deepStrictEqual((await admin('GET', `/api/admin/events/${live.id}`)).body.checkins.map((c) => c.email), ['sam@capgemini.com']);
  assert.deepStrictEqual((await admin('GET', `/api/admin/events/${later.id}`)).body.checkins.map((c) => c.email), ['sam@capgemini.com']);
  assert.strictEqual((await jane('POST', '/api/public/checkin', { eventId: live.id })).body.alreadyCheckedIn, true);
});

test('typing someone else\'s email cannot rewrite their attendance', async () => {
  const victim = client();
  const v = await victim('POST', '/api/public/checkin', { eventId: live.id, email: 'victim@capgemini.com' });
  assert.strictEqual(v.status, 200);
  const attacker = client();
  await attacker('POST', '/api/public/checkin', { eventId: live.id, email: 'victim@capgemini.com' });
  const r = await attacker('PATCH', '/api/public/me', { email: 'attacker@capgemini.com' });
  assert.strictEqual(r.body.me.email, 'attacker@capgemini.com');
  const emails = (await admin('GET', `/api/admin/events/${live.id}`)).body.checkins.map((c) => c.email);
  assert.ok(emails.includes('victim@capgemini.com'), 'victim keeps their check-in');
  assert.ok(!emails.includes('attacker@capgemini.com'), 'attacker gains nothing they did not check in for');
  assert.strictEqual((await victim('GET', '/api/public/events')).body.me.email, 'victim@capgemini.com');
  // The victim can still correct their own address.
  assert.strictEqual((await victim('PATCH', '/api/public/me', { email: 'victim2@capgemini.com' })).body.me.email, 'victim2@capgemini.com');
  const after = (await admin('GET', `/api/admin/events/${live.id}`)).body.checkins.map((c) => c.email);
  assert.ok(after.includes('victim2@capgemini.com') && !after.includes('victim@capgemini.com'));
});

test('admin manages allowed domains', async () => {
  assert.strictEqual((await admin('PUT', '/api/admin/settings', { allowedDomains: [] })).status, 422);
  assert.strictEqual((await admin('PUT', '/api/admin/settings', { allowedDomains: ['not a domain'] })).status, 422);
  const r = await admin('PUT', '/api/admin/settings', { allowedDomains: ['capgemini.com', '@Sogeti.com'] });
  assert.deepStrictEqual(r.body.allowedDomains, ['capgemini.com', 'sogeti.com']);
  assert.strictEqual((await client()('POST', '/api/public/checkin', { eventId: live.id, email: 'lee@sogeti.com' })).status, 200);
});

test('admin adds and removes attendees by hand', async () => {
  assert.strictEqual((await admin('POST', `/api/admin/events/${live.id}/checkins`, { email: 'lee@sogeti.com' })).status, 409);
  const r = await admin('POST', `/api/admin/events/${live.id}/checkins`, { email: 'max@capgemini.com' });
  assert.strictEqual(r.status, 201);
  const max = r.body.checkins.find((c) => c.email === 'max@capgemini.com');
  assert.strictEqual(max.method, 'admin');
  const d = await admin('DELETE', `/api/admin/events/${live.id}/checkins/${max.attendeeId}`);
  assert.ok(!d.body.checkins.some((c) => c.email === 'max@capgemini.com'));
});

test('ending an event closes check-in and exports CSV', async () => {
  const end = await admin('POST', `/api/admin/events/${live.id}/state`, { action: 'end' });
  assert.strictEqual(end.body.event.status, 'ended');
  assert.strictEqual((await jane('POST', '/api/public/checkin', { eventId: live.id })).status, 409);
  assert.deepStrictEqual((await client()('GET', '/api/public/events')).body.events, []);
  const csv = await admin('GET', `/api/admin/events/${live.id}/export.csv`, undefined, { raw: true });
  assert.match(csv.headers.get('content-disposition'), /genai-talk-attendance\.csv/);
  assert.match(csv.body, /^"email","checked_in_at","method"\r\n"sam@capgemini\.com"/);
  assert.match(csv.body, /"lee@sogeti\.com"/);
});

test('rejects non-JSON writes and path traversal', async () => {
  const form = await admin('POST', `/api/admin/events/${later.id}/state`, 'action=end', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.strictEqual(form.status, 415);
  const res = await fetch(base + '/%2e%2e/server.js');
  assert.strictEqual(res.status, 404);
});

test('serves pages', async () => {
  for (const p of ['/', '/admin', `/e/${live.id}`, '/styles.css', '/app.js', '/admin.js', '/logo.png']) {
    assert.strictEqual((await fetch(base + p)).status, 200, p);
  }
});

test('changing the password signs out other sessions', async () => {
  const other = client();
  await other('POST', '/api/admin/login', { password: 'secret123' });
  assert.strictEqual((await admin('POST', '/api/admin/password', { current: 'nope', next: 'newsecret1' })).status, 401);
  assert.strictEqual((await admin('POST', '/api/admin/password', { current: 'secret123', next: 'newsecret1' })).status, 200);
  assert.strictEqual((await admin('GET', '/api/admin/events')).status, 200);
  assert.strictEqual((await other('GET', '/api/admin/events')).status, 401);
});

test('sign-in lockout uses the proxy-added address, not a spoofed one', async () => {
  const c = client();
  const tryLogin = (xff, password) => c('POST', '/api/admin/login', { password }, { headers: { 'X-Forwarded-For': xff } });
  for (let i = 0; i < 5; i++) await tryLogin(`10.0.0.${i}, 1.1.1.1`, 'wrongwrong');
  assert.strictEqual((await tryLogin('10.9.9.9, 1.1.1.1', 'newsecret1')).status, 429, 'rotating the spoofable part does not help');
  assert.strictEqual((await tryLogin('1.1.1.1, 2.2.2.2', 'newsecret1')).status, 200, 'other visitors are not locked out');
});

test('site-wide cap stops attackers who rotate real addresses', async () => {
  const c = client();
  for (let i = 0; i < 60; i++) await c('POST', '/api/admin/login', { password: 'wrongwrong' }, { headers: { 'X-Forwarded-For': `3.3.${i}.1` } });
  assert.strictEqual((await c('POST', '/api/admin/login', { password: 'newsecret1' }, { headers: { 'X-Forwarded-For': '4.4.4.4' } })).status, 429);
});
