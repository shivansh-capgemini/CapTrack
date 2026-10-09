// CapTrack public check-in flow.
(() => {
  'use strict';

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const LS_KEY = 'captrack_email';
  const state = { events: [], me: null, domains: [], current: null };

  // ---- helpers -------------------------------------------------------------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const remember = (email) => { try { localStorage.setItem(LS_KEY, email); } catch {} };
  const recalled = () => { try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; } };
  const forgetLocal = () => { try { localStorage.removeItem(LS_KEY); } catch {} };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: res.status });
    return data;
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  function when(ev) {
    return sameDay(ev.startAt, ev.endAt)
      ? `${fmtDay(ev.startAt)}, ${fmtTime(ev.startAt)} – ${fmtTime(ev.endAt)}`
      : `${fmtDay(ev.startAt)} ${fmtTime(ev.startAt)} – ${fmtDay(ev.endAt)} ${fmtTime(ev.endAt)}`;
  }
  const meta = (ev) => [ev.location, when(ev)].filter(Boolean).map(esc).join('<br>');

  function contextBox(ev, withDescription) {
    return `<div class="context">
      <span class="t">${esc(ev.title)}</span>
      <span class="m">${meta(ev)}</span>
      ${withDescription && ev.description ? `<p class="d">${esc(ev.description)}</p>` : ''}
    </div>`;
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning!' : h < 17 ? 'Good afternoon!' : 'Good evening!';
  }

  // ---- screens -------------------------------------------------------------
  function renderEmpty(title, body) {
    app.className = 'card empty';
    app.innerHTML = `
      <svg viewBox="0 0 120 120" aria-hidden="true"><use href="#spade"/></svg>
      <h1 class="headline">${esc(title)}</h1>
      <p class="lede">${body}</p>`;
  }

  function renderPicker() {
    app.className = 'card';
    app.innerHTML = `
      <div>
        <h1 class="headline">${state.me ? `Hi ${esc(state.me.firstName)}, which event are you at?` : 'Which event are you at?'}</h1>
      </div>
      <p class="lede">A few things are happening right now. Pick yours and we&rsquo;ll check you in.</p>
      <ul class="events">
        ${state.events
          .map(
            (ev) => `<li><button class="event-option ${ev.checkedInAt ? 'done' : ''}" data-id="${esc(ev.id)}">
              <span class="t">${esc(ev.title)}</span>
              <span class="m">${meta(ev)}</span>
              <span class="go">${ev.checkedInAt ? 'Checked in ✓' : 'Check in'}</span>
            </button></li>`
          )
          .join('')}
      </ul>`;
    app.querySelectorAll('.event-option').forEach((b) =>
      b.addEventListener('click', () => choose(state.events.find((e) => e.id === b.dataset.id)))
    );
    app.querySelector('h1').focus?.();
  }

  function renderEmail(ev, errorMsg = '') {
    state.current = ev;
    app.className = 'card';
    app.innerHTML = `
      <div>
        <h1 class="headline">${greeting()} Let&rsquo;s get you checked in.</h1>
      </div>
      ${contextBox(ev, true)}
      <form id="email-form" novalidate>
        <div class="field">
          <label for="email">Your work email</label>
          <input id="email" type="email" name="email" autocomplete="email" inputmode="email"
                 placeholder="firstname.lastname@${esc(state.domains[0] || 'capgemini.com')}" value="${esc(recalled())}" required>
          <div class="domains" aria-label="Accepted email domains">
            ${state.domains.map((d) => `<button type="button" class="chip" data-d="${esc(d)}" aria-label="Use @${esc(d)}">@${esc(d)}</button>`).join('')}
          </div>
        </div>
        <p class="error" id="err" role="alert">${esc(errorMsg)}</p>
        <div class="actions">
          <button class="btn btn-primary" type="submit">Check me in</button>
        </div>
        <p class="muted">We&rsquo;ll remember this email on this device, so next time you&rsquo;re checked in the moment you open this page.</p>
        ${state.events.length > 1 ? '<button type="button" class="link-btn" id="back">Pick a different event</button>' : ''}
      </form>`;

    const form = app.querySelector('#email-form');
    const input = form.querySelector('#email');
    const err = form.querySelector('#err');
    input.focus();
    form.querySelector('#back')?.addEventListener('click', renderPicker);
    // Tapping a domain chip completes the address, replacing any half-typed domain.
    form.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
      const suffix = '@' + c.dataset.d;
      const v = input.value.trim();
      if (!v.toLowerCase().endsWith(suffix.toLowerCase())) input.value = v.split('@')[0] + suffix;
      input.focus();
    }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      err.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Checking you in…';
      try {
        const r = await api('POST', '/api/public/checkin', { eventId: ev.id, email: input.value });
        afterCheckin(r, false);
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = 'Check me in';
        input.focus();
      }
    });
  }

  function renderSuccess(r, auto) {
    const ev = r.event;
    const others = state.events.filter((e) => e.id !== ev.id);
    const title = r.alreadyCheckedIn
      ? `You&rsquo;re already in${r.me.firstName ? `, ${esc(r.me.firstName)}` : ''}.`
      : `You&rsquo;re in${r.me.firstName ? `, ${esc(r.me.firstName)}` : ''}!`;
    const note = r.alreadyCheckedIn
      ? `You checked in at ${fmtTime(r.checkedInAt)}. Nothing else to do — enjoy the event.`
      : auto
        ? 'We recognised this device and checked you in automatically. Enjoy the event.'
        : 'Your attendance is recorded. Enjoy the event.';

    app.className = 'card success';
    app.innerHTML = `
      <div class="stamp" aria-hidden="true">
        <svg viewBox="0 0 120 120">
          <defs><clipPath id="spade-clip"><path transform="translate(0 4.7) scale(0.07638)" d="m1570.4 844.8c-13.7-82.8-42.7-235.8-257.6-235.8-234.8 0-312.7 328.2-504.1 539.8-60.5 66.8-133.2 121.7-221.6 150.7q-149.1 50.1-298.1-6.2c-171.4-69.4-288.1-242.1-288.1-426.9 0-472.6 651.7-640.9 839.9-866.3h0.1q4.6 1.8 9.3 3.7 4.6 1.8 9.3 3.7 4.6 1.9 9.2 3.8 4.6 1.9 9.2 3.9c152.9 64 298.7 149.1 421.4 261.2 161.6 148.3 266.5 334.2 270.7 554.5 0.3 7.9 0.4 13.7 0.4 13.9z"/></clipPath></defs>
          <path transform="translate(0 4.7) scale(0.07638)" d="m1570.4 844.8c-13.7-82.8-42.7-235.8-257.6-235.8-234.8 0-312.7 328.2-504.1 539.8-60.5 66.8-133.2 121.7-221.6 150.7q-149.1 50.1-298.1-6.2c-171.4-69.4-288.1-242.1-288.1-426.9 0-472.6 651.7-640.9 839.9-866.3h0.1q4.6 1.8 9.3 3.7 4.6 1.8 9.3 3.7 4.6 1.9 9.2 3.8 4.6 1.9 9.2 3.9c152.9 64 298.7 149.1 421.4 261.2 161.6 148.3 266.5 334.2 270.7 554.5 0.3 7.9 0.4 13.7 0.4 13.9z" fill="#dcecf6"/>
          <g clip-path="url(#spade-clip)"><rect class="fill" x="0" y="0" width="120" height="120" fill="#0070ad"/></g>
          <path transform="translate(0 4.7) scale(0.07638)" d="m979.5 1072.6c9.1 127.5 101.2 219.5 244.3 217.6-107.3 105.9-312.4 156.9-481.8 156.9-92.5 0-169.9-19.6-204.9-56.1 142.3-18.1 256.2-125.8 271.7-246.1 191.2-211.6 269.2-539.9 504-539.9 214.9 0 243.9 153.1 257.5 235.8-1.9 189.5-153.4 349.3-349.6 349.3-92.4 0-171.4-32.9-241.2-117.5z" fill="#12abdb"/>
          <path class="tick" d="M34 66l12 12 24-26" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <h1 class="headline" tabindex="-1">${title}</h1>
      <p class="lede">${note}</p>
      ${contextBox(ev, false)}
      <div class="who" id="who">
        <span class="muted">Checked in as</span>
        <span class="email">${esc(r.me.email)}</span>
        <button class="btn btn-ghost btn-sm" id="edit">Edit email</button>
      </div>
      <div class="row-links">
        ${others.length ? '<button class="link-btn" id="more">Check in to another event</button>' : ''}
        <button class="link-btn" id="notme">Not you? Use a different email</button>
      </div>`;

    app.querySelector('h1').focus({ preventScroll: true });
    app.querySelector('#edit').addEventListener('click', () => renderEditor(r));
    app.querySelector('#more')?.addEventListener('click', renderPicker);
    app.querySelector('#notme').addEventListener('click', async () => {
      await api('POST', '/api/public/forget', {}).catch(() => {});
      forgetLocal();
      state.me = null;
      state.events.forEach((e) => (e.checkedInAt = null));
      renderEmail(ev);
    });
    if (!r.alreadyCheckedIn) confetti(app.querySelector('.stamp'));
  }

  function renderEditor(r) {
    const who = app.querySelector('#who');
    who.outerHTML = `
      <form class="edit-form" id="edit-form" novalidate>
        <div class="field">
          <label for="new-email">Correct your email</label>
          <input id="new-email" type="email" autocomplete="email" inputmode="email" value="${esc(r.me.email)}" required>
          <span class="hint">This updates your attendance for this event and every earlier one.</span>
        </div>
        <p class="error" id="edit-err" role="alert"></p>
        <div class="actions">
          <button class="btn btn-primary" type="submit">Save email</button>
          <button class="btn btn-ghost" type="button" id="cancel">Cancel</button>
        </div>
      </form>`;
    const form = app.querySelector('#edit-form');
    const input = form.querySelector('#new-email');
    input.focus();
    input.select();
    form.querySelector('#cancel').addEventListener('click', () => renderSuccess({ ...r, alreadyCheckedIn: true }, false));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const { me } = await api('PATCH', '/api/public/me', { email: input.value });
        state.me = me;
        remember(me.email);
        toast('Email updated');
        renderSuccess({ ...r, me, alreadyCheckedIn: true }, false);
      } catch (ex) {
        form.querySelector('#edit-err').textContent = ex.message;
        btn.disabled = false;
      }
    });
  }

  // ---- flow ----------------------------------------------------------------
  function afterCheckin(r, auto) {
    state.me = r.me;
    remember(r.me.email);
    const ev = state.events.find((e) => e.id === r.event.id);
    if (ev) ev.checkedInAt = r.checkedInAt;
    renderSuccess(r, auto);
  }

  async function choose(ev) {
    if (!state.me) return renderEmail(ev);
    app.className = 'card';
    app.innerHTML = '<p class="loading">Checking you in&hellip;</p>';
    try {
      afterCheckin(await api('POST', '/api/public/checkin', { eventId: ev.id }), true);
    } catch (ex) {
      if (ex.status === 422) return renderEmail(ev); // device lost its saved email
      renderEmail(ev, ex.message);
    }
  }

  async function init() {
    const m = location.pathname.match(/^\/e\/([a-z0-9]+)\/?$/);
    try {
      if (m) {
        const { event, me, domains } = await api('GET', `/api/public/events/${m[1]}`);
        Object.assign(state, { me, domains });
        const all = await api('GET', '/api/public/events');
        state.events = all.events;
        if (event.status !== 'open') {
          const msgs = {
            scheduled: [`Check-in opens soon.`, `<b>${esc(event.title)}</b> opens for check-in at ${esc(fmtTime(event.startAt))} on ${esc(fmtDay(event.startAt))}. Come back then, or refresh this page.`],
            paused: ['Check-in is paused.', `The organiser has paused check-in for <b>${esc(event.title)}</b>. Refresh this page in a moment.`],
            ended: ['Check-in has closed.', `Check-in for <b>${esc(event.title)}</b> has ended. If you attended and missed it, let the organiser know.`],
          }[event.status];
          return renderEmpty(msgs[0], msgs[1] + (state.events.length ? ' <br><br><a href="/">See events open right now</a>' : ''));
        }
        return choose(event);
      }

      const { events, me, domains } = await api('GET', '/api/public/events');
      Object.assign(state, { events, me, domains });
      if (!events.length) {
        return renderEmpty(
          'Nothing to check in to right now.',
          'No events are taking check-ins at the moment. If you&rsquo;re at one, ask the organiser to open check-in, then refresh this page.'
        );
      }
      if (events.length === 1) return choose(events[0]);
      renderPicker();
    } catch (ex) {
      if (ex.status === 404) return renderEmpty('We can’t find that event.', esc(ex.message));
      renderEmpty('We couldn’t load this page.', esc(ex.message) + ' Refresh to try again.');
    }
  }

  // ---- celebration ---------------------------------------------------------
  function confetti(origin) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !origin) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti';
    document.body.appendChild(canvas);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const box = origin.getBoundingClientRect();
    const ox = box.left + box.width / 2;
    const oy = box.top + box.height / 2;
    const colors = ['#0070ad', '#12abdb', '#ffb81c', '#1a1446', '#7fd3f0'];
    const bits = Array.from({ length: 90 }, () => {
      const a = Math.random() * Math.PI * 2;
      const v = 4 + Math.random() * 7;
      return {
        x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4,
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        s: 5 + Math.random() * 6, c: colors[(Math.random() * colors.length) | 0],
        round: Math.random() < 0.35,
      };
    });
    const start = performance.now();
    (function frame(t) {
      const age = t - start;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.globalAlpha = Math.max(0, 1 - age / 1800);
      for (const b of bits) {
        b.vy += 0.22; b.vx *= 0.985; b.x += b.vx; b.y += b.vy; b.r += b.vr;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.r);
        ctx.fillStyle = b.c;
        if (b.round) { ctx.beginPath(); ctx.arc(0, 0, b.s / 2, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
        ctx.restore();
      }
      if (age < 1800) requestAnimationFrame(frame);
      else canvas.remove();
    })(start);
  }

  init();
})();
