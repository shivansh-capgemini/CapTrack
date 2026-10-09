// CapTrack admin portal: hash-routed single page.
(() => {
  'use strict';

  const root = document.getElementById('root');
  const toastEl = document.getElementById('toast');
  let refreshTimer = null;

  // ---- helpers -------------------------------------------------------------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.endsWith('/login') && !url.endsWith('/password')) {
      renderAuth(false);
      throw new Error(data.error || 'Sign in to continue.');
    }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  async function copy(text, done) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(done);
  }

  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  const when = (ev) =>
    sameDay(ev.startAt, ev.endAt)
      ? `${fmtDay(ev.startAt)}, ${fmtTime(ev.startAt)} – ${fmtTime(ev.endAt)}`
      : `${fmtDay(ev.startAt)} ${fmtTime(ev.startAt)} – ${fmtDay(ev.endAt)} ${fmtTime(ev.endAt)}`;

  // datetime-local <-> ISO, in the browser's own timezone.
  const toLocalInput = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');

  const STATUS_LABEL = { open: 'Check-in open', scheduled: 'Scheduled', paused: 'Paused', ended: 'Ended' };
  const pill = (s) => `<span class="pill pill-${s}">${STATUS_LABEL[s]}</span>`;
  const METHOD_LABEL = { manual: 'Typed email', auto: 'Remembered device', admin: 'Added by you' };
  const checkinUrl = (ev) => `${location.origin}/e/${ev.id}`;

  // ---- shell ---------------------------------------------------------------
  function shell(active, inner) {
    root.innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <img src="/logo.png" alt="Capgemini">
        <a class="name" href="#/"><span>CapTrack</span> admin</a>
        <nav>
          <a href="#/" ${active === 'events' ? 'aria-current="page"' : ''}>Events</a>
          <a href="#/settings" ${active === 'settings' ? 'aria-current="page"' : ''}>Settings</a>
          <a href="/" target="_blank" rel="noopener">Check-in page</a>
          <button id="logout">Sign out</button>
        </nav>
      </div></header>
      <main>${inner}</main>`;
    root.querySelector('#logout').addEventListener('click', async () => {
      await api('POST', '/api/admin/logout', {}).catch(() => {});
      location.hash = '#/';
      renderAuth(false);
    });
    return root.querySelector('main');
  }

  // ---- auth ----------------------------------------------------------------
  function renderAuth(setup) {
    clearInterval(refreshTimer);
    root.innerHTML = `
      <div class="auth"><form class="panel" id="auth-form" novalidate>
        <img src="/logo.png" alt="Capgemini">
        <div>
          <h1>${setup ? 'Set up CapTrack' : 'Organiser sign-in'}</h1>
          <p>${setup ? 'Choose the admin password. You&rsquo;ll use it to create events and export attendance.' : 'Sign in to manage events and attendance.'}</p>
        </div>
        <div class="field">
          <label for="pw">${setup ? 'New admin password' : 'Admin password'}</label>
          <input id="pw" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required>
          ${setup ? '<span class="hint">At least 8 characters.</span>' : ''}
        </div>
        ${setup ? `<div class="field"><label for="pw2">Repeat password</label><input id="pw2" type="password" autocomplete="new-password" required></div>` : ''}
        <p class="error" id="err" role="alert"></p>
        <button class="btn btn-primary" type="submit">${setup ? 'Save password and continue' : 'Sign in'}</button>
      </form></div>`;
    const form = root.querySelector('#auth-form');
    const err = form.querySelector('#err');
    form.querySelector('#pw').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const password = form.querySelector('#pw').value;
      if (setup && password !== form.querySelector('#pw2').value) {
        err.textContent = 'The two passwords don’t match.';
        return;
      }
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        await api('POST', setup ? '/api/admin/setup' : '/api/admin/login', { password });
        route();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    });
  }

  // ---- events list ---------------------------------------------------------
  async function renderEvents() {
    const main = shell('events', '<p class="tally-label">Loading events…</p>');
    const { events } = await api('GET', '/api/admin/events');
    const groups = [
      ['live', 'Live now', events.filter((e) => e.status === 'open')],
      ['', 'Paused', events.filter((e) => e.status === 'paused')],
      ['', 'Coming up', events.filter((e) => e.status === 'scheduled').reverse()],
      ['', 'Finished', events.filter((e) => e.status === 'ended')],
    ].filter((g) => g[2].length);

    const row = (ev) => `
      <a class="event-row" href="#/event/${esc(ev.id)}">
        <span class="t">${esc(ev.title)}</span>
        <span class="m">${esc(when(ev))}${ev.location ? ` <br>${esc(ev.location)}` : ''}</span>
        <span class="count"><b>${ev.count}</b>${ev.count === 1 ? 'person' : 'people'}</span>
        ${pill(ev.status)}
      </a>`;

    main.innerHTML = `
      <div class="page-head">
        <div><h1>Your events</h1><p>Create an event, share its check-in link, and export who came.</p></div>
        <a class="btn btn-primary" href="#/new">New event</a>
      </div>
      ${
        groups.length
          ? groups.map(([cls, title, list]) => `<section class="group ${cls}"><h2>${title}</h2>${list.map(row).join('')}</section>`).join('')
          : `<div class="panel empty-state">
              <svg viewBox="0 0 120 120" aria-hidden="true"><use href="#spade"/></svg>
              <h2>No events yet</h2>
              <p>Create your first event. Check-in opens and closes on the schedule you set, and you can open or pause it by hand any time.</p>
              <a class="btn btn-primary" href="#/new">Create an event</a>
            </div>`
      }`;
  }

  // ---- create / edit -------------------------------------------------------
  async function renderForm(id) {
    let ev = null;
    if (id) ev = (await api('GET', `/api/admin/events/${id}`)).event;
    const now = new Date();
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0); // starts open, not a few minutes from now
    const start = ev ? new Date(ev.startAt) : now;
    const end = ev ? new Date(ev.endAt) : new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const main = shell('events', `
      <div class="page-head"><div>
        <a class="crumb" href="${ev ? `#/event/${esc(ev.id)}` : '#/'}">‹ ${ev ? 'Back to event' : 'All events'}</a>
        <h1>${ev ? 'Edit event' : 'New event'}</h1>
      </div></div>
      <form class="panel form-grid" id="ev-form" novalidate>
        <div class="field">
          <label for="title">Title</label>
          <input id="title" type="text" maxlength="120" required value="${esc(ev?.title)}" placeholder="Pune Tech Talk: GenAI in delivery">
        </div>
        <div class="field">
          <label for="description">Description <span class="optional">optional</span></label>
          <textarea id="description" maxlength="1000" placeholder="Shown to people when they check in.">${esc(ev?.description)}</textarea>
        </div>
        <div class="field">
          <label for="location">Location <span class="optional">optional</span></label>
          <input id="location" type="text" maxlength="200" value="${esc(ev?.location)}" placeholder="Building B5, Auditorium 2">
        </div>
        <div class="two">
          <div class="field">
            <label for="startAt">Check-in opens</label>
            <input id="startAt" type="datetime-local" required value="${toLocalInput(start)}">
          </div>
          <div class="field">
            <label for="endAt">Check-in closes</label>
            <input id="endAt" type="datetime-local" required value="${toLocalInput(end)}">
          </div>
        </div>
        <p class="hint">Check-in opens and closes automatically at these times. You can also open, pause, or end it by hand from the event page.</p>
        <p class="error" id="err" role="alert"></p>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">${ev ? 'Save changes' : 'Create event'}</button>
          <a class="btn btn-ghost" href="${ev ? `#/event/${esc(ev.id)}` : '#/'}">Cancel</a>
        </div>
      </form>`);

    const form = main.querySelector('#ev-form');
    form.querySelector('#title').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = (k) => form.querySelector('#' + k).value;
      const body = {
        title: val('title'),
        description: val('description'),
        location: val('location'),
        startAt: fromLocalInput(val('startAt')),
        endAt: fromLocalInput(val('endAt')),
      };
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const r = ev
          ? await api('PUT', `/api/admin/events/${ev.id}`, body)
          : await api('POST', '/api/admin/events', body);
        toast(ev ? 'Changes saved' : 'Event created');
        location.hash = `#/event/${r.event.id}`;
      } catch (ex) {
        form.querySelector('#err').textContent = ex.message;
        btn.disabled = false;
      }
    });
  }

  // ---- event detail --------------------------------------------------------
  function controlsFor(ev) {
    const opensAt = `${fmtDay(ev.startAt)} at ${fmtTime(ev.startAt)}`;
    const closesAt = `${fmtDay(ev.endAt)} at ${fmtTime(ev.endAt)}`;
    switch (ev.status) {
      case 'scheduled':
        return {
          explain: `Check-in opens automatically on ${opensAt}.`,
          buttons: [['start', 'Open check-in now', 'btn-ok'], ['end', 'End event', 'btn-danger']],
        };
      case 'open':
        return {
          explain:
            ev.override === 'open'
              ? 'You opened check-in by hand. It stays open until you pause or end it.'
              : `Check-in closes automatically on ${closesAt}.`,
          buttons: [
            ['stop', 'Pause check-in', 'btn-ghost'],
            ...(ev.override === 'open' ? [['schedule', 'Go back to schedule', 'btn-ghost']] : []),
            ['end', 'End event', 'btn-danger'],
          ],
        };
      case 'paused':
        return {
          explain: `Nobody can check in while paused. The schedule would close check-in on ${closesAt}.`,
          buttons: [['start', 'Resume check-in', 'btn-ok'], ['schedule', 'Go back to schedule', 'btn-ghost'], ['end', 'End event', 'btn-danger']],
        };
      default:
        return {
          explain: ev.endedAt ? `You ended this event on ${fmtDay(ev.endedAt)} at ${fmtTime(ev.endedAt)}.` : `Check-in closed on ${closesAt}.`,
          buttons: [['start', 'Reopen check-in', 'btn-ghost']],
        };
    }
  }

  async function renderEvent(id) {
    const { event: ev, checkins } = await api('GET', `/api/admin/events/${id}`);
    const ended = ev.status === 'ended';
    const ctl = controlsFor(ev);
    const emails = checkins.map((c) => c.email).join(', ');

    const exportPanel = `
      <section class="panel export ${ended ? 'final' : ''}">
        <h2>${ended ? 'Final attendance list' : 'Attendance so far'}</h2>
        <p class="sub">${ended ? 'Every email captured for this event, comma separated and ready to paste into another system.' : 'Comma-separated emails. The final list appears here when the event ends.'}</p>
        <textarea readonly id="emails" aria-label="Comma-separated attendee emails">${esc(emails)}</textarea>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn btn-primary btn-sm" id="copy-emails" ${checkins.length ? '' : 'disabled'}>Copy emails</button>
          <a class="btn btn-ghost btn-sm" href="/api/admin/events/${esc(ev.id)}/export.csv" download>Download CSV</a>
        </div>
      </section>`;

    const main = shell('events', `
      <div class="page-head">
        <div>
          <a class="crumb" href="#/">‹ All events</a>
          <h1>${esc(ev.title)}</h1>
          <p>${esc(when(ev))}${ev.location ? `<br>${esc(ev.location)}` : ''}</p>
        </div>
        <div class="btn-row">
          <a class="btn btn-ghost btn-sm" href="#/event/${esc(ev.id)}/edit">Edit details</a>
          <button class="btn btn-danger btn-sm" id="delete">Delete event</button>
        </div>
      </div>
      ${ev.description ? `<p style="max-width:70ch">${esc(ev.description)}</p>` : ''}
      ${ended ? exportPanel : ''}
      <div class="detail">
        <div class="stack">
          <section class="panel">
            <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap">
              <div><h2>Who&rsquo;s here</h2><p class="sub" style="margin:0">${ev.status === 'open' ? 'Updates live every few seconds.' : 'Everyone who checked in.'}</p></div>
              <div style="text-align:right"><div class="tally">${checkins.length}</div><div class="tally-label">${checkins.length === 1 ? 'person' : 'people'}</div></div>
            </div>
            ${
              checkins.length
                ? `<div class="table-wrap" style="margin-top:14px"><table class="table">
                    <thead><tr><th>Email</th><th>Time</th><th>How</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
                    <tbody>${checkins
                      .slice()
                      .reverse()
                      .map(
                        (c) => `<tr>
                          <td class="email">${esc(c.email)}</td>
                          <td class="how">${esc(fmtTime(c.at))}</td>
                          <td class="how">${METHOD_LABEL[c.method] || esc(c.method)}</td>
                          <td><button class="remove" data-att="${esc(c.attendeeId)}" data-email="${esc(c.email)}">Remove</button></td>
                        </tr>`
                      )
                      .join('')}</tbody></table></div>`
                : `<p class="sub" style="margin-top:14px">Nobody has checked in yet. Share the link or put the QR code on screen.</p>`
            }
            <form class="add-row" id="add-form" novalidate>
              <label class="visually-hidden" for="add-email">Add someone by email</label>
              <input id="add-email" type="email" placeholder="Add someone by email">
              <button class="btn btn-ghost btn-sm" type="submit">Add</button>
            </form>
            <p class="error" id="add-err" role="alert" style="margin-top:8px"></p>
          </section>
          ${ended ? '' : exportPanel}
        </div>
        <div class="stack">
          <section class="panel control">
            <div class="big-status">${pill(ev.status)}</div>
            <p class="explain">${esc(ctl.explain)}</p>
            <div class="btn-row">
              ${ctl.buttons.map(([a, label, cls]) => `<button class="btn btn-sm ${cls}" data-action="${a}">${label}</button>`).join('')}
            </div>
          </section>
          <section class="panel">
            <h2>Check-in link</h2>
            <p class="sub">Share this link, or show the QR code on the screen at the venue.</p>
            <div class="link-box"><code>${esc(checkinUrl(ev))}</code><button class="btn btn-ghost btn-sm" id="copy-link">Copy</button></div>
            <div class="btn-row" style="margin-top:12px"><button class="btn btn-primary btn-sm" id="show-qr">Show QR code</button></div>
          </section>
        </div>
      </div>`);

    main.querySelector('#copy-emails')?.addEventListener('click', () => copy(emails, `Copied ${checkins.length} email${checkins.length === 1 ? '' : 's'}`));
    main.querySelector('#copy-link').addEventListener('click', () => copy(checkinUrl(ev), 'Link copied'));
    main.querySelector('#show-qr').addEventListener('click', () => showQr(ev));

    main.querySelectorAll('[data-action]').forEach((b) =>
      b.addEventListener('click', async () => {
        const action = b.dataset.action;
        if (action === 'end' && !confirm('End this event? Check-in closes and the final attendance list is ready to export. You can reopen it later.')) return;
        b.disabled = true;
        try {
          await api('POST', `/api/admin/events/${ev.id}/state`, { action });
          toast({ start: 'Check-in is open', stop: 'Check-in paused', schedule: 'Back on schedule', end: 'Event ended' }[action]);
          renderEvent(ev.id);
        } catch (ex) {
          toast(ex.message);
          b.disabled = false;
        }
      })
    );

    main.querySelector('#delete').addEventListener('click', async () => {
      if (!confirm(`Delete "${ev.title}" and its ${checkins.length} check-in${checkins.length === 1 ? '' : 's'}? This can't be undone.`)) return;
      await api('DELETE', `/api/admin/events/${ev.id}`);
      toast('Event deleted');
      location.hash = '#/';
    });

    main.querySelectorAll('.remove').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(`Remove ${b.dataset.email} from this event?`)) return;
        await api('DELETE', `/api/admin/events/${ev.id}/checkins/${encodeURIComponent(b.dataset.att)}`);
        toast('Removed');
        renderEvent(ev.id);
      })
    );

    main.querySelector('#add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = main.querySelector('#add-email');
      try {
        await api('POST', `/api/admin/events/${ev.id}/checkins`, { email: input.value });
        toast('Added');
        renderEvent(ev.id);
      } catch (ex) {
        main.querySelector('#add-err').textContent = ex.message;
      }
    });

    // Keep the list live while check-in is open, unless the admin is mid-typing.
    clearInterval(refreshTimer);
    if (ev.status === 'open' || ev.status === 'scheduled') {
      refreshTimer = setInterval(() => {
        const busy = document.activeElement && document.activeElement.matches('input, textarea');
        if (!busy && !document.querySelector('.qr-overlay') && location.hash === `#/event/${ev.id}`) renderEvent(ev.id).catch(() => {});
      }, 8000);
    }
  }

  // ---- QR projector view ---------------------------------------------------
  let qrLib = null;
  function loadQrLib() {
    qrLib ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = () => resolve(window.QRCode);
      s.onerror = () => { qrLib = null; reject(new Error('QR code library could not load')); };
      document.head.appendChild(s);
    });
    return qrLib;
  }

  async function showQr(ev) {
    const url = checkinUrl(ev);
    const overlay = document.createElement('div');
    overlay.className = 'qr-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Check-in QR code');
    overlay.innerHTML = `
      <button class="btn close" id="close-qr">Close</button>
      <div class="inner">
        <img src="/logo.png" alt="Capgemini" style="height:36px;filter:brightness(0) invert(1)">
        <h2>Check in to ${esc(ev.title)}</h2>
        <div class="qr" id="qr"></div>
        <p class="url">${esc(url)}</p>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    overlay.querySelector('#close-qr').addEventListener('click', close);
    overlay.querySelector('#close-qr').focus();
    try {
      const QR = await loadQrLib();
      new QR(overlay.querySelector('#qr'), { text: url, width: 512, height: 512, colorDark: '#1a1446', colorLight: '#ffffff', correctLevel: QR.CorrectLevel.M });
    } catch {
      overlay.querySelector('#qr').outerHTML = '<p>The QR code needs an internet connection. Share the link below instead.</p>';
    }
  }

  // ---- settings ------------------------------------------------------------
  async function renderSettings() {
    let { allowedDomains } = await api('GET', '/api/admin/settings');
    const main = shell('settings', `
      <div class="page-head"><div><h1>Settings</h1><p>Control who can check in and how you sign in.</p></div></div>
      <section class="panel">
        <h2>Allowed email domains</h2>
        <p class="sub">People can only check in with an email from one of these domains.</p>
        <div class="domain-list" id="domains"></div>
        <form class="add-row" id="domain-form" novalidate style="max-width:460px">
          <label class="visually-hidden" for="new-domain">Add a domain</label>
          <input id="new-domain" type="text" placeholder="sogeti.com" autocomplete="off">
          <button class="btn btn-primary btn-sm" type="submit">Add domain</button>
        </form>
        <p class="error" id="domain-err" role="alert" style="margin-top:10px"></p>
      </section>
      <section class="panel">
        <h2>Change admin password</h2>
        <p class="sub">Changing it signs out every other browser using the admin portal.</p>
        <form class="form-grid" id="pw-form" novalidate style="max-width:420px">
          <div class="field"><label for="cur">Current password</label><input id="cur" type="password" autocomplete="current-password"></div>
          <div class="field"><label for="next">New password</label><input id="next" type="password" autocomplete="new-password"><span class="hint">At least 8 characters.</span></div>
          <p class="error" id="pw-err" role="alert"></p>
          <div><button class="btn btn-primary" type="submit">Change password</button></div>
        </form>
      </section>`);

    const list = main.querySelector('#domains');
    const derr = main.querySelector('#domain-err');
    const draw = () => {
      list.innerHTML = allowedDomains
        .map((d) => `<span class="domain">@${esc(d)}<button type="button" aria-label="Remove ${esc(d)}" data-d="${esc(d)}">×</button></span>`)
        .join('');
      list.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => saveDomains(allowedDomains.filter((x) => x !== b.dataset.d), `Removed @${b.dataset.d}`)));
    };
    async function saveDomains(next, msg) {
      derr.textContent = '';
      try {
        allowedDomains = (await api('PUT', '/api/admin/settings', { allowedDomains: next })).allowedDomains;
        draw();
        toast(msg);
        return true;
      } catch (ex) {
        derr.textContent = ex.message;
        return false;
      }
    }
    draw();
    main.querySelector('#domain-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = main.querySelector('#new-domain');
      const d = input.value.trim().toLowerCase().replace(/^@+/, '');
      if (!d) return;
      if (allowedDomains.includes(d)) { derr.textContent = `@${d} is already allowed.`; return; }
      if (await saveDomains([...allowedDomains, d], `Added @${d}`)) input.value = '';
    });

    main.querySelector('#pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      const err = f.querySelector('#pw-err');
      err.textContent = '';
      try {
        await api('POST', '/api/admin/password', { current: f.querySelector('#cur').value, next: f.querySelector('#next').value });
        f.reset();
        toast('Password changed');
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  }

  // ---- router --------------------------------------------------------------
  async function route() {
    clearInterval(refreshTimer);
    try {
      const s = await api('GET', '/api/admin/session');
      if (s.setupRequired) return renderAuth(true);
      if (!s.authenticated) return renderAuth(false);
      const h = location.hash.replace(/^#/, '') || '/';
      let m;
      if (h === '/new') return await renderForm();
      if (h === '/settings') return await renderSettings();
      if ((m = h.match(/^\/event\/([a-z0-9]+)\/edit$/))) return await renderForm(m[1]);
      if ((m = h.match(/^\/event\/([a-z0-9]+)$/))) return await renderEvent(m[1]);
      return await renderEvents();
    } catch (ex) {
      if (root.querySelector('.auth')) return;
      const main = shell('events', '');
      main.innerHTML = `<div class="panel empty-state"><h2>That didn&rsquo;t load</h2><p>${esc(ex.message)}</p><a class="btn btn-primary" href="#/">Back to events</a></div>`;
    }
  }

  window.addEventListener('hashchange', route);
  route();
})();
