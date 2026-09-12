/* ============================================================
   JustUs Entertainment TimeClock — ADMIN app logic
   Backend: n8n cloud webhooks (see config.js)

   This is the ADMIN half of the split (2026-09-10). The whole app sits behind
   the PIN gate. Home is the WAITING ROOM: everyone who tapped CLOCK IN on the
   employee app waits there until an admin standing in front of them approves
   it. Admins clock THEMSELVES straight in — no approval, no selfie — on trust.
   Employee app: ../timeclock/ (separate repo, separate URL).
   ============================================================ */
(() => {
  'use strict';

  const API = window.TC_API;
  const $ = (id) => document.getElementById(id);

  /* ---------- tiny helpers ---------- */
  const rows = (data) => (Array.isArray(data) ? data : [data]).filter((r) => r && r.id != null);

  async function api(path, opts = {}) {
    const res = await fetch(`${API}/${path}`, {
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
    });
    if (!res.ok) {
      const err = new Error(`API ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  const pad = (n) => String(n).padStart(2, '0');
  const localISO = (d = new Date()) => {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  };
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');
  const fmtDate = (s) => {
    if (!s) return '—';
    const d = new Date(`${s}T12:00:00`);
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };
  const shiftHours = (p) => {
    if (!p.clock_in || !p.clock_out) return null;
    let ms = new Date(p.clock_out) - new Date(p.clock_in);
    if (p.break_start && p.break_end) ms -= new Date(p.break_end) - new Date(p.break_start);
    return Math.max(0, ms / 3600000);
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Worker-typed jobs get a deterministic id from the name, so two people typing
  // the same job land on the same event_id and their hours group together.
  const jobSlug = (name) => {
    const body = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return body ? `job-${body}` : `job-${Date.now()}`;
  };

  let toastTimer;
  function toast(msg, isErr = false, ms = 3200) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast${isErr ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function confirmAsk(title, text) {
    return new Promise((resolve) => {
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      $('confirmModal').classList.remove('hidden');
      const done = (v) => {
        $('confirmModal').classList.add('hidden');
        $('confirmYes').onclick = $('confirmNo').onclick = null;
        resolve(v);
      };
      $('confirmYes').onclick = () => done(true);
      $('confirmNo').onclick = () => done(false);
    });
  }

  /* ---------- clocks ---------- */
  function tickClocks() {
    const now = new Date();
    $('liveClock').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const hm = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const [time, ampm] = hm.split(' ');
    $('heroClock').textContent = time;
    $('heroAmpm').textContent = ampm || '';
    $('heroDate').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
  setInterval(tickClocks, 1000);
  tickClocks();

  /* ---------- view router ----------

     Every page owns a URL (#home, #create, #select, #profile, #admin). Before
     this the whole app lived at one address: a refresh always dumped you back
     on the home screen, the phone's back arrow left the site entirely, and the
     only way home was tapping the brand. Now a refresh keeps you where you
     were and back/forward walk the pages.

     VIEW_PARENT is what the on-screen back arrow follows — deterministic "up
     one level", so it can never bounce you out of the app the way a raw
     history.back() can when the page was opened cold on a URL. */
  const VIEWS = ['home', 'create', 'select', 'profile', 'admin'];
  const VIEW_PARENT = { home: null, create: 'home', select: 'home', profile: 'select', admin: 'home' };
  let applyingHash = false;

  function show(view) {
    VIEWS.forEach((v) => $(`view-${v}`).classList.toggle('hidden', v !== view));
    window.scrollTo(0, 0);
    if (view !== 'admin') stopAdminPoll();
    if (view !== 'home') stopWaitPoll();
    const back = $('backBtn');
    if (back) back.classList.toggle('hidden', !VIEW_PARENT[view]);
    // Never push while a hash is being applied — that would fight the entry the
    // browser is already sitting on and break forward navigation.
    if (!applyingHash && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
  }

  function currentView() {
    return VIEWS.find((v) => !$(`view-${v}`).classList.contains('hidden')) || 'home';
  }

  function syncHash(view) {
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  }

  /**
   * The URL decides which page is showing. Runs on boot, on hashchange, and on
   * back/forward. Idempotent, because a traversal fires both popstate and
   * hashchange and this must not do the work twice.
   */
  function routeFromHash() {
    const raw = String(location.hash || '').replace(/^#/, '').toLowerCase();
    let view = VIEWS.includes(raw) ? raw : 'home';
    // This whole app is admin-only, so the PIN gate is the front door — not a
    // section inside it. Any URL, cold or bookmarked, stops here until it opens.
    if (!adminPinOk) {
      applyingHash = true;
      try { openAdmin(); } finally { applyingHash = false; }
      syncHash('admin');
      return;
    }
    // A refresh keeps the URL but not the in-memory state. A page that needs
    // state it no longer has redirects to the one that can rebuild it. #admin
    // is safe to land on cold — openAdmin re-shows the PIN gate, so a bookmark
    // or a refresh can never walk straight into the dashboard.
    if (view === 'profile' && !current.profile) view = 'select';
    if (currentView() === view) { syncHash(view); return; }
    applyingHash = true;
    try {
      if (view === 'admin') openAdmin();
      else if (view === 'select') { show('select'); loadProfiles(); }
      else show(view);
    } finally { applyingHash = false; }
    syncHash(view);
  }

  window.addEventListener('hashchange', routeFromHash);
  window.addEventListener('popstate', routeFromHash);

  function spinnerHtml() {
    return '<span class="tc-spinner" aria-hidden="true"></span> ';
  }

  /* ---------- admin live sync: poll while the dashboard is open so a
     change made on another device shows up without hitting refresh ---------- */
  let adminPollTimer = null;
  function stopAdminPoll() {
    if (adminPollTimer) { clearInterval(adminPollTimer); adminPollTimer = null; }
  }
  function startAdminPoll() {
    stopAdminPoll();
    adminPollTimer = setInterval(() => {
      if (adminPinOk && !$('view-admin').classList.contains('hidden')) loadAdmin({ silent: true });
    }, 20000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !adminPinOk) return;
    if (!$('view-admin').classList.contains('hidden')) loadAdmin({ silent: true });
    if (!$('view-home').classList.contains('hidden')) loadWaiting({ silent: true });
  });

  /* ---------- waiting-room live poll: someone standing in front of you should
     appear without anyone hitting refresh. Only runs while the waiting room is
     actually on screen, because every poll costs one n8n execution. ---------- */
  let waitPollTimer = null;
  function stopWaitPoll() {
    if (waitPollTimer) { clearInterval(waitPollTimer); waitPollTimer = null; }
  }
  function startWaitPoll() {
    stopWaitPoll();
    waitPollTimer = setInterval(() => {
      // document.hidden matters as much as the view check: a phone in a pocket
      // with this page open would otherwise poll all night. Every poll is a
      // billed n8n execution, and this account has been locked out by quota
      // before (2026-08-12), so an idle screen must cost nothing.
      if (document.hidden) return;
      if (adminPinOk && !$('view-home').classList.contains('hidden')) loadWaiting({ silent: true });
    }, 10000);
  }

  $('brandHome').onclick = () => { show('home'); loadWaiting(); startWaitPoll(); };
  $('btnGoCreate').onclick = () => show('create');
  $('btnGoSelect').onclick = () => { show('select'); loadProfiles(); };
  $('adminMenuBtn').onclick = () => { openAdmin(); };
  $('waitReload').onclick = () => { lastWaitSig = ''; loadWaiting(); };
  // Up one level, never out of the app. The phone's own back button still walks
  // the full history separately.
  $('backBtn').onclick = () => {
    const parent = VIEW_PARENT[currentView()] || 'home';
    if (parent === 'select') { show('select'); loadProfiles(); }
    else if (parent === 'home') { show('home'); loadWaiting(); startWaitPoll(); }
    else show(parent);
  };

  /* ============================================================
     PROFILES
     ============================================================ */
  async function loadProfiles() {
    const list = $('profileList');
    list.innerHTML = '<p class="muted center">Loading crew…</p>';
    try {
      const profiles = rows(await api('tc-profiles'));
      if (!profiles.length) {
        list.innerHTML = '<p class="muted center">No profiles yet — create the first one.</p>';
        return;
      }
      list.innerHTML = '';
      profiles
        .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))
        .forEach((p) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'profile-item';
          btn.innerHTML = `
            <span class="profile-avatar">${esc((p.first_name || '?')[0] || '')}${esc((p.last_name || '')[0] || '')}</span>
            <span><span class="profile-item-name">${esc(p.first_name)} ${esc(p.last_name)}</span><br>
            <span class="profile-item-sub">${esc(p.phone || p.email || '')}</span></span>`;
          btn.onclick = () => openProfile(p);
          list.appendChild(btn);
        });
    } catch {
      list.innerHTML = '<p class="form-err center">Couldn\'t load profiles. Check connection and retry.</p>';
    }
  }

  $('createForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('cpSubmit');
    // First name, last name and email are what the Tuesday time sheet needs to
    // reach this person. The fields are `required`, but that lets a space
    // through and can pin the browser's popup to a field scrolled out of the
    // card — so check here and say plainly what is missing.
    const first = $('cpFirst').value.trim();
    const last = $('cpLast').value.trim();
    const email = $('cpEmail').value.trim();
    const missing = [];
    if (!first) missing.push('first name');
    if (!last) missing.push('last name');
    if (!email) missing.push('email address');
    if (!missing.length && !/.+@.+\..+/.test(email)) missing.push('a valid email address');
    if (missing.length) {
      $('cpErr').textContent = `Add your ${missing.join(' and ')} — your time sheet is emailed to you every Tuesday.`;
      $('cpErr').classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    $('cpErr').classList.add('hidden');
    try {
      const profile = await api('tc-profiles', {
        method: 'POST',
        body: JSON.stringify({
          first_name: first,
          last_name: last,
          dob: $('cpDob').value,
          email,
          phone: $('cpPhone').value.trim(),
        }),
      });
      $('createForm').reset();
      toast('Profile created. Welcome aboard!');
      openProfile(profile);
    } catch {
      $('cpErr').textContent = 'Could not create profile — try again.';
      $('cpErr').classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  };

  /* ============================================================
     PROFILE VIEW — punch lifecycle
     ============================================================ */
  let current = { profile: null, punches: [], open: null };

  async function openProfile(profile) {
    current.profile = profile;
    $('pfName').textContent = `${profile.first_name} ${profile.last_name}`;
    $('pfMeta').textContent = profile.email || '';
    show('profile');
    renderCreateEventAccess(profile);
    await refreshProfile();
  }

  /**
   * Whoever an admin has switched ON in Crew can post an event themselves —
   * the first person to arrive doesn't have to wait for Thomas or Josh. They
   * cannot delete one: deleting is still behind the admin PIN, by design.
   */
  async function renderCreateEventAccess(profile) {
    const slot = $('pfCreateEvent');
    if (!slot) return;
    slot.classList.add('hidden');
    slot.innerHTML = '';
    let allowed = false;
    try {
      allowed = rows(await api('tc-crew-flags'))
        .some((f) => String(f.profile_id) === String(profile.id) && f.can_create_events === true);
    } catch { return; }
    if (!allowed) return;

    /* A real form with native date/time pickers, not five window.prompt boxes.
       Prompts could only ever describe ONE day, and an event that runs Friday
       to Sunday is normal here — so start and end each get their own date. */
    slot.innerHTML = `
      <button type="button" class="big-btn outline" id="pfCreateToggle">
        <span class="big-btn-title">＋ CREATE EVENT</span>
        <span class="big-btn-sub">Everyone will see it on the clock-in list</span>
      </button>
      <div class="pf-create-form hidden" id="pfCreateForm">
        <div class="field-block">
          <label class="field-label" for="pfEvName">Event name</label>
          <input type="text" id="pfEvName" maxlength="60" autocomplete="off" placeholder="e.g. Maintenance at Midtown">
        </div>
        <div class="field-block">
          <span class="field-label">Starts</span>
          <div class="pf-when">
            <input type="date" id="pfEvStartDate">
            <input type="time" id="pfEvStartTime" value="16:00">
          </div>
        </div>
        <div class="field-block">
          <span class="field-label">Ends</span>
          <div class="pf-when">
            <input type="date" id="pfEvEndDate">
            <input type="time" id="pfEvEndTime" value="23:00">
          </div>
          <p class="field-note muted">Same day for a normal shift. Set a later end date for anything that runs more than one day.</p>
        </div>
        <p class="form-err hidden" id="pfEvErr"></p>
        <button type="button" class="big-btn primary" id="pfEvCreate"><span class="big-btn-title">CREATE EVENT</span></button>
      </div>`;

    const form = $('pfCreateForm');
    const errBox = $('pfEvErr');
    const today = localDate();
    $('pfEvStartDate').value = today;
    $('pfEvEndDate').value = today;

    $('pfCreateToggle').onclick = () => {
      form.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) $('pfEvName').focus();
    };

    const fail = (msg) => { errBox.textContent = msg; errBox.classList.remove('hidden'); };

    $('pfEvCreate').onclick = async () => {
      errBox.classList.add('hidden');
      const name = String($('pfEvName').value || '').trim().replace(/\s+/g, ' ');
      const sd = $('pfEvStartDate').value;
      const st = $('pfEvStartTime').value;
      const ed = $('pfEvEndDate').value;
      const et = $('pfEvEndTime').value;
      if (name.length < 2) return fail('Give the event a name first.');
      if (!sd || !st || !ed || !et) return fail('Fill in both dates and both times.');
      const startAt = new Date(`${sd}T${st}`);
      let endAt = new Date(`${ed}T${et}`);
      if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return fail('That date or time didn\'t read right.');
      // Same day with an earlier end time means it runs past midnight — the
      // normal case for a night shift, so roll it rather than reject it.
      let rolled = false;
      if (endAt <= startAt && sd === ed) { endAt = new Date(endAt.getTime() + 86400000); rolled = true; }
      if (endAt <= startAt) return fail('The end has to come after the start.');

      const btn = $('pfEvCreate');
      btn.disabled = true;
      btn.querySelector('.big-btn-title').textContent = 'CREATING…';
      try {
        await api('tc-events', {
          method: 'POST',
          body: JSON.stringify({
            creator_id: profile.id,
            name,
            start_at: localISO(startAt),
            end_at: localISO(endAt),
            owner_email: '',
          }),
        });
        toast(rolled
          ? `"${name}" is live — it ends the next morning, everyone can clock into it now.`
          : `"${name}" is live — everyone can clock into it now.`, false, 4500);
        $('pfEvName').value = '';
        form.classList.add('hidden');
      } catch {
        fail('Couldn\'t create that event — ask Thomas or Josh.');
      }
      btn.disabled = false;
      btn.querySelector('.big-btn-title').textContent = 'CREATE EVENT';
    };

    slot.classList.remove('hidden');
  }

  async function refreshProfile() {
    const histBox = $('pfHistory');
    $('pfAction').innerHTML = '<p class="muted center">Loading…</p>';
    histBox.innerHTML = '<p class="muted center">Loading…</p>';
    try {
      const punches = rows(await api(`tc-history?profileId=${encodeURIComponent(current.profile.id)}`))
        .sort((a, b) => String(b.clock_in).localeCompare(String(a.clock_in)));
      current.punches = punches;
      current.open = punches.find((p) => p.status === 'in' || p.status === 'break') || null;
      renderAction();
      renderHistory();
    } catch {
      $('pfAction').innerHTML = '<p class="form-err center">Couldn\'t reach the time clock. Retry.</p>';
      histBox.innerHTML = '';
    }
  }

  function renderAction() {
    const box = $('pfAction');
    box.innerHTML = '';
    const p = current.open;

    if (!p) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'big-btn green';
      btn.innerHTML = '<span class="big-btn-title">⏱ CLOCK IN</span><span class="big-btn-sub">Create clock-in time</span>';
      btn.onclick = startWizard;
      box.appendChild(btn);
      return;
    }

    // live shift card
    const card = document.createElement('div');
    card.className = 'shift-card';
    card.innerHTML = `
      <div class="shift-event">${esc(p.event_name || 'On the clock')}</div>
      <div class="shift-row"><span>Clocked in</span><b>${fmtTime(p.clock_in)}</b><span class="stamp in">IN</span></div>
      ${p.break_start ? `<div class="shift-row"><span>Break start</span><b>${fmtTime(p.break_start)}</b><span class="stamp break">BREAK</span></div>` : ''}
      ${p.break_end ? `<div class="shift-row"><span>Break end</span><b>${fmtTime(p.break_end)}</b><span class="stamp in">BACK</span></div>` : ''}`;
    box.appendChild(card);

    // break checkbox row
    const br = document.createElement('div');
    br.className = 'break-row';
    const canStartBreak = !p.break_start;
    const onBreak = p.status === 'break';
    br.innerHTML = `
      <span class="break-label"><span class="tc-check ${p.break_taken ? 'checked' : ''}"></span> BREAK</span>`;
    const brBtn = document.createElement('button');
    brBtn.type = 'button';
    brBtn.className = 'chip-btn';
    if (onBreak) {
      brBtn.textContent = 'END BREAK';
      brBtn.onclick = () => punchUpdate('break_end', 'End your break?', 'You\'ll be back on the clock.');
    } else if (canStartBreak) {
      brBtn.textContent = 'START BREAK';
      brBtn.onclick = () => punchUpdate('break_start', 'Start your break?', 'Break time will be logged on your sheet.');
    } else {
      brBtn.textContent = 'BREAK TAKEN';
      brBtn.disabled = true;
    }
    br.appendChild(brBtn);
    box.appendChild(br);

    // clock out
    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'big-btn danger';
    out.innerHTML = '<span class="big-btn-title">CLOCK OUT</span><span class="big-btn-sub">End your shift</span>';
    out.disabled = onBreak;
    out.title = onBreak ? 'End your break first' : '';
    out.onclick = async () => {
      const updated = await punchUpdate('clock_out', 'Are you sure?', 'This ends your shift and stamps your clock-out time.');
      if (updated) showSummary(updated);
    };
    box.appendChild(out);
  }

  async function punchUpdate(action, title, text) {
    if (!current.open) return null;
    const yes = await confirmAsk(title, text);
    if (!yes) return null;
    try {
      const updated = await api('tc-punch', {
        method: 'POST',
        body: JSON.stringify({ action, punch_id: current.open.id, time: localISO() }),
      });
      await refreshProfile();
      if (action !== 'clock_out') toast(action === 'break_start' ? 'Break started.' : 'Back on the clock.');
      return updated;
    } catch {
      toast('That didn\'t go through — try again.', true);
      return null;
    }
  }

  function renderHistory() {
    const box = $('pfHistory');
    box.innerHTML = '';
    if (!current.punches.length) {
      box.innerHTML = '<p class="muted center">No shifts yet. Your history sticks around forever once you clock in.</p>';
      return;
    }
    current.punches.forEach((p) => {
      const live = p.status === 'in' || p.status === 'break';
      const h = shiftHours(p);
      const card = document.createElement('div');
      card.className = `hist-card${live ? ' hist-live' : ''}`;
      card.innerHTML = `
        <div class="hist-top">
          <span class="hist-date">${fmtDate(p.work_date)}</span>
          <span class="hist-event">${esc(p.event_name || '')}</span>
        </div>
        <div class="hist-grid">
          <div><span>In:</span> <b>${fmtTime(p.clock_in)}</b></div>
          <div><span>Out:</span> <b>${live ? 'on the clock' : fmtTime(p.clock_out)}</b></div>
          <div><span>Break in:</span> <b>${fmtTime(p.break_start)}</b></div>
          <div><span>Break out:</span> <b>${fmtTime(p.break_end)}</b></div>
        </div>
        <div class="hist-break">
          <span class="tc-check ${p.break_taken ? 'checked' : ''}"></span>
          ${p.break_taken ? 'BREAK TAKEN' : 'NO BREAK'}
          ${h != null ? `<span style="margin-left:auto"><b>${h.toFixed(2)} hrs</b></span>` : ''}
        </div>`;
      box.appendChild(card);
    });
  }

  /* ============================================================
     CLOCK-IN WIZARD — event pick + 1 required selfie
     ============================================================ */
  const SHOTS = [
    { key: 'selfie', title: 'YOU, ON SITE', sub: 'Selfie proving you\'re here. Look alive.', facing: 'user' },
  ];
  let wiz = null;

  async function startWizard() {
    wiz = { step: 0, event: null, photos: {}, stream: null };
    $('wizard').classList.remove('hidden');
    await renderWizard();
  }

  function stopStream() {
    if (wiz && wiz.stream) {
      wiz.stream.getTracks().forEach((t) => t.stop());
      wiz.stream = null;
    }
  }

  $('wizClose').onclick = () => { stopStream(); $('wizard').classList.add('hidden'); wiz = null; };

  async function renderWizard() {
    if (!wiz) return;
    const body = $('wizBody');
    stopStream();

    /* step 0 — what's this job for? (scheduled event, recent job, or typed) */
    if (wiz.step === 0) {
      $('wizStep').textContent = 'STEP 1 — JOB';
      body.innerHTML = '<div class="wiz-title">WHAT\'S THIS JOB FOR?</div><div class="wiz-sub">Checking today\'s events…</div>';
      let events = [];
      try {
        meta = loadMeta();
        await (metaSyncReady || Promise.resolve());
        await ensureMetaSynced({ allowPush: false });
        // LIVE RIGHT NOW only. The old filter kept anything not yet finished,
        // which offered events that had not started — so a worker could clock
        // into next Saturday's gig today. An event is offered only while the
        // clock is actually inside its window.
        const now = Date.now();
        events = rows(await api('tc-events')).map(applyEventEdit).filter((ev) => {
          if (isMetaEvent(ev) || isDeleted(ev.id) || isArchived(ev.id)) return false;
          const startsAt = Date.parse(ev.start_at || '');
          const endsAt = Date.parse(ev.end_at || '');
          if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return false;
          return startsAt <= now && now <= endsAt;
        });
      } catch { /* couldn't reach the schedule — the empty state below says so */ }

      /* Clocking in is TAP-ONLY, and only ACTIVE events are offered (Thomas,
         2026-08-26). No text box and no saved-event chips: both could put a
         worker on a job that is not running, and a typed one created an ad-hoc
         event carrying no policy packs — one typo split a crew's hours across
         two names on the time sheet. If nothing is live, nothing is offered.
         Creating an event belongs in Create Event, to whoever is permitted. */
      const sub = events.length
        ? 'Tap the event you\'re working.'
        : 'Nothing is running right now.';
      body.innerHTML = `
        <div class="wiz-title">WHAT'S THIS JOB FOR?</div>
        <div class="wiz-sub">${sub}</div>
        ${events.length
          ? '<div class="wiz-events" id="wizEvents"></div>'
          : `<p class="form-err center">No job is active right now, so there is nothing to clock into.
             A job only appears here while it is running. If you should be working, ask whoever runs
             the schedule to create the event under CREATE EVENT.</p>`}`;

      // Admins are trusted (Thomas, 2026-09-10): no selfie step on this app.
      // Step 1 is the camera; jumping to 2 lands on policies / CLOCK IN NOW.
      const choose = (ev) => { wiz.event = ev; wiz.step = 2; renderWizard(); };

      const list = $('wizEvents');
      if (list) {
        events.forEach((ev) => {
          const packs = policiesForEvent(ev);
          const packLabel = packs.length ? packs.map((p) => p.title).join(' + ') : 'No policies set';
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'profile-item';
          b.innerHTML = `<span><span class="profile-item-name">${esc(ev.name)}</span><br>
            <span class="profile-item-sub">${fmtTime(ev.start_at)} → ${fmtTime(ev.end_at)} · ${esc(packLabel)}</span></span>`;
          b.onclick = () => choose(ev);
          list.appendChild(b);
        });
      }

      return;
    }

    /* step 1 — selfie */
    if (wiz.step === 1) {
      const shot = SHOTS[0];
      const needsPolicies = policiesForEvent(wiz.event).length > 0;
      $('wizStep').textContent = needsPolicies ? 'STEP 2/4 — SELFIE' : 'STEP 2/3 — SELFIE';
      body.innerHTML = `
        <div class="wiz-title">${shot.title}</div>
        <div class="wiz-sub">${shot.sub} <b>Required.</b></div>
        <div class="cam-stage">
          <video id="camVideo" autoplay playsinline muted></video>
          <img id="camPreview" class="hidden" alt="preview">
          <div class="cam-frame"></div>
        </div>
        <div class="wiz-actions" id="camActions">
          <button class="big-btn outline" id="camFlip" type="button"><span class="big-btn-title">🔄 FLIP CAMERA</span></button>
          <button class="big-btn primary" id="camSnap" type="button"><span class="big-btn-title">📸 SNAP</span></button>
        </div>
        <div class="wiz-fallback">
          <label>Camera not working? Take it with your phone camera<input type="file" id="camFile" accept="image/*" capture></label>
        </div>`;

      const video = $('camVideo');
      const camErr = (msg) => {
        const stage = body.querySelector('.cam-stage');
        if (!stage || body.querySelector('.cam-error')) return;
        stage.insertAdjacentHTML('beforebegin', `<p class="form-err cam-error">${esc(msg)}</p>`);
      };

      // Which way the camera is pointing. Starts on the selfie camera and the
      // worker can flip to the back camera to show where they are.
      if (!wiz.facing) wiz.facing = shot.facing;

      async function startCam(facing) {
        stopStream();
        try {
          wiz.stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: facing }, width: { ideal: 1280 } }, audio: false,
          });
        } catch {
          camErr('Camera blocked — allow camera access, or use the phone-camera link below.');
          return false;
        }
        video.srcObject = wiz.stream;
        // The selfie view is mirrored the way a mirror is, which is what people
        // expect; the captured frame is drawn from the unmirrored video, so the
        // saved photo is never backwards.
        video.style.transform = facing === 'user' ? 'scaleX(-1)' : 'none';
        // iOS Safari does not reliably autoplay a stream attached after the
        // element was inserted, and a video that never plays reports
        // videoWidth 0 — which is what made SNAP capture a blank frame.
        if (video.readyState < 1) {
          await new Promise((resolve) => {
            const done = () => resolve();
            video.addEventListener('loadedmetadata', done, { once: true });
            setTimeout(done, 4000);
          });
        }
        try { await video.play(); } catch { /* already playing, or blocked; videoWidth still tells us */ }
        return true;
      }

      await startCam(wiz.facing);

      $('camFlip').onclick = async () => {
        const btn = $('camFlip');
        btn.disabled = true;
        wiz.facing = wiz.facing === 'user' ? 'environment' : 'user';
        const ok = await startCam(wiz.facing);
        // A phone with only one camera keeps working — flip back rather than
        // leaving the worker staring at a dead stage.
        if (!ok) {
          wiz.facing = wiz.facing === 'user' ? 'environment' : 'user';
          await startCam(wiz.facing);
        }
        btn.disabled = false;
      };

      const accept = (dataUrl) => {
        wiz.photos[shot.key] = dataUrl;
        stopStream();
        $('camVideo').classList.add('hidden');
        const img = $('camPreview');
        img.src = dataUrl;
        img.classList.remove('hidden');
        $('camActions').innerHTML = '';
        const retake = document.createElement('button');
        retake.type = 'button';
        retake.className = 'big-btn outline';
        retake.innerHTML = '<span class="big-btn-title">RETAKE</span>';
        retake.onclick = () => renderWizard();
        const next = document.createElement('button');
        next.type = 'button';
        next.id = 'wizPunch';
        // No policy pack on this job (typed jobs never have one) — the photo IS the last step.
        next.className = needsPolicies ? 'big-btn primary' : 'big-btn green';
        next.innerHTML = `<span class="big-btn-title">${needsPolicies ? 'CONTINUE →' : '⏱ CLOCK IN'}</span>`;
        next.onclick = needsPolicies
          ? () => { wiz.step = 2; renderWizard(); }
          : () => submitClockIn();
        $('camActions').append(retake, next);
        if (!needsPolicies && !$('wizErr')) {
          $('camActions').insertAdjacentHTML('afterend',
            '<p class="form-err hidden" id="wizErr" style="margin-top:.7rem"></p>');
        }
      };

      $('camSnap').onclick = () => {
        // videoWidth is 0 until the stream is actually playing. Capturing then
        // produces a blank frame that looks like a white box, so refuse it.
        if (!video.videoWidth || !video.videoHeight) {
          toast('Camera not ready yet — give it a second, or use the phone-camera link.', true);
          return;
        }
        accept(frameToJpeg(video, video.videoWidth, video.videoHeight));
      };
      $('camFile').onchange = (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const img = new Image();
        img.onload = () => accept(frameToJpeg(img, img.naturalWidth, img.naturalHeight));
        img.src = URL.createObjectURL(f);
      };
      return;
    }

    /* step 2 — acknowledge every policy attached to this event (after selfie) */
    if (wiz.step === 2) {
      meta = loadMeta();
      const packs = policiesForEvent(wiz.event);
      $('wizStep').textContent = packs.length ? 'STEP 3/4 — POLICIES' : 'STEP 3/3 — CLOCK IN';
      if (!packs.length) {
        body.innerHTML = `
          <div class="wiz-title">READY TO CLOCK IN</div>
          <div class="wiz-sub">No policy pack on <b>${esc(wiz.event.name)}</b>. Hit the button and you're on the clock.</div>
          <div class="wiz-actions">
            <button class="big-btn green" id="wizPunch" type="button"><span class="big-btn-title">⏱ CLOCK IN NOW</span></button>
          </div>
          <p class="form-err hidden" id="wizErr" style="margin-top:.7rem"></p>`;
        $('wizPunch').onclick = submitClockIn;
        return;
      }
      const packTitles = packs.map((p) => p.title).join(' · ');
      body.innerHTML = `
        <div class="wiz-title">READ & ACKNOWLEDGE</div>
        <div class="wiz-sub">${esc(wiz.event.name)} — scroll through every policy below, then confirm.</div>
        <p class="wiz-policy-list muted">${esc(packTitles)}</p>
        <div class="wiz-policy-scroll" id="wizPolicyScroll">${renderPolicyAckHtml(packs)}</div>
        <p class="wiz-scroll-hint" id="wizScrollHint">Scroll to the bottom to unlock acknowledge.</p>
        <label class="wiz-ack-check" id="wizAckLabel">
          <input type="checkbox" id="wizAckCheck" disabled>
          <span>I understand this policy and will conduct by such</span>
        </label>
        <div class="wiz-actions">
          <button class="big-btn green" id="wizPunch" type="button" disabled>
            <span class="big-btn-title">OK — CLOCK IN</span>
          </button>
        </div>
        <p class="form-err hidden" id="wizErr" style="margin-top:.7rem"></p>`;

      const scroller = $('wizPolicyScroll');
      const check = $('wizAckCheck');
      const punch = $('wizPunch');
      const hint = $('wizScrollHint');
      const unlock = () => {
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 12;
        if (atBottom) {
          check.disabled = false;
          hint.textContent = 'Check the box, then hit OK.';
          hint.classList.add('ready');
        }
        punch.disabled = !(atBottom && check.checked);
      };
      // short policies: unlock immediately if nothing to scroll
      requestAnimationFrame(() => {
        if (scroller.scrollHeight <= scroller.clientHeight + 4) {
          check.disabled = false;
          hint.textContent = 'Check the box, then hit OK.';
          hint.classList.add('ready');
        }
        unlock();
      });
      scroller.addEventListener('scroll', unlock, { passive: true });
      check.addEventListener('change', unlock);
      punch.onclick = submitClockIn;
      return;
    }

    /* step 3 — congratulations (shown after successful punch) */
    $('wizStep').textContent = policiesForEvent(wiz.event).length ? 'STEP 4/4 — DONE' : 'STEP 3/3 — DONE';
    body.innerHTML = `
      <div class="wiz-congrats">
        <div class="wiz-title">CONGRATULATIONS</div>
        <div class="wiz-sub">You are now clocked in for <b>${esc(wiz.event.name)}</b>.</div>
        <div class="wiz-actions">
          <button class="big-btn primary" id="wizDone" type="button"><span class="big-btn-title">DONE</span></button>
        </div>
      </div>`;
    $('wizDone').onclick = () => {
      $('wizard').classList.add('hidden');
      wiz = null;
    };
  }

  function renderPolicyAckHtml(packs) {
    return (packs || []).map((pack) => {
      const full = (pack.sections || []).map((s) => `<h5>${esc(s.h)}</h5>${esc(s.body)}`).join('');
      return `<div class="policy-block">
        <h4>${esc(pack.title)}</h4>
        <ul>${(pack.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
        ${full ? `<div class="policy-full">${full}</div>` : ''}
      </div>`;
    }).join('');
  }

  function frameToJpeg(source, w, h) {
    const MAX = 1024;
    const scale = Math.min(1, MAX / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  }

  async function submitClockIn() {
    const btn = $('wizPunch');
    if (!btn) return;
    btn.disabled = true;
    const title = btn.querySelector('.big-btn-title');
    const originalLabel = title ? title.textContent : '';
    if (title) title.textContent = 'STAMPING…';
    try {
      await api('tc-punch', {
        method: 'POST',
        body: JSON.stringify({
          action: 'clock_in',
          profile_id: current.profile.id,
          profile_name: `${current.profile.first_name} ${current.profile.last_name}`,
          event_id: wiz.event.id,
          event_name: wiz.event.name,
          work_date: localDate(),
          clock_in: localISO(),
          photos: wiz.photos,
          policies_acked: policiesForEvent(wiz.event).map((p) => p.id),
        }),
      });
      wiz.step = 3;
      await renderWizard();
      toast('Clocked in. Have a good shift!');
      await refreshProfile();
    } catch {
      const err = $('wizErr');
      if (err) {
        err.textContent = 'Clock-in failed — check signal and try again.';
        err.classList.remove('hidden');
      } else {
        toast('Clock-in failed — check signal and try again.', true);
      }
      btn.disabled = false;
      if (title) title.textContent = originalLabel;
    }
  }

  /* ---------- shift summary after clock-out ---------- */
  function showSummary(p) {
    const h = shiftHours(p);
    $('summaryBody').innerHTML = `
      <div class="summary-sheet">
        <div class="shift-event">${esc(p.event_name || '')} — ${fmtDate(p.work_date)}</div>
        <div class="shift-row"><span>Shift start</span><b>${fmtTime(p.clock_in)}</b></div>
        <div class="shift-row"><span>Clocked in</span><b>${fmtTime(p.clock_in)}</b></div>
        ${p.break_taken
          ? `<div class="shift-row"><span>Break start</span><b>${fmtTime(p.break_start)}</b></div>
             <div class="shift-row"><span>Break end</span><b>${fmtTime(p.break_end)}</b></div>`
          : '<div class="shift-row"><span>Break</span><b>none taken ☐</b></div>'}
        <div class="shift-row"><span>Clocked out</span><b>${fmtTime(p.clock_out)}</b></div>
        <div class="summary-total"><span>TOTAL</span><span>${h != null ? `${h.toFixed(2)} HRS` : '—'}</span></div>
      </div>`;
    $('summaryModal').classList.remove('hidden');
  }
  $('summaryClose').onclick = () => $('summaryModal').classList.add('hidden');

  /* ============================================================
     EVENT META (archive / delete / emails / policies)
     localStorage is a cache. Cloud sync = sentinel n8n event
     __JUSTUS_TC_META__ so phone + desktop share one playing field.
     ============================================================ */
  const META_KEY = 'justus-tc-meta-v1';
  const META_EVENT_NAME = '__JUSTUS_TC_META__';
  const META_PREFIX = 'META_V1.';
  const POLICY_PACKS = {
    general: {
      id: 'general',
      title: 'General Staff Handbook',
      blurb: 'All events, all staff — alcohol, conduct, attendance, clock-in, vest, breaks, phones, discipline.',
      bullets: [
        'Zero-tolerance alcohol/sobriety on site — termination if violated.',
        'Clock in/out on your own device with a live selfie — no buddy punching.',
        'Arrive ~15 min early, vest on, ready at your post.',
        'Professional conduct with clients, guests, and crew at all times.',
        'Breaks logged accurately; clock-out blocked while on break.',
        'Personal phone use limited to clock-in/out, emergencies, or scheduled breaks.',
        'Client names, event details, and pricing stay confidential.',
      ],
      sections: [
        { h: 'Policy #1 — Alcohol & Sobriety (Zero Tolerance)', body: 'If you are at an event working, helping out, or on site in any capacity for JustUs Entertainment, you do not drink. At all. Not one drink. This applies whether you are clocked in or not, on break or not, in a vest or not, and whether alcohol is free. You may not arrive already under the influence, and you may not leave to drink and come back.\n\nCaught drinking or impaired: (1) immediate removal, unpaid for the rest of the shift, safe transport arranged — you will not drive yourself; (2) termination effective immediately — outside progressive discipline; (3) off the schedule. Rehire is owner discretion only, not a built-in second chance.\n\nIf offered a drink: “I appreciate it, but I\'m working.” If on impairing medication, tell your lead before the shift. If you see a coworker drinking, tell your lead immediately.' },
        { h: '02 — Code of Conduct', body: 'Treat every client, guest, coworker, and vendor with respect. No yelling, profanity directed at others, discrimination, or harassment — zero tolerance. No drugs or impairing substances before or during a shift. Represent JustUs Entertainment professionally on site. Follow reasonable direction from event leads; concerns go through the chain of command, not in front of clients.' },
        { h: '03 — Attendance, Punctuality & No-Show', body: 'Show up ~15 minutes early. Ready means parked, walked in, vest on, at your post. Up to 15 minutes late is workable only with a heads-up. More than 15 late or late with no heads-up: 1st verbal warning (logged), 2nd written, 3rd sat at home for that shift. No-call / no-show = suspended pending a management conversation. Schedule drops Wednesday — request off then. Day-of backing out is not acceptable except genuine emergencies.' },
        { h: '04 — Clock-In / Clock-Out & Photo Verification', body: 'All shifts tracked in this TimeClock app. Clock in/out on your own device — buddy punching is termination for both people. Clock-in requires one live selfie. Select the correct event. Log breaks accurately. Review the shift summary at clock-out; report discrepancies same day.' },
        { h: '05 — Appearance & High-Visibility Vest', body: 'Look professional. Wear your vest wherever issued (e.g. yellow PBR vests) at all times at your post. Closed-toe shoes for physical/outdoor posts. No offensive or alcohol/drug-branded apparel. The vest makes you findable, shows you are at post, signals support to security/police, and is a safety marker.' },
        { h: '06 — Event Day Conduct', body: 'You are a guest on the client\'s property. Stay at your assigned post unless directed otherwise. No personal guests at your post. Do not consume client food/drink unless lead-approved — alcohol never. Handle equipment with care; report damage. Direct pricing/contract/complaint questions to your lead — do not negotiate for the company.' },
        { h: '07 — Break Policy', body: '6+ hour shift: one 30-minute break (does not stack). Under 6 hours: no break. Log break start/end in the app. Do not leave post until lead confirms coverage. Do not clock out while a break is active. Policy #1 still applies on break.' },
        { h: '08 — Cell Phone & Communication', body: 'Personal phone use limited to clock-in/out, emergencies, or scheduled breaks. No phone use in front of clients during active work. No public photos/videos of clients/guests/private details without written client and management approval. Ringer silent on shift.' },
        { h: '09 — Progressive Discipline', body: 'Verbal warning → written warning → final written / suspension → termination. Zero-tolerance (no steps): drinking/impairment, harassment, discrimination, theft, buddy-punching.' },
        { h: '10 — Confidentiality & Social Media', body: 'Client names, event details, guest info, and pricing are confidential. No personal social posts about a client event without written approval. Approved content must reflect positively. Do not share internal scheduling, pay, or staffing outside the company.' },
      ],
    },
    pbr: {
      id: 'pbr',
      title: 'PBR & Rodeo (Big Sky)',
      blurb: 'Event-specific — parking, ticket booth, skyboxes. Check this plus the General Handbook when both apply.',
      bullets: [
        'Three stations: Parking Lot, Ticket Booth (scan + bracelets), Skyboxes & Crowd Control.',
        'Yellow high-vis vest on the entire post — never take it off on site.',
        'Parking: never box cars in; front lot only for handicapped / reserved / authorities / competitors.',
        'Ticket booth: security clears bags first, then one scan per person; match bracelet to ticket type.',
        'Skyboxes are lanyard-only. No lanyard = no access.',
        'Know your post (top / middle / bottom) and gate times before doors open.',
      ],
      sections: [
        { h: 'Overview', body: 'Stacks on the General Staff Policy Handbook. Three stations: (1) Parking Lot, (2) Ticket Booth — Scanning & Bracelets, (3) Skyboxes & Crowd Control. Know which station and position before gates open. When it is a rodeo, follow RODEO notes where they differ from PBR.' },
        { h: 'Section 1 — Parking Lot', body: 'Parking crew has the most authority of any station — be firm, clear, keep cars moving. Never let anyone park behind another car or box someone in.\n\nPBR Lower / Roundabout: send everyone into the lot up to the left. Spectators: straight, then left into general lot. Trail users: same left lot; warn trail closes at 6:00 PM ~2 hours. VIP parks in general lot — NOT front. FRONT LOT only: Handicapped, Reserved, Authorities/police, Competitors. Vendors/staff: general only. Media: one vehicle up front; extras in the big lot.\n\nDrop-off/bus script: “Keep going straight, go PAST the road closed sign, then there’s a stop sign — stop there and hop out. Then take the left down the parking entrance and come back out the way you came in.” Emphasize past the road-closed sign.\n\nTop lot (PBR): blocked for buses; no through traffic; run drop-off up top; reserved/handicapped go to bottom roundabout. VIP/reserved post: keep entrance AND exit open.\n\nPBR staffing (3): top, middle, bottom (strongest / lead).\n\nRODEO: keep RIGHT lane free. Buses up right, drop at gate, out to bottom lot. Top/bottom gate people open for buses. Extra person guides bottom lot; use rocks for lines. Cowboy trailers may change layout — use discretion. Always know top / middle / bottom and roundabout vs gate.' },
        { h: 'Section 2 — Ticket Booth', body: 'Security clears bags FIRST — then scan. One scan per person. Call out ticket type so bracelet person matches VIP vs GA. No outside drinks until finished. Usually NO re-entry — confirm with lead. Bracelets: snug but not tight (two bottom fingers underneath) — especially for kids. Backup phone ready; do not lock phone; use search by name if ticket fails.\n\nPresentation: smile, upbeat, yellow vest always on, no eating on post. Gates ~6:00 PM (sometimes 5:45); event ~7:00; real action ~7:30–8:00. Aspen Lane CLOSED — detour via Simkins Street.' },
        { h: 'Section 3 — Skyboxes & Crowd Control', body: 'Skyboxes are lanyard-only. Skybox 1 closest to entrance; 1–4 first bleacher set; 5–7 next; 8–10 far end by GA. Number is on bottom-left of lanyard. Sky View Platform is the tallest separate section — wristband-only guests not allowed; stop lanyard hand-offs.\n\nBleachers: check lanyard/wristband on the walk path. After show starts, no one against the rail blocking views. Escalation after two warnings: call on walkie with position (South/East/North bleachers) for backup/escort.' },
      ],
    },
  };
  const DEFAULT_TEMPLATES = [
    { id: 'tpl-pbr', name: 'PBR / Rodeo — Big Sky', policyKeys: ['general', 'pbr'] },
  ];

  function normalizePolicyKeys(val) {
    if (Array.isArray(val)) return val.filter((k) => POLICY_PACKS[k]);
    if (typeof val === 'string' && POLICY_PACKS[val]) return [val];
    return [];
  }
  function normalizeTemplate(t) {
    if (!t || !t.name) return null;
    if (/^general event$/i.test(String(t.name).trim())) return null; // retired placeholder
    const policyKeys = normalizePolicyKeys(t.policyKeys != null ? t.policyKeys : t.policyKey);
    return {
      id: t.id || `tpl-${Date.now()}`,
      name: String(t.name).trim(),
      policyKeys: policyKeys.length ? policyKeys : [],
      startHour: Number.isFinite(t.startHour) ? t.startHour : 10,
      startMin: Number.isFinite(t.startMin) ? t.startMin : 0,
      endHour: Number.isFinite(t.endHour) ? t.endHour : 22,
      endMin: Number.isFinite(t.endMin) ? t.endMin : 0,
      emails: Array.isArray(t.emails) ? t.emails.map(normalizeEmail).filter(isEmail) : [],
      duration: ['today', 'tomorrow', 'weekend', 'week', 'custom'].includes(t.duration) ? t.duration : 'custom',
      savedAt: Number(t.savedAt) || Date.now(),
    };
  }
  function migrateEventPolicyMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach((id) => {
      const keys = normalizePolicyKeys(raw[id]);
      if (keys.length) out[id] = keys;
    });
    return out;
  }
  /* ---------- Choose Event tombstones ----------

     Deleting a saved event USED TO ONLY REMOVE IT LOCALLY. mergeTemplates is a
     union of the local list and the blob on the server, so the very next cloud
     sync merged the deleted chip straight back — you could tap delete all night
     and they kept coming back. Events already had a `deleted` tombstone map;
     Choose Event had none. This is that missing map.

     Keyed by LOWERCASED NAME, not id, because mergeTemplates keys by name and
     the same event carries different ids on different devices (tpl-sync-6 here,
     tpl-1785531594210 there). An id-keyed tombstone would miss its twin. */
  const tplKey = (name) => String(name || '').trim().toLowerCase();
  const isTemplateDeleted = (map, name) => !!(map && map[tplKey(name)]);
  const dropDeletedTemplates = (list, map) =>
    (list || []).filter((t) => t && !isTemplateDeleted(map, t.name));

  // The four Thomas asked to keep (2026-08-26). Everything else in Choose Event
  // at that point was test junk — PBR1, Real Test Event, Webhook Test Event.
  const CLEANUP_V1_KEEP = ['pbr / rodeo — big sky', 'wildlands', 'music in the mountains', 'rbar'];

  function loadMeta() {
    try {
      const raw = JSON.parse(localStorage.getItem(META_KEY) || '{}');
      const deletedTemplates = raw.deletedTemplates && typeof raw.deletedTemplates === 'object'
        ? { ...raw.deletedTemplates } : {};
      let templates = (Array.isArray(raw.templates) ? raw.templates : [])
        .map(normalizeTemplate)
        .filter(Boolean);
      // One-time cleanup of the accumulated test entries. Runs once per device,
      // then never again — so anything created afterwards is left alone.
      let cleanupV1 = raw.tplCleanupV1 === true;
      const ranCleanup = !cleanupV1;
      if (ranCleanup) {
        templates.forEach((t) => {
          if (!CLEANUP_V1_KEEP.includes(tplKey(t.name))) deletedTemplates[tplKey(t.name)] = true;
        });
        cleanupV1 = true;
      }
      templates = dropDeletedTemplates(templates, deletedTemplates);
      // Dedupe by name. mergeTemplates keys by name, so a blob written by an
      // older build (or a half-merged one) can carry the same event twice and
      // it would show as two identical chips.
      {
        const seen = new Set();
        templates = templates.filter((t) => {
          const k = tplKey(t.name);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      // Reseed AFTER the tombstone filter, or a deleted entry walks back in.
      if (!templates.length && !isTemplateDeleted(deletedTemplates, DEFAULT_TEMPLATES[0].name)) {
        templates = DEFAULT_TEMPLATES.map((t) => ({ ...t, policyKeys: t.policyKeys.slice() }));
      }
      // ensure seeded PBR exists if someone wiped it while keeping other names
      if (!templates.some((t) => /pbr|rodeo/i.test(t.name))
        && !isTemplateDeleted(deletedTemplates, DEFAULT_TEMPLATES[0].name)) {
        templates = [DEFAULT_TEMPLATES[0], ...templates];
      }
      const out = {
        deletedTemplates,
        tplCleanupV1: cleanupV1,
        emails: Array.isArray(raw.emails) ? raw.emails : ['thomasg@forevergoldai.com'],
        templates,
        archived: raw.archived && typeof raw.archived === 'object' ? raw.archived : {},
        deleted: raw.deleted && typeof raw.deleted === 'object' ? raw.deleted : {},
        eventPolicy: migrateEventPolicyMap(raw.eventPolicy),
        createdAt: raw.createdAt && typeof raw.createdAt === 'object' ? raw.createdAt : {},
        eventEdits: raw.eventEdits && typeof raw.eventEdits === 'object' ? raw.eventEdits : {},
        // Per-person admin flags. These gate UI only — the admin PIN is the
        // real lock — so they ride the shared meta blob and sync across
        // devices without needing a column the data table cannot grow.
        crewPerms: raw.crewPerms && typeof raw.crewPerms === 'object' ? raw.crewPerms : {},
        crewArchived: raw.crewArchived && typeof raw.crewArchived === 'object' ? raw.crewArchived : {},
        updatedAt: Number(raw.updatedAt) || 0,
      };
      // Persist the migration the moment it runs. Without this the flag never
      // reaches storage, the cleanup re-runs on EVERY load, and any event
      // created afterwards gets tombstoned on the next open — the cleanup would
      // quietly eat new work forever. Bump updatedAt so the tombstones win the
      // next cloud merge instead of losing to the server's older copy.
      if (ranCleanup) {
        out.updatedAt = Date.now();
        try { localStorage.setItem(META_KEY, JSON.stringify(out)); } catch { /* storage full — the in-memory copy still holds */ }
      }
      return out;
    } catch (err) {
      // A silent catch here hid a real bug: any throw inside loadMeta looked
      // exactly like "first run", quietly replacing every saved event with the
      // default. Say so.
      console.warn('[timeclock] loadMeta failed, falling back to defaults', err);
      return {
        emails: ['thomasg@forevergoldai.com'],
        templates: DEFAULT_TEMPLATES.map((t) => ({ ...t, policyKeys: t.policyKeys.slice() })),
        deletedTemplates: {},
        tplCleanupV1: true,
        archived: {},
        deleted: {},
        eventPolicy: {},
        createdAt: {},
        eventEdits: {},
        crewPerms: {},
        crewArchived: {},
        updatedAt: 0,
      };
    }
  }

  let meta = loadMeta();
  let cloudPushTimer = null;
  let cloudSyncing = false;
  let cloudPushPromise = null;
  let lastPushedAt = 0;
  let metaSyncReady = null;

  function isMetaEvent(ev) {
    return !!ev && String(ev.name || '').trim() === META_EVENT_NAME;
  }

  function encodeMetaBlob(snapshot) {
    const json = JSON.stringify(snapshot);
    return META_PREFIX + btoa(unescape(encodeURIComponent(json)));
  }

  function decodeMetaBlob(ownerEmail) {
    const s = String(ownerEmail || '');
    if (!s.startsWith(META_PREFIX)) return null;
    try {
      return JSON.parse(decodeURIComponent(escape(atob(s.slice(META_PREFIX.length)))));
    } catch {
      return null;
    }
  }

  function uniqEmails(list) {
    const seen = new Set();
    const out = [];
    (list || []).forEach((e) => {
      const n = normalizeEmail(e);
      if (!isEmail(n) || seen.has(n)) return;
      seen.add(n);
      out.push(n);
    });
    return out;
  }

  function mergeTemplates(localList, remoteList, tombstones) {
    const map = new Map();
    [...(remoteList || []), ...(localList || [])].forEach((t) => {
      const n = normalizeTemplate(t);
      if (!n) return;
      const key = n.name.toLowerCase();
      // A tombstone beats a surviving copy on either side. Without this the
      // remote blob resurrects everything the admin just deleted.
      if (isTemplateDeleted(tombstones, key)) return;
      const prev = map.get(key);
      if (!prev || (n.savedAt || 0) >= (prev.savedAt || 0)) map.set(key, n);
    });
    return [...map.values()]
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(0, 24);
  }

  function mergeEdits(localMap, remoteMap) {
    const out = { ...(remoteMap || {}) };
    Object.keys(localMap || {}).forEach((id) => {
      const loc = localMap[id];
      const rem = out[id];
      if (!rem) out[id] = loc;
      else if ((loc.updatedAt || 0) >= (rem.updatedAt || 0)) out[id] = { ...rem, ...loc };
    });
    return out;
  }

  function mergeBoolMaps(localMap, remoteMap, localAt, remoteAt) {
    // Same-key conflict: newer whole-meta timestamp wins; otherwise OR so neither device drops a hide.
    const out = { ...(remoteMap || {}) };
    Object.keys(localMap || {}).forEach((id) => {
      if (out[id] == null) out[id] = localMap[id];
      else if ((localAt || 0) >= (remoteAt || 0)) out[id] = localMap[id];
      else out[id] = !!(out[id] || localMap[id]);
    });
    return out;
  }

  function mergeMetaState(local, remote) {
    if (!remote || remote.v !== 1) return local;
    const localAt = Number(local.updatedAt) || 0;
    const remoteAt = Number(remote.updatedAt) || 0;
    const policy = (localAt >= remoteAt)
      ? { ...(remote.eventPolicy || {}), ...(local.eventPolicy || {}) }
      : { ...(local.eventPolicy || {}), ...(remote.eventPolicy || {}) };
    const created = { ...(remote.createdAt || {}), ...(local.createdAt || {}) };
    const mergedTplTombs = mergeBoolMaps(local.deletedTemplates, remote.deletedTemplates, localAt, remoteAt);
    return {
      emails: uniqEmails([...(remote.emails || []), ...(local.emails || [])]).slice(0, 20),
      // Tombstones merge FIRST so the template merge below can honour them.
      deletedTemplates: mergedTplTombs,
      tplCleanupV1: local.tplCleanupV1 === true || remote.tplCleanupV1 === true,
      templates: mergeTemplates(local.templates, remote.templates, mergedTplTombs),
      archived: mergeBoolMaps(local.archived, remote.archived, localAt, remoteAt),
      deleted: mergeBoolMaps(local.deleted, remote.deleted, localAt, remoteAt),
      eventPolicy: migrateEventPolicyMap(policy),
      createdAt: created,
      eventEdits: mergeEdits(local.eventEdits, remote.eventEdits),
      crewPerms: mergeBoolMaps(local.crewPerms, remote.crewPerms, localAt, remoteAt),
      crewArchived: mergeBoolMaps(local.crewArchived, remote.crewArchived, localAt, remoteAt),
      updatedAt: Math.max(localAt, remoteAt),
    };
  }

  function saveMeta(m, opts = {}) {
    const sync = opts.sync !== false;
    m.updatedAt = Date.now();
    localStorage.setItem(META_KEY, JSON.stringify(m));
    meta = m;
    if (sync) scheduleCloudMetaPush();
  }

  function scheduleCloudMetaPush() {
    clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(() => {
      pushCloudMeta().catch(() => {});
    }, 450);
  }

  async function listMetaEventRows() {
    const events = rows(await api('tc-events'));
    return events
      .filter(isMetaEvent)
      .map((ev) => ({ ev, blob: decodeMetaBlob(ev.owner_email) }))
      .filter((row) => row.blob && row.blob.v === 1)
      .sort((a, b) => (b.blob.updatedAt || 0) - (a.blob.updatedAt || 0));
  }

  async function pullAndMergeCloudMeta() {
    const rowsMeta = await listMetaEventRows();
    if (!rowsMeta.length) return false;
    const latest = rowsMeta[0];
    // Hide every sentinel row from Active/Archive UI on all devices
    rowsMeta.forEach(({ ev }) => {
      if (ev && ev.id != null) meta.deleted[String(ev.id)] = true;
    });
    meta = mergeMetaState(meta, latest.blob);
    localStorage.setItem(META_KEY, JSON.stringify(meta));
    return true;
  }

  async function pushCloudMeta() {
    if (!adminPinOk) return false;
    if (cloudPushPromise) {
      await cloudPushPromise;
      if ((Number(meta.updatedAt) || 0) > lastPushedAt) return pushCloudMeta();
      return true;
    }
    if ((Number(meta.updatedAt) || 0) <= lastPushedAt) return true;

    cloudSyncing = true;
    cloudPushPromise = (async () => {
      try {
        // Merge the newest shared copy immediately before writing. This keeps a
        // phone delete from being overwritten by a computer that was already open.
        try {
          const prior = await listMetaEventRows();
          if (prior[0]) meta = mergeMetaState(meta, prior[0].blob);
          prior.forEach(({ ev }) => {
            if (ev && ev.id != null) meta.deleted[String(ev.id)] = true;
          });
        } catch { /* still push the local pending change */ }

        const snapshot = {
          v: 1,
          updatedAt: meta.updatedAt || Date.now(),
          emails: meta.emails,
          templates: meta.templates,
          // Without these two in the snapshot the tombstone never leaves the
          // phone, and the next device to sync hands every deleted chip back.
          deletedTemplates: meta.deletedTemplates || {},
          tplCleanupV1: meta.tplCleanupV1 === true,
          archived: meta.archived,
          deleted: meta.deleted,
          eventPolicy: meta.eventPolicy,
          createdAt: meta.createdAt,
          eventEdits: meta.eventEdits,
          crewPerms: meta.crewPerms,
          crewArchived: meta.crewArchived,
        };
        if (snapshot.updatedAt <= lastPushedAt) return true;
        const owner = encodeMetaBlob(snapshot);
        if (owner.length > 100000) {
          console.warn('[timeclock] meta blob too large to sync');
          return false;
        }

        const created = await api('tc-events', {
          method: 'POST',
          body: JSON.stringify({
            pass: adminPinOk,
            name: META_EVENT_NAME,
            start_at: '2099-01-01T00:00:00-07:00',
            end_at: '2099-01-01T00:01:00-07:00',
            owner_email: owner,
          }),
        });
        const row = Array.isArray(created) ? created[0] : created;
        if (row && row.id != null) meta.deleted[String(row.id)] = true;
        lastPushedAt = snapshot.updatedAt;
        localStorage.setItem(META_KEY, JSON.stringify(meta));
        return true;
      } finally {
        cloudSyncing = false;
      }
    })();

    try {
      return await cloudPushPromise;
    } finally {
      cloudPushPromise = null;
      // A save/delete may have landed while the previous shared write was in flight.
      if ((Number(meta.updatedAt) || 0) > lastPushedAt) scheduleCloudMetaPush();
    }
  }

  async function flushCloudMeta() {
    clearTimeout(cloudPushTimer);
    cloudPushTimer = null;
    try {
      return await pushCloudMeta();
    } catch (err) {
      scheduleCloudMetaPush();
      throw err;
    }
  }

  async function ensureMetaSynced({ allowPush = true } = {}) {
    try {
      await pullAndMergeCloudMeta();
    } catch { /* offline / API — keep local cache */ }
    if (allowPush && adminPinOk) {
      try { await pushCloudMeta(); } catch { /* retry on next save */ }
    }
  }

  // Warm shared meta as soon as the app loads (read-only until admin unlocks)
  metaSyncReady = ensureMetaSynced({ allowPush: false });

  function rememberEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e || !e.includes('@')) return;
    meta.emails = [e, ...meta.emails.filter((x) => x.toLowerCase() !== e)].slice(0, 20);
    saveMeta(meta);
  }
  function markCreated(eventId) {
    if (eventId == null) return;
    meta.createdAt[String(eventId)] = Date.now();
    saveMeta(meta);
  }
  function createdRank(ev) {
    const stamped = meta.createdAt[String(ev.id)];
    if (stamped) return stamped;
    // fallback: start time so older events without a stamp sink below new ones
    const t = Date.parse(ev.start_at || '') || 0;
    return t;
  }
  function setEventPolicies(eventId, policyKeys) {
    if (!eventId) return;
    meta.eventPolicy[String(eventId)] = normalizePolicyKeys(policyKeys);
    saveMeta(meta);
  }
  function saveEventEdit(eventId, patch) {
    if (eventId == null) return;
    const id = String(eventId);
    meta.eventEdits[id] = { ...(meta.eventEdits[id] || {}), ...patch, updatedAt: Date.now() };
    saveMeta(meta);
  }
  function applyEventEdit(ev) {
    if (!ev || ev.id == null) return ev;
    const ed = meta.eventEdits[String(ev.id)];
    if (!ed) return ev;
    return {
      ...ev,
      name: ed.name != null ? ed.name : ev.name,
      start_at: ed.start_at != null ? ed.start_at : ev.start_at,
      end_at: ed.end_at != null ? ed.end_at : ev.end_at,
      owner_email: ed.owner_email != null ? ed.owner_email : ev.owner_email,
    };
  }
  function rememberTemplate(name, extras = {}) {
    const n = String(name || '').trim();
    if (!n) return;
    const keys = normalizePolicyKeys(extras.policyKeys);
    const payload = {
      id: `tpl-${Date.now()}`,
      name: n,
      policyKeys: keys,
      startHour: Number.isFinite(extras.startHour) ? extras.startHour : 10,
      startMin: Number.isFinite(extras.startMin) ? extras.startMin : 0,
      endHour: Number.isFinite(extras.endHour) ? extras.endHour : 22,
      endMin: Number.isFinite(extras.endMin) ? extras.endMin : 0,
      emails: Array.isArray(extras.emails) ? extras.emails.map(normalizeEmail).filter(isEmail) : [],
      duration: ['today', 'tomorrow', 'weekend', 'week', 'custom'].includes(extras.duration) ? extras.duration : 'custom',
      savedAt: Date.now(),
    };
    // Creating this event again is a deliberate undo of any earlier delete.
    if (meta.deletedTemplates) delete meta.deletedTemplates[tplKey(n)];
    const existing = meta.templates.find((t) => t.name.toLowerCase() === n.toLowerCase());
    if (existing) {
      existing.name = n;
      existing.policyKeys = payload.policyKeys;
      existing.startHour = payload.startHour;
      existing.startMin = payload.startMin;
      existing.endHour = payload.endHour;
      existing.endMin = payload.endMin;
      existing.emails = payload.emails;
      existing.duration = payload.duration;
      existing.savedAt = payload.savedAt;
      // bump to front of Choose Event
      meta.templates = [existing, ...meta.templates.filter((t) => t.id !== existing.id)];
    } else {
      meta.templates = [payload, ...meta.templates].slice(0, 24);
    }
    saveMeta(meta);
  }

  /** Pull event names from the live list into Choose Event chips (covers typed creates that need to stick). */
  function syncTemplatesFromEvents(events) {
    let changed = false;
    (events || []).forEach((ev) => {
      if (!ev || isMetaEvent(ev) || isDeleted(ev.id) || !ev.name) return;
      const n = String(ev.name).trim();
      if (!n) return;
      // The second resurrection path: this backfills a chip from every live
      // event row, so a deleted chip whose event still exists came back on the
      // next admin load. A tombstone stops that too.
      if (isTemplateDeleted(meta.deletedTemplates, n)) return;
      const already = meta.templates.find((t) => t.name.toLowerCase() === n.toLowerCase());
      if (already) return;
      const keys = normalizePolicyKeys(meta.eventPolicy[String(ev.id)]);
      meta.templates.unshift({
        id: `tpl-sync-${ev.id}`,
        name: n,
        policyKeys: keys,
        startHour: 10,
        startMin: 0,
        endHour: 22,
        endMin: 0,
        emails: String(ev.owner_email || '')
          .split(/[,;]+/)
          .map(normalizeEmail)
          .filter(isEmail),
        duration: 'custom',
        savedAt: Date.parse(ev.start_at || '') || Date.now(),
      });
      changed = true;
    });
    if (changed) {
      meta.templates = meta.templates.slice(0, 24);
      saveMeta(meta);
    }
  }
  function policiesForEvent(ev) {
    const id = String(ev && ev.id != null ? ev.id : '');
    const fromEdit = meta.eventEdits && meta.eventEdits[id] && meta.eventEdits[id].policyKeys;
    if (Array.isArray(fromEdit) && fromEdit.length) {
      return normalizePolicyKeys(fromEdit).map((k) => POLICY_PACKS[k]).filter(Boolean);
    }
    const stored = meta.eventPolicy[id];
    if (stored && stored.length) return stored.map((k) => POLICY_PACKS[k]).filter(Boolean);
    const tpl = meta.templates.find((t) => t.name.toLowerCase() === String(ev.name || '').toLowerCase());
    if (tpl && tpl.policyKeys.length) return tpl.policyKeys.map((k) => POLICY_PACKS[k]).filter(Boolean);
    if (/\bpbr\b|rodeo/i.test(ev.name || '')) return [POLICY_PACKS.general, POLICY_PACKS.pbr];
    return [];
  }
  function isArchived(id) { return !!meta.archived[String(id)]; }
  function isDeleted(id) { return !!meta.deleted[String(id)]; }
  function archiveEvent(id) {
    meta.archived[String(id)] = true;
    delete meta.deleted[String(id)];
    saveMeta(meta);
  }
  function restoreEvent(id) {
    delete meta.archived[String(id)];
    saveMeta(meta);
  }
  function deleteEvent(id) {
    meta.deleted[String(id)] = true;
    delete meta.archived[String(id)];
    saveMeta(meta);
  }

  async function deleteEventEverywhere(id) {
    deleteEvent(id);
    try {
      return await flushCloudMeta();
    } catch {
      return false;
    }
  }

  function renderPolicyHtml(packs) {
    const list = Array.isArray(packs) ? packs : (packs ? [packs] : []);
    if (!list.length) return '<p class="muted">No policies attached to this event yet.</p>';
    return list.map((pack) => {
      const full = (pack.sections || []).map((s) => `<h5>${esc(s.h)}</h5>${esc(s.body)}`).join('');
      return `<div class="policy-block">
        <h4>${esc(pack.title)}</h4>
        <ul>${(pack.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
        ${full ? `<details><summary>FULL POLICY — READ WORD FOR WORD</summary><div class="policy-full">${full}</div></details>` : ''}
      </div>`;
    }).join('');
  }

  /* ============================================================
     ADMIN
     ============================================================ */
  let adminPin = '';
  let adminPinOk = null;
  let eventTab = 'active';
  let calCursor = new Date();
  let rangeStart = null; // YYYY-MM-DD
  let rangeEnd = null;
  let selectedTemplateId = null;

  function openAdmin() {
    show('admin');
    if (adminPinOk) { $('adminGate').classList.add('hidden'); $('adminDash').classList.remove('hidden'); loadAdmin(); loadWeekView({ force: true }); startAdminPoll(); return; }
    adminPin = '';
    paintPin();
    $('adminGate').classList.remove('hidden');
    $('adminDash').classList.add('hidden');
  }

  function paintPin() {
    [...$('pinDots').children].forEach((dot, i) => dot.classList.toggle('on', i < adminPin.length));
  }

  $('pinPad').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.k === 'del') { adminPin = adminPin.slice(0, -1); paintPin(); return; }
    if (adminPin.length >= 4) return;
    adminPin += b.textContent.trim();
    paintPin();
    $('pinErr').classList.add('hidden');
    if (adminPin.length === 4) {
      try {
        await api(`tc-admin?pass=${encodeURIComponent(adminPin)}&date=${localDate()}`);
        adminPinOk = adminPin;
        $('adminGate').classList.add('hidden');
        $('adminDash').classList.remove('hidden');
        $('adminDate').value = localDate();
        $('adminMenuBtn').classList.remove('hidden');
        toast('Syncing admin state across devices…', false, 2200);
        await ensureMetaSynced({ allowPush: true });
        // Warm the dashboard so the ⚙ ADMIN button opens instantly, but LAND on
        // the waiting room — approving the people in front of you is the job.
        loadAdmin();
        loadWeekView({ force: true });
        show('home');
        lastWaitSig = '';
        loadWaiting();
        startWaitPoll();
      } catch {
        $('pinErr').classList.remove('hidden');
        $('pinDots').classList.add('shake');
        setTimeout(() => $('pinDots').classList.remove('shake'), 400);
        adminPin = '';
        setTimeout(paintPin, 350);
      }
    }
  });

  let lastPunchesSig = '';
  let lastCrewSig = '';
  async function loadAdmin(opts = {}) {
    const silent = opts.silent === true;
    if (!$('adminDate').value) $('adminDate').value = localDate();
    const date = $('adminDate').value;
    const tbody = $('adminRows');
    if (!silent) tbody.innerHTML = `<tr><td colspan="10" class="muted center">${spinnerHtml()}Loading…</td></tr>`;
    try {
      const punches = rows(await api(`tc-admin?pass=${encodeURIComponent(adminPinOk)}&date=${encodeURIComponent(date)}`))
        .sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));
      const sig = punches.map((p) => [p.id, p.status, p.clock_out, p.break_end].join('~')).join('|');
      if (!silent || sig !== lastPunchesSig) {
        tbody.innerHTML = !punches.length
          ? '<tr><td colspan="10" class="muted center">No punches for this day.</td></tr>'
          : punches.map((p) => {
            const h = shiftHours(p);
            // Clock-in photos used to be Google Drive links, private to the
            // Drive owner. Photos taken since the move live on the backend and
            // are just as private — they need the admin pass. Older Drive links
            // are left exactly as they were stored.
            const photo = (url, label) => {
              if (!url) return '·';
              const href = String(url).startsWith(API)
                ? `${url}?pass=${encodeURIComponent(adminPinOk)}`
                : url;
              return `<a href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;
            };
            return `<tr>
              <td>${esc(p.profile_name)}</td>
              <td>${esc(p.event_name || '')}</td>
              <td>${fmtTime(p.clock_in)}</td>
              <td>${fmtTime(p.break_start)}</td>
              <td>${fmtTime(p.break_end)}</td>
              <td>${p.break_taken ? '☑' : '☐'}</td>
              <td>${p.status === 'out' ? fmtTime(p.clock_out) : '<b style="color:var(--in-green)">on clock</b>'}</td>
              <td>${h != null ? h.toFixed(2) : '—'}</td>
              <td>${photo(p.photo_selfie, 'SELFIE')}</td>
              <td><button type="button" class="row-del" data-del="${esc(String(p.id))}"
                    data-who="${esc(p.profile_name || 'this shift')}" title="Delete this punch">✕</button></td>
            </tr>`;
          }).join('');
      }
      lastPunchesSig = sig;
    } catch {
      if (!silent) tbody.innerHTML = '<tr><td colspan="10" class="form-err center">Couldn\'t load the sheet.</td></tr>';
    }
    loadCrew(opts);
    loadAdminEvents(opts);
  }

  /* ============================================================
     CREW — who the owner has cleared for their own weekly sheet
     ============================================================ */
  async function loadCrew(opts = {}) {
    const box = $('adminCrew');
    if (!box) return;
    const silent = opts.silent === true;
    if (!silent && !box.children.length) box.innerHTML = `<p class="muted center">${spinnerHtml()}Loading crew…</p>`;
    let crew;
    try {
      crew = rows(await api('tc-profiles'));
    } catch {
      if (!silent) box.innerHTML = '<p class="form-err center">Couldn\'t load the crew.</p>';
      return;
    }
    // Archive and event-permission live on the SERVER now (tc_crew_flags), not
    // in the device meta blob — the Tuesday email builder has to be able to see
    // them, and it cannot read the blob. Archiving therefore really does stop
    // someone's email, and restoring really does turn it back on.
    let flagRows = [];
    try { flagRows = rows(await api('tc-crew-flags')); } catch { /* fall back to no flags */ }
    const flagFor = (id) => flagRows.find((f) => String(f.profile_id) === String(id)) || {};
    crew.sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`));
    const sig = crew.map((p) => `${p.id}~${p.first_name}~${p.last_name}~${p.email}~${flagFor(p.id).can_create_events === true}~${flagFor(p.id).archived === true}`).join('|');
    if (silent && sig === lastCrewSig) return;
    lastCrewSig = sig;

    box.innerHTML = '';
    if (!crew.length) {
      box.innerHTML = '<p class="muted center">No profiles yet.</p>';
    }
    // One place that paints a crew row's open/closed state: the menu itself,
    // the trigger's label and arrow, and the `menu-open` class that lifts the
    // whole block in front of its neighbours.
    const paintCrewMenu = (btn, box2, open) => {
      box2.classList.toggle('hidden', !open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? 'ACTIONS \u25b4' : 'ACTIONS \u25be';
      if (box2.parentElement) box2.parentElement.classList.toggle('menu-open', open);
    };
    crew.forEach((p) => {
      const flag = flagFor(p.id);
      const canMakeEvents = flag.can_create_events === true;
      const archived = flag.archived === true;
      const saveFlags = async (next) => {
        await api('tc-profile-admin', {
          method: 'POST',
          body: JSON.stringify({
            pass: adminPinOk,
            action: 'flags',
            profile_id: p.id,
            archived: next.archived,
            can_create_events: next.can_create_events,
          }),
        });
        lastCrewSig = '';
        loadCrew();
      };
      const row = document.createElement('div');
      row.className = `crew-item${archived ? ' is-archived' : ''}`;
      row.innerHTML = `
        <span class="crew-who">
          <span class="crew-name">${esc(p.first_name)} ${esc(p.last_name)}${archived ? ' <em>(archived)</em>' : ''}</span>
          <span class="crew-mail">${esc(p.email || 'no email on file')}</span>
        </span>`;

      // One menu per person instead of a single toggle: clock in, clock out,
      // edit their details, grant event creation, archive, delete.
      const menuWrap = document.createElement('div');
      menuWrap.className = 'crew-menu-wrap';
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'crew-toggle';
      trigger.textContent = 'ACTIONS ▾';
      trigger.setAttribute('aria-expanded', 'false');
      const menu = document.createElement('div');
      menu.className = 'crew-menu hidden';
      trigger.onclick = () => {
        const open = menu.classList.contains('hidden');
        // Close any other person's menu first so only one is ever open, and
        // reset that person's trigger with it.
        document.querySelectorAll('.crew-menu').forEach((m) => {
          if (m === menu) return;
          const other = m.parentElement && m.parentElement.querySelector('.crew-toggle');
          if (other) paintCrewMenu(other, m, false);
          else m.classList.add('hidden');
        });
        paintCrewMenu(trigger, menu, open);
        // The row can sit at the bottom of a phone screen, which would open the
        // menu off-screen. Bring the whole thing into view.
        if (open) requestAnimationFrame(() => menu.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      };

      const item = (label, fn, cls = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `crew-menu-item ${cls}`;
        b.textContent = label;
        b.onclick = async () => { paintCrewMenu(trigger, menu, false); await fn(); };
        return b;
      };

      const openPunch = async () => {
        const hist = rows(await api(`tc-history?profileId=${encodeURIComponent(p.id)}`));
        return hist.find((x) => x.status === 'in' || x.status === 'break') || null;
      };

      menu.append(
        item('⏱ Clock in', async () => {
          const open = await openPunch().catch(() => null);
          if (open) { toast(`${p.first_name} is already on the clock.`, true); return; }
          const job = window.prompt(`What job is ${p.first_name} clocking in for?`, '');
          if (!job || !job.trim()) return;
          try {
            await api('tc-punch', {
              method: 'POST',
              body: JSON.stringify({
                action: 'clock_in',
                profile_id: p.id,
                profile_name: `${p.first_name} ${p.last_name}`,
                event_id: `job-${job.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                event_name: job.trim(),
                work_date: localDate(),
                clock_in: localISO(),
                photos: {},
                policies_acked: [],
              }),
            });
            toast(`${p.first_name} clocked in.`);
            lastPunchesSig = '';
            loadAdmin();
          } catch { toast('Couldn\'t clock them in — try again.', true); }
        }),
        item('⏹ Clock out', async () => {
          let open;
          try { open = await openPunch(); } catch { toast('Couldn\'t reach the clock.', true); return; }
          if (!open) { toast(`${p.first_name} isn't clocked in.`, true); return; }
          try {
            await api('tc-punch', {
              method: 'POST',
              body: JSON.stringify({ action: 'clock_out', punch_id: open.id, time: localISO() }),
            });
            toast(`${p.first_name} clocked out.`);
            lastPunchesSig = '';
            loadAdmin();
          } catch { toast('Couldn\'t clock them out — try again.', true); }
        }),
        item('✎ Edit profile', async () => {
          const first = window.prompt('First name', p.first_name || '');
          if (first === null) return;
          const last = window.prompt('Last name', p.last_name || '');
          if (last === null) return;
          const email = window.prompt('Email address', p.email || '');
          if (email === null) return;
          if (!first.trim() || !last.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
            toast('First name, last name and a valid email are all required.', true);
            return;
          }
          try {
            await api('tc-profile-admin', {
              method: 'POST',
              body: JSON.stringify({
                pass: adminPinOk, action: 'update', profile_id: p.id,
                first_name: first.trim(), last_name: last.trim(), email: email.trim(),
              }),
            });
            toast('Profile updated.');
            lastCrewSig = '';
            loadCrew();
          } catch { toast('Couldn\'t save that profile — try again.', true); }
        }),
        item(canMakeEvents ? '★ Can create events — ON' : '☆ Can create events — OFF', async () => {
          try {
            await saveFlags({ archived, can_create_events: !canMakeEvents });
            toast(!canMakeEvents
              ? `${p.first_name} can create events.`
              : `${p.first_name} can no longer create events.`);
          } catch { toast('Couldn\'t save that — try again.', true); }
        }),
        item(archived ? '↩ Restore' : '📦 Archive', async () => {
          try {
            await saveFlags({ archived: !archived, can_create_events: canMakeEvents });
            toast(!archived
              ? `${p.first_name} archived — they stop getting the Tuesday email.`
              : `${p.first_name} restored — their Tuesday email starts again.`);
          } catch { toast('Couldn\'t save that — try again.', true); }
        }),
        item('✕ Delete person', async () => {
          const yes = await confirmAsk(`Delete ${p.first_name} ${p.last_name}?`,
            'Their profile is removed for good. Shifts already recorded stay on the day sheet unless you delete those too.');
          if (!yes) return;
          try {
            await api('tc-profile-admin', {
              method: 'POST',
              body: JSON.stringify({ pass: adminPinOk, action: 'delete', profile_id: p.id }),
            });
            toast(`${p.first_name} deleted.`);
            lastCrewSig = '';
            loadCrew();
          } catch { toast('Couldn\'t delete that profile — try again.', true); }
        }, 'danger'),
      );

      menuWrap.append(trigger);
      row.appendChild(menuWrap);

      // Swipe left to archive, right to delete — the same gesture the event
      // rows use, wired to the same functions the menu items call so the two
      // can never disagree.
      const swipe = document.createElement('div');
      swipe.className = 'event-swipe crew-swipe';
      swipe.innerHTML = '<div class="event-swipe-bg"><span class="arch">' + (archived ? 'RESTORE' : 'ARCHIVE') + '</span><span class="del">DELETE</span></div>';
      swipe.appendChild(row);
      // The menu is a SIBLING of the row, not a child of it, and it is in
      // normal flow. Inside the row it was an absolute overlay that
      // `.crew-swipe { overflow: hidden }` sliced off at the row's bottom edge,
      // so most of the actions were invisible. Here it makes its own room and
      // pushes the rest of the crew list down. It also sits outside the swipe
      // listeners (which are bound to the row), so tapping an action can never
      // be read as a swipe.
      swipe.appendChild(menu);
      attachSwipe(swipe, row, {
        left: async () => {
          try {
            await saveFlags({ archived: !archived, can_create_events: canMakeEvents });
            toast(!archived
              ? `${p.first_name} archived — they stop getting the Tuesday email.`
              : `${p.first_name} restored — their Tuesday email starts again.`);
          } catch { row.style.transform = ''; toast('Couldn\'t save that — try again.', true); }
        },
        right: async () => {
          const yes = await confirmAsk(`Delete ${p.first_name} ${p.last_name}?`,
            'Their profile is removed for good. Archive instead if they are only away for a while — that stops the email but keeps them.');
          if (!yes) { row.style.transform = ''; return; }
          try {
            await api('tc-profile-admin', {
              method: 'POST',
              body: JSON.stringify({ pass: adminPinOk, action: 'delete', profile_id: p.id }),
            });
            toast(`${p.first_name} deleted.`);
            lastCrewSig = '';
            loadCrew();
          } catch { row.style.transform = ''; toast('Couldn\'t delete that profile — try again.', true); }
        },
      });
      box.appendChild(swipe);
    });
    loadOwnerEmails();
  }

  // The admin addresses held on the server (Thomas + Josh). Every event report
  // goes to these whoever created the event, so nobody has to remember to add
  // them and no event can be created that the owners don't hear about.
  let adminReportEmails = [];
  const dedupeEmails = (list) => {
    const seen = new Set();
    return list.filter((a) => {
      const k = String(a || '').trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  /**
   * Renders what the SERVER actually holds, underneath the box — so a saved
   * address is visible proof, not just text still sitting in the field. This
   * is the difference between "I typed it" and "it saved".
   */
  function paintSavedOwners(value, when) {
    const box = $('ownerEmailsSaved');
    if (!box) return;
    const list = String(value || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) {
      box.innerHTML = '<p class="field-note form-err">Nobody is set to receive the full crew sheet. Add an address above and hit SAVE.</p>';
      return;
    }
    box.innerHTML = `<p class="field-note muted">Saved on the server${when ? ` — ${when}` : ''}. These get the full crew sheet every Tuesday. Tap one to put it back in the box:</p>`
      + `<div class="saved-chips">${list.map((a) => `<button type="button" class="saved-chip" data-mail="${esc(a)}">${esc(a)}</button>`).join('')}</div>`;
    // Tapping a saved address puts it back in the field. After an accidental
    // wipe the server's copy is the only place the list still exists, so it has
    // to be recoverable by thumb, not by retyping it from memory.
    box.querySelectorAll('.saved-chip').forEach((chip) => {
      chip.onclick = () => {
        const input = $('ownerEmails');
        const have = input.value.split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
        const mail = chip.dataset.mail;
        if (have.includes(mail.toLowerCase())) { toast(`${mail} is already in the box.`); return; }
        input.value = input.value.trim() ? `${input.value.trim().replace(/,\s*$/, '')}, ${mail}` : mail;
        toast(`${mail} added — hit SAVE to keep it.`);
      };
    });
  }

  // The last list the server confirmed, kept so an accidental empty SAVE can be
  // caught before it wipes a real one.
  let lastSavedOwnerEmails = '';

  async function loadOwnerEmails() {
    const input = $('ownerEmails');
    // No one-shot guard: this used to load once per page and never refresh, so
    // the field could show a stale value all session. Only skip while the
    // admin is actually typing in it.
    if (!input || document.activeElement === input) return;
    try {
      const found = rows(await api(`tc-settings?pass=${encodeURIComponent(adminPinOk)}`))
        .find((s) => s.setting_key === 'owner_emails');
      const value = (found && found.setting_value) || '';
      input.value = value;
      adminReportEmails = dedupeEmails(value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean));
      lastSavedOwnerEmails = value;
      paintSavedOwners(value, found && found.updated_at ? fmtDate(String(found.updated_at).slice(0, 10)) : '');
    } catch { /* leave whatever is typed */ }
  }

  $('ownerEmailsSave').onclick = async () => {
    const btn = $('ownerEmailsSave');
    const value = $('ownerEmails').value.trim();
    // Validate EVERY address, not the whole string at once. The old check let
    // "you@x.com, josh" through, because one greedy match across the commas
    // satisfied it.
    const list = value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
    if (bad.length) {
      toast(`Not a valid email address: ${bad.join(', ')}`, true);
      return;
    }
    // An empty box used to save straight through and silently wipe the list —
    // which is exactly how the owners' addresses got cleared. Emptying it stops
    // the Tuesday crew sheet reaching anybody, so it now takes a deliberate yes.
    if (!list.length) {
      const had = lastSavedOwnerEmails.split(/[,;\s]+/).map((a) => a.trim()).filter(Boolean);
      if (had.length) {
        const yes = await confirmAsk('Remove every owner address?',
          `The box is empty. Saving it removes ${had.join(', ')} and NOBODY receives the Tuesday crew sheet. Tap an address below to put it back instead.`);
        if (!yes) return;
      } else {
        toast('Nothing to save — add an address first.', true);
        return;
      }
    }
    btn.disabled = true;
    btn.textContent = 'SAVING…';
    try {
      await api('tc-settings', {
        method: 'POST',
        body: JSON.stringify({ pass: adminPinOk, key: 'owner_emails', value: list.join(', ') }),
      });
      // Read it back from the server rather than trusting the POST. Until the
      // server says so, nothing is saved — this is what makes a save provable
      // instead of "the text is still in the box".
      const found = rows(await api(`tc-settings?pass=${encodeURIComponent(adminPinOk)}`))
        .find((s) => s.setting_key === 'owner_emails');
      const confirmed = (found && found.setting_value) || '';
      $('ownerEmails').value = confirmed;
      adminReportEmails = dedupeEmails(confirmed.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean));
      lastSavedOwnerEmails = confirmed;
      paintSavedOwners(confirmed, 'just now');
      toast(confirmed === list.join(', ')
        ? `Saved — ${list.length} admin address${list.length === 1 ? '' : 'es'} on file.`
        : 'Saved, but the server came back different — check the list below.', confirmed !== list.join(', '));
    } catch {
      // Repaint what the server last confirmed, not a blank. Painting '' here
      // told the admin nobody was on file when in fact the old list was intact.
      paintSavedOwners(lastSavedOwnerEmails, '');
      toast('NOT saved — the server didn\'t take it. Your saved list below is unchanged.', true);
    }
    btn.disabled = false;
    btn.textContent = 'SAVE';
  };

  $('sendSheetNow').onclick = async () => {
    const btn = $('sendSheetNow');
    const note = $('sendSheetNote');
    btn.disabled = true;
    btn.textContent = 'SENDING…';
    try {
      const r = await api('tc-timesheet', {
        method: 'POST',
        body: JSON.stringify({ pass: adminPinOk }),
      });
      if (r.sent) {
        // photos_attached only comes back from the worker backend; n8n links
        // the photos instead of attaching them, so don't claim a count it
        // didn't report.
        const photos = typeof r.photos_attached === 'number'
          ? `, ${r.photos_attached} photo${r.photos_attached === 1 ? '' : 's'}`
          : '';
        const to = Array.isArray(r.to) ? r.to.length : 0;
        note.textContent = `Sent — ${r.shifts} shift${r.shifts === 1 ? '' : 's'}, ${r.total_hours} hours${photos}, `
          + `to ${to} address${to === 1 ? '' : 'es'}.`;
        toast('Time sheet emailed.');
      } else {
        // Never claim it went out when it did not — say exactly what stopped it.
        // `blocked` is the deliberate one-send-per-day guard, not a failure,
        // so it shouldn't read like something broke.
        note.textContent = r.error === 'mail_not_configured'
          ? 'Email is not set up on the backend yet (RESEND_API_KEY / MAIL_FROM). Nothing was sent.'
          : `${r.blocked ? '' : 'Not sent — '}${r.error || 'unknown error'}`;
        toast(r.blocked ? 'Already sent today — one per day.' : 'Time sheet was NOT sent.', !r.blocked);
      }
    } catch {
      note.textContent = 'Couldn\'t reach the backend. Nothing was sent.';
      toast('Time sheet was NOT sent.', true);
    }
    btn.disabled = false;
    btn.textContent = 'EMAIL THIS WEEK\'S SHEET NOW';
  };

  // Bound ONCE, on the tbody — loadAdmin replaces its innerHTML every 20
  // seconds, so binding per render would stack listeners and delete twice on
  // one tap.
  $('adminRows').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn || btn.disabled) return;
    const who = btn.dataset.who || 'this shift';
    if (!window.confirm(`Delete ${who}'s punch?\n\nThe shift is removed for good and stops counting toward the time sheet.`)) return;
    btn.disabled = true;
    try {
      await api('tc-punch-delete', {
        method: 'POST',
        body: JSON.stringify({ pass: adminPinOk, punch_id: Number(btn.dataset.del) }),
      });
      lastPunchesSig = ''; // force a repaint even though the poll is silent
      toast('Punch deleted.');
      loadAdmin();
    } catch {
      btn.disabled = false;
      toast('Couldn\'t delete that punch — try again.', true);
    }
  });

  $('eventTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    eventTab = tab.dataset.tab;
    [...$('eventTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.tab === eventTab));
    loadAdminEvents();
  });

  let durationKind = 'today';

  let lastEventsSig = '';
  async function loadAdminEvents(opts = {}) {
    const silent = opts.silent === true;
    const box = $('adminEvents');
    if (!silent) box.innerHTML = `<p class="muted center">${spinnerHtml()}Loading…</p>`;
    try {
      await ensureMetaSynced({ allowPush: !!adminPinOk });
      const events = rows(await api('tc-events'))
        .filter((ev) => !isMetaEvent(ev) && !isDeleted(ev.id))
        .map(applyEventEdit);
      syncTemplatesFromEvents(events);
      const shown = events
        .filter((ev) => eventTab === 'archived' ? isArchived(ev.id) : !isArchived(ev.id))
        .sort((a, b) => createdRank(b) - createdRank(a)); // newest created at top
      const sig = `${eventTab}::${shown.map((ev) => [ev.id, ev.name, ev.start_at, ev.end_at, ev.report_sent].join('~')).join('|')}`;
      if (!silent || sig !== lastEventsSig) {
        box.innerHTML = shown.length ? '' : `<p class="muted center">${eventTab === 'archived' ? 'Archive is empty.' : 'No active events — create one.'}</p>`;
        shown.forEach((ev) => box.appendChild(buildEventRow(ev)));
      }
      lastEventsSig = sig;
    } catch {
      if (!silent) box.innerHTML = '<p class="form-err center">Couldn\'t load events.</p>';
    }
  }

  // Event ids marked for deletion but not yet committed to the server.
  const pendingEventDeletes = new Set();

  function paintPendingEvents() {
    const note = $('eventsPending');
    // Two buttons, one at the top of EVENTS and one under the list, because the
    // list is long enough on a phone that the top one scrolls out of reach.
    const btns = eventsSaveButtons();
    if (!note || !btns.length) return;
    const n = pendingEventDeletes.size;
    note.classList.toggle('hidden', n === 0);
    note.textContent = n ? `${n} event${n === 1 ? '' : 's'} marked to delete. Hit SAVE to remove ${n === 1 ? 'it' : 'them'} from the server for good.` : '';
    btns.forEach((btn) => {
      btn.classList.toggle('primary', n > 0);
      btn.textContent = n ? `SAVE (${n})` : 'SAVE';
    });
  }

  function eventsSaveButtons() {
    return [$('eventsSave'), $('eventsSaveBottom')].filter(Boolean);
  }

  async function commitEventDeletes() {
    const btns = eventsSaveButtons();
    if (!pendingEventDeletes.size) { toast('Nothing to save — no events are marked.'); return; }
    const ids = [...pendingEventDeletes];
    btns.forEach((b) => { b.disabled = true; b.textContent = 'SAVING…'; });
    let done = 0;
    const stuck = [];
    for (const id of ids) {
      try {
        await api('tc-event-delete', {
          method: 'POST',
          body: JSON.stringify({ pass: adminPinOk, event_id: Number(id) }),
        });
        pendingEventDeletes.delete(id);
        done += 1;
      } catch {
        stuck.push(id);
      }
    }
    btns.forEach((b) => { b.disabled = false; });
    paintPendingEvents();
    lastEventsSig = '';
    loadAdminEvents();
    toast(stuck.length
      ? `Deleted ${done}. ${stuck.length} wouldn't go — still marked, try SAVE again.`
      : `Deleted ${done} event${done === 1 ? '' : 's'} from the server.`, stuck.length > 0);
  }

  eventsSaveButtons().forEach((b) => { b.onclick = commitEventDeletes; });

  /* ============================================================
     WEEK BY WEEK — read everyone's hours in the app, no email needed.
     Weeks are named by their date range (Thomas, 2026-08-25), and the pay
     week runs Wednesday → Tuesday to match the sheet that gets emailed.
     ============================================================ */

  // All punches are fetched ONCE and paged through in the browser. Executions
  // are billed, so a week view must not cost seven calls to walk seven days.
  let weekPunches = null;
  let weekOffset = 0; // 0 = the week we are in now, -1 = the week before it

  function weekRange(offset = 0) {
    const now = new Date();
    const dow = now.getDay();                    // 0 Sun … 6 Sat
    const toTuesday = (2 - dow + 7) % 7;         // forward to this week's Tuesday
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + toTuesday + offset * 7);
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
    return { start: localDate(start), end: localDate(end) };
  }

  const weekTitle = (r) => {
    const f = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${f(r.start)} – ${f(r.end)}, ${r.end.slice(0, 4)}`;
  };

  async function loadWeekView(opts = {}) {
    const body = $('weekBody');
    const range = weekRange(weekOffset);
    $('weekLabel').textContent = weekTitle(range);
    if (!weekPunches || opts.force) {
      body.innerHTML = `<p class="muted center">${spinnerHtml()}Loading…</p>`;
      try {
        weekPunches = rows(await api(`tc-punches-all?pass=${encodeURIComponent(adminPinOk)}`));
      } catch {
        body.innerHTML = '<p class="form-err center">Couldn\'t load the record.</p>';
        return;
      }
    }

    const mine = weekPunches
      .filter((p) => String(p.work_date || '') >= range.start && String(p.work_date || '') <= range.end)
      .sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));

    if (!mine.length) {
      body.innerHTML = '<p class="muted center">Nobody clocked in this week.</p>';
      return;
    }

    const byWho = {};
    mine.forEach((p) => { (byWho[p.profile_name || '—'] = byWho[p.profile_name || '—'] || []).push(p); });

    let grand = 0;
    body.innerHTML = Object.keys(byWho).sort().map((who) => {
      const shifts = byWho[who];
      const total = shifts.reduce((sum, p) => sum + (shiftHours(p) || 0), 0);
      grand += total;
      return `<div class="week-person">
        <div class="week-person-head"><span>${esc(who)}</span><span class="week-person-hours">${total.toFixed(2)} h</span></div>
        ${shifts.map((p) => {
          const h = shiftHours(p);
          return `<div class="week-shift${h == null ? ' open' : ''}">
            <span>${fmtDate(p.work_date)} · ${esc(p.event_name || '')}</span>
            <span>${fmtTime(p.clock_in)} → ${p.clock_out ? fmtTime(p.clock_out) : 'still on the clock'} · ${h == null ? '—' : h.toFixed(2) + ' h'}</span>
          </div>`;
        }).join('')}
      </div>`;
    }).join('') + `<div class="week-total"><span>TOTAL</span><span>${grand.toFixed(2)} h</span></div>`;
  }

  $('weekPrev').onclick = () => { weekOffset -= 1; loadWeekView(); };
  $('weekNext').onclick = () => { if (weekOffset < 0) { weekOffset += 1; loadWeekView(); } };
  $('weekReload').onclick = () => loadWeekView({ force: true });

  function buildEventRow(ev) {
    const ended = ev.end_at && new Date(ev.end_at) <= new Date();
    const staged = pendingEventDeletes.has(String(ev.id));
    const badge = staged
      ? '<span class="badge willdel">WILL DELETE</span>'
      : isArchived(ev.id)
      ? '<span class="badge arch">ARCHIVED</span>'
      : ev.report_sent
        ? '<span class="badge sent">SHEET SENT</span>'
        : ended ? '<span class="badge done">ENDED</span>' : '<span class="badge live">LIVE</span>';
    const wrap = document.createElement('div');
    wrap.className = 'event-swipe';
    wrap.innerHTML = `<div class="event-swipe-bg"><span class="arch">ARCHIVE</span><span class="del">DELETE</span></div>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `event-item${staged ? ' pending-del' : ''}`;
    btn.innerHTML = `<span><span class="ev-name">${esc(ev.name)}</span><br>
      <span class="ev-times">${new Date(ev.start_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      → ${new Date(ev.end_at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      · ${esc(ev.owner_email || '')}</span></span>${badge}`;
    btn.onclick = () => openEventDetail(ev);
    wrap.appendChild(btn);

    // The same two actions the swipe performs, as named functions, so the
    // visible buttons below and the swipe gesture can never drift apart.
    const doArchive = async () => {
      if (isArchived(ev.id)) {
        restoreEvent(ev.id);
        toast('Restored to active.');
      } else {
        archiveEvent(ev.id);
        toast('Archived.');
      }
      loadAdminEvents();
    };
    // Deleting is STAGED, not immediate: no popup, no server call. The row is
    // marked, and SAVE at the top of the EVENTS box is what actually removes it
    // from the server. Hitting DELETE again un-stages it.
    const doDelete = async () => {
      btn.style.transform = '';
      const key = String(ev.id);
      if (pendingEventDeletes.has(key)) pendingEventDeletes.delete(key);
      else pendingEventDeletes.add(key);
      $('eventModal').classList.add('hidden');
      lastEventsSig = '';
      paintPendingEvents();
      loadAdminEvents();
    };

    attachSwipe(wrap, btn, { left: doArchive, right: doDelete });

    // Swipe is invisible — nobody discovers it. These are the same actions as
    // plain buttons, so every event can be edited, archived and deleted
    // without knowing a gesture exists.
    const actions = document.createElement('div');
    actions.className = 'event-actions';
    const mk = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip-btn ${cls}`;
      b.textContent = label;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      return b;
    };
    actions.append(
      mk('EDIT', 'primary', () => openEventDetail(ev)),
      mk(isArchived(ev.id) ? 'RESTORE' : 'ARCHIVE', '', doArchive),
      mk(staged ? 'UNDO DELETE' : 'DELETE', 'danger', doDelete),
    );
    wrap.appendChild(actions);
    return wrap;
  }

  function attachSwipe(wrap, btn, handlers) {
    let x0 = null;
    let dx = 0;
    const THRESH = 72;
    const start = (x) => { x0 = x; dx = 0; btn.style.transition = 'none'; };
    const move = (x) => {
      if (x0 == null) return;
      dx = x - x0;
      btn.style.transform = `translateX(${Math.max(-110, Math.min(110, dx))}px)`;
    };
    const end = async () => {
      if (x0 == null) return;
      btn.style.transition = 'transform .15s ease';
      if (dx <= -THRESH) await handlers.left();
      else if (dx >= THRESH) await handlers.right();
      else btn.style.transform = '';
      x0 = null; dx = 0;
    };
    btn.addEventListener('touchstart', (e) => start(e.changedTouches[0].clientX), { passive: true });
    btn.addEventListener('touchmove', (e) => move(e.changedTouches[0].clientX), { passive: true });
    btn.addEventListener('touchend', end);
    btn.addEventListener('mousedown', (e) => {
      start(e.clientX);
      const onMove = (ev) => move(ev.clientX);
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); end(); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  let editingEvent = null; // live event row when form is in edit mode

  function openEventDetail(ev) {
    ev = applyEventEdit(ev);
    const packs = policiesForEvent(ev);
    const ended = ev.end_at && new Date(ev.end_at) <= new Date();
    $('evDetailTag').textContent = isArchived(ev.id) ? 'ARCHIVED EVENT' : ended ? 'PAST EVENT' : 'LIVE EVENT';
    $('evDetailBody').innerHTML = `
      <h3 class="confirm-title" style="text-align:left;margin-bottom:.4rem">${esc(ev.name)}</h3>
      <div class="ev-detail-meta">
        <div><b>Starts</b> — ${new Date(ev.start_at).toLocaleString()}</div>
        <div><b>Ends</b> — ${new Date(ev.end_at).toLocaleString()}</div>
        <div><b>Report email</b> — ${esc(ev.owner_email || '—')}</div>
        <div><b>Sheet</b> — ${ev.report_sent ? 'sent' : ended ? 'pending / ended' : 'open'}</div>
        <div><b>Policies</b> — ${packs.length ? esc(packs.map((p) => p.title).join(' · ')) : 'none selected'}</div>
      </div>
      <h3 class="section-label" style="margin-top:1rem">POLICIES</h3>
      ${renderPolicyHtml(packs)}
      <div class="ev-detail-actions">
        <button class="big-btn primary" id="evEditBtn" type="button"><span class="big-btn-title">EDIT</span></button>
        ${isArchived(ev.id)
          ? '<button class="big-btn outline" id="evRestoreBtn" type="button"><span class="big-btn-title">RESTORE TO ACTIVE</span></button>'
          : '<button class="big-btn outline" id="evArchiveBtn" type="button"><span class="big-btn-title">ARCHIVE</span></button>'}
        <button class="big-btn danger" id="evDeleteBtn" type="button"><span class="big-btn-title">DELETE</span></button>
      </div>`;
    $('eventModal').classList.remove('hidden');
    $('evEditBtn').onclick = () => {
      $('eventModal').classList.add('hidden');
      openEventFormForEdit(ev);
    };
    const arch = $('evArchiveBtn');
    const rest = $('evRestoreBtn');
    if (arch) arch.onclick = () => { archiveEvent(ev.id); toast('Archived.'); $('eventModal').classList.add('hidden'); loadAdminEvents(); };
    if (rest) rest.onclick = () => { restoreEvent(ev.id); toast('Restored.'); $('eventModal').classList.add('hidden'); loadAdminEvents(); };
    $('evDeleteBtn').onclick = async () => {
      const yes = await confirmAsk('Delete this event?', `"${ev.name}" will be hidden from the lists.`);
      if (!yes) return;
      const deleteBtn = $('evDeleteBtn');
      deleteBtn.disabled = true;
      toast('Deleting on every device…', false, 8000);
      const synced = await deleteEventEverywhere(ev.id);
      toast(synced
        ? 'Deleted everywhere — phone and computer are synced.'
        : 'Deleted here. Shared sync is retrying — keep this screen open.', !synced, synced ? 4200 : 7000);
      $('eventModal').classList.add('hidden');
      loadAdminEvents();
    };
  }
  $('evDetailClose').onclick = () => $('eventModal').classList.add('hidden');

  /* ---------- scroll / type time pickers (12h + AM/PM) ---------- */
  const timePickers = {};

  function parseFlexibleTime(str) {
    const raw = String(str || '').trim().toLowerCase().replace(/\./g, '');
    if (!raw) return null;
    let m = raw.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(a|am|p|pm)?$/i);
    if (!m) m = raw.match(/^(\d{1,2})(\d{2})\s*(a|am|p|pm)?$/i);
    if (!m) return null;
    let hour = Number(m[1]);
    let min = Number(m[2] != null ? m[2] : 0);
    if (Number.isNaN(hour) || Number.isNaN(min) || min < 0 || min > 59) return null;
    const ap = (m[3] || '').charAt(0);
    if (ap === 'a' || ap === 'p') {
      if (hour < 1 || hour > 12) return null;
      if (hour === 12) hour = 0;
      if (ap === 'p') hour += 12;
    } else if (hour > 23) return null;
    return { hour, min };
  }

  function to12(hour24, min) {
    const ap = hour24 >= 12 ? 'PM' : 'AM';
    let h = hour24 % 12;
    if (h === 0) h = 12;
    return { h, min, ap };
  }

  function format12(hour24, min) {
    const t = to12(hour24, min);
    return `${t.h}:${pad(t.min)} ${t.ap}`;
  }

  function buildTimePicker(rootId, defaultHHMM) {
    const root = $(rootId);
    const [dh, dm] = defaultHHMM.split(':').map(Number);
    const state = { hour: dh, min: dm };
    const hourCol = root.querySelector('[data-part="hour"]');
    const minCol = root.querySelector('[data-part="min"]');
    const ampmCol = root.querySelector('[data-part="ampm"]');
    const typeInput = root.querySelector('.tp-type');
    let syncing = false;

    if (!root.querySelector('.tp-hilite')) {
      const hi = document.createElement('div');
      hi.className = 'tp-hilite';
      root.querySelector('.tp-wheels').appendChild(hi);
    }

    function fillCol(col, values, selected) {
      col.innerHTML = '';
      // spacer rows so first/last can center
      const spacer = () => {
        const s = document.createElement('div');
        s.className = 'tp-item';
        s.style.visibility = 'hidden';
        s.textContent = '·';
        return s;
      };
      col.appendChild(spacer());
      values.forEach((v) => {
        const item = document.createElement('div');
        const label = col.dataset.part === 'min' ? pad(v) : String(v);
        const selectedLabel = col.dataset.part === 'min' ? pad(selected) : String(selected);
        item.className = `tp-item${label === selectedLabel ? ' on' : ''}`;
        item.dataset.val = label;
        item.textContent = label;
        col.appendChild(item);
      });
      col.appendChild(spacer());
    }

    function paintWheels() {
      const t = to12(state.hour, state.min);
      fillCol(hourCol, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], t.h);
      fillCol(minCol, Array.from({ length: 60 }, (_, i) => i), t.min);
      fillCol(ampmCol, ['AM', 'PM'], t.ap);
      requestAnimationFrame(() => {
        snapTo(hourCol, String(t.h), false);
        snapTo(minCol, pad(t.min), false);
        snapTo(ampmCol, t.ap, false);
      });
      syncing = true;
      typeInput.value = format12(state.hour, state.min);
      syncing = false;
    }

    function snapTo(col, val, smooth) {
      const items = [...col.querySelectorAll('.tp-item[data-val]')];
      const target = items.find((el) => el.dataset.val === String(val) || el.dataset.val === String(Number(val)));
      if (!target) return;
      const top = target.offsetTop - (col.clientHeight / 2 - target.clientHeight / 2);
      col.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
      items.forEach((el) => el.classList.toggle('on', el === target));
    }

    function readCol(col) {
      const mid = col.scrollTop + col.clientHeight / 2;
      let best = null;
      let bestDist = Infinity;
      col.querySelectorAll('.tp-item[data-val]').forEach((el) => {
        const c = el.offsetTop + el.clientHeight / 2;
        const d = Math.abs(c - mid);
        if (d < bestDist) { bestDist = d; best = el; }
      });
      return best;
    }

    function applyFromWheels() {
      const hEl = readCol(hourCol);
      const mEl = readCol(minCol);
      const aEl = readCol(ampmCol);
      if (!hEl || !mEl || !aEl) return;
      let h = Number(hEl.dataset.val);
      const min = Number(mEl.dataset.val);
      const ap = aEl.dataset.val;
      if (h === 12) h = 0;
      if (ap === 'PM') h += 12;
      state.hour = h;
      state.min = min;
      hourCol.querySelectorAll('.tp-item[data-val]').forEach((el) => el.classList.toggle('on', el === hEl));
      minCol.querySelectorAll('.tp-item[data-val]').forEach((el) => el.classList.toggle('on', el === mEl));
      ampmCol.querySelectorAll('.tp-item[data-val]').forEach((el) => el.classList.toggle('on', el === aEl));
      syncing = true;
      typeInput.value = format12(state.hour, state.min);
      syncing = false;
    }

    let scrollTimers = new WeakMap();
    function onScroll(col) {
      clearTimeout(scrollTimers.get(col));
      scrollTimers.set(col, setTimeout(() => {
        const el = readCol(col);
        if (el) snapTo(col, el.dataset.val, true);
        applyFromWheels();
      }, 80));
    }

    hourCol.onscroll = () => onScroll(hourCol);
    minCol.onscroll = () => onScroll(minCol);
    ampmCol.onscroll = () => onScroll(ampmCol);

    // tap an item to select
    [hourCol, minCol, ampmCol].forEach((col) => {
      col.addEventListener('click', (e) => {
        const item = e.target.closest('.tp-item[data-val]');
        if (!item) return;
        snapTo(col, item.dataset.val, true);
        applyFromWheels();
      });
    });

    typeInput.addEventListener('change', () => {
      if (syncing) return;
      const parsed = parseFlexibleTime(typeInput.value);
      if (!parsed) {
        typeInput.value = format12(state.hour, state.min);
        toast('Couldn’t read that time — try 10:00 AM', true);
        return;
      }
      state.hour = parsed.hour;
      state.min = parsed.min;
      paintWheels();
    });
    typeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); typeInput.blur(); }
    });

    paintWheels();
    timePickers[rootId] = {
      get: () => ({ hour: state.hour, min: state.min }),
      set: (hour, min) => { state.hour = hour; state.min = min; paintWheels(); },
    };
  }

  function initTimePickers() {
    if (!timePickers.tpStart) buildTimePicker('tpStart', '10:00');
    if (!timePickers.tpEnd) buildTimePicker('tpEnd', '22:00');
  }

  /* ---------- multi-email report recipients ---------- */
  let selectedEmails = [];

  function normalizeEmail(e) {
    return String(e || '').trim().toLowerCase();
  }
  function isEmail(e) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  }

  function paintEmailUI() {
    const list = $('evEmailList');
    const chips = $('evEmailChips');
    const selectedBox = $('evEmailSelected');
    list.innerHTML = meta.emails.map((e) => `<option value="${esc(e)}"></option>`).join('');

    selectedBox.innerHTML = '';
    if (!selectedEmails.length) {
      selectedBox.innerHTML = '<span class="muted" style="font-size:.72rem">No recipients yet — tap a chip or type + ADD.</span>';
    } else {
      selectedEmails.forEach((e) => {
        const pill = document.createElement('span');
        pill.className = 'email-pill';
        pill.innerHTML = `${esc(e)} <button type="button" class="x" aria-label="Remove">✕</button>`;
        pill.querySelector('.x').onclick = () => {
          selectedEmails = selectedEmails.filter((x) => x !== e);
          paintEmailUI();
        };
        selectedBox.appendChild(pill);
      });
    }

    chips.innerHTML = '';
    meta.emails.slice(0, 10).forEach((e) => {
      const on = selectedEmails.includes(e);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.classList.toggle('on', on);
      b.onclick = () => {
        if (on) selectedEmails = selectedEmails.filter((x) => x !== e);
        else selectedEmails = [...selectedEmails, e];
        paintEmailUI();
      };
      chips.appendChild(b);
    });
  }

  function addEmailFromInput() {
    const raw = normalizeEmail($('evOwnerInput').value);
    if (!raw) return;
    if (!isEmail(raw)) {
      toast('That doesn’t look like an email.', true);
      return;
    }
    if (!selectedEmails.includes(raw)) selectedEmails = [...selectedEmails, raw];
    rememberEmail(raw);
    $('evOwnerInput').value = '';
    paintEmailUI();
  }

  $('evOwnerAdd').onclick = addEmailFromInput;
  $('evOwnerInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addEmailFromInput(); }
  });

  function paintPolicyChecks(selectedKeys) {
    const selected = new Set(normalizePolicyKeys(selectedKeys));
    const box = $('evPolicyChecks');
    box.innerHTML = '';
    Object.values(POLICY_PACKS).forEach((p) => {
      const on = selected.has(p.id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `policy-check${on ? ' on' : ''}`;
      btn.dataset.policy = p.id;
      btn.innerHTML = `
        <span class="tc-check ${on ? 'checked' : ''}"></span>
        <span class="policy-check-text">
          <span class="policy-check-title">${esc(p.title)}</span>
          <span class="policy-check-sub">${esc(p.blurb || '')}</span>
        </span>`;
      btn.onclick = () => {
        if (selected.has(p.id)) selected.delete(p.id);
        else selected.add(p.id);
        paintPolicyChecks([...selected]);
      };
      box.appendChild(btn);
    });
  }
  function selectedPolicyKeys() {
    return [...$('evPolicyChecks').querySelectorAll('.policy-check.on')].map((b) => b.dataset.policy);
  }

  function removeTemplate(id) {
    const gone = meta.templates.find((t) => t.id === id);
    // Record the tombstone BEFORE dropping it, or the name is lost and the next
    // cloud merge hands the chip straight back.
    if (gone) {
      meta.deletedTemplates = meta.deletedTemplates || {};
      meta.deletedTemplates[tplKey(gone.name)] = true;
    }
    meta.templates = meta.templates.filter((t) => t.id !== id);
    saveMeta(meta);
    if (selectedTemplateId === id) {
      selectedTemplateId = null;
      if (!editingEvent) $('evName').value = '';
    }
  }

  function paintTemplates() {
    const box = $('evTemplates');
    box.innerHTML = '';
    const sorted = dropDeletedTemplates(meta.templates, meta.deletedTemplates)
      .slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    sorted.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.name;
      b.title = 'Tap to select · Double-tap / double-click to delete';
      b.classList.toggle('on', selectedTemplateId === t.id);
      let lastTap = 0;
      let singleTimer = null;
      const askDelete = async () => {
        clearTimeout(singleTimer);
        const yes = await confirmAsk(
          'Delete saved event?',
          `"${t.name}" will be removed from Choose Event. Active events and punch history stay.`
        );
        if (!yes) return;
        removeTemplate(t.id);
        paintTemplates();
        toast('Removed from Choose Event.');
      };
      b.addEventListener('click', (e) => {
        const now = Date.now();
        // Double-tap (phones) or fast second click
        if (now - lastTap < 380) {
          lastTap = 0;
          e.preventDefault();
          askDelete();
          return;
        }
        lastTap = now;
        clearTimeout(singleTimer);
        singleTimer = setTimeout(() => applyTemplate(t), 300);
      });
      b.addEventListener('dblclick', (e) => {
        e.preventDefault();
        askDelete();
      });
      box.appendChild(b);
    });
  }

  function applyTemplate(t) {
    selectedTemplateId = t.id;
    $('evName').value = t.name;
    paintPolicyChecks(t.policyKeys || []);
    initTimePickers();
    timePickers.tpStart.set(t.startHour ?? 10, t.startMin ?? 0);
    timePickers.tpEnd.set(t.endHour ?? 22, t.endMin ?? 0);
    if (t.emails && t.emails.length) {
      selectedEmails = t.emails.slice();
    }
    paintEmailUI();
    durationKind = t.duration || 'custom';
    if (durationKind === 'custom') {
      [...$('evDurationChips').children].forEach((c) => c.classList.toggle('on', c.dataset.dur === 'custom'));
      // keep whatever calendar range is already picked; user can retune
      paintCalendar();
    } else {
      setDuration(durationKind);
    }
    paintTemplates();
  }

  // Typing a new name clears the chip highlight so it becomes a fresh saved event on create
  $('evName').addEventListener('input', () => {
    const v = $('evName').value.trim().toLowerCase();
    const match = meta.templates.find((t) => t.name.toLowerCase() === v);
    if (match) {
      selectedTemplateId = match.id;
      paintPolicyChecks(match.policyKeys || []);
    } else {
      selectedTemplateId = null;
    }
    paintTemplates();
  });

  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parseYmd(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function startOfWeek(d) {
    const x = new Date(d); const day = x.getDay();
    x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x;
  }

  function setDuration(kind) {
    durationKind = kind;
    [...$('evDurationChips').children].forEach((b) => b.classList.toggle('on', b.dataset.dur === kind));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (kind === 'today') {
      // Always the calendar day you are on right now
      rangeStart = ymd(today);
      rangeEnd = ymd(today);
      calCursor = new Date(today);
    } else if (kind === 'tomorrow') {
      const next = addDays(today, 1);
      rangeStart = ymd(next);
      rangeEnd = ymd(next);
      calCursor = next;
    } else if (kind === 'weekend') {
      // Friday → Saturday of the coming weekend (this week if Fri/Sat already)
      const dow = today.getDay(); // 0 Sun … 5 Fri 6 Sat
      let fri;
      if (dow === 5) fri = today;
      else if (dow === 6) fri = addDays(today, -1);
      else if (dow === 0) fri = addDays(today, 5); // next Friday
      else fri = addDays(today, 5 - dow); // Mon–Thu → this Friday
      rangeStart = ymd(fri);
      rangeEnd = ymd(addDays(fri, 1)); // Saturday
      calCursor = fri;
    } else if (kind === 'week') {
      // Sunday → Thursday
      const sun = startOfWeek(today);
      rangeStart = ymd(sun);
      rangeEnd = ymd(addDays(sun, 4));
      calCursor = sun;
    } else {
      /* custom — keep current picks */
    }
    paintCalendar();
  }

  function paintCalendar() {
    const title = $('calTitle');
    const grid = $('calGrid');
    const y = calCursor.getFullYear();
    const m = calCursor.getMonth();
    title.textContent = new Date(y, m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const dows = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    grid.innerHTML = dows.map((d) => `<div class="cal-dow">${d}</div>`).join('');
    for (let i = 0; i < firstDow; i++) grid.innerHTML += '<button type="button" class="cal-day" disabled></button>';
    const todayStr = localDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const s = `${y}-${pad(m + 1)}-${pad(day)}`;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cal-day';
      b.textContent = String(day);
      if (s === todayStr) b.classList.add('today');
      if (rangeStart && rangeEnd && s >= rangeStart && s <= rangeEnd) b.classList.add('in-range');
      if (s === rangeStart || s === rangeEnd) b.classList.add('edge');
      b.onclick = () => {
        if (!rangeStart || (rangeStart && rangeEnd)) {
          rangeStart = s; rangeEnd = null;
        } else if (s < rangeStart) {
          rangeEnd = rangeStart; rangeStart = s;
        } else {
          rangeEnd = s;
        }
        [...$('evDurationChips').children].forEach((c) => c.classList.toggle('on', c.dataset.dur === 'custom'));
        durationKind = 'custom';
        paintCalendar();
      };
      grid.appendChild(b);
    }
    const label = $('calRange');
    if (rangeStart && rangeEnd) {
      label.textContent = rangeStart === rangeEnd
        ? `Selected: ${fmtDate(rangeStart)}`
        : `Selected: ${fmtDate(rangeStart)} → ${fmtDate(rangeEnd)}`;
    } else if (rangeStart) {
      label.textContent = `Start ${fmtDate(rangeStart)} — now tap the end day.`;
    } else {
      label.textContent = 'Tap a start day, then an end day.';
    }
  }

  $('calPrev').onclick = () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); paintCalendar(); };
  $('calNext').onclick = () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); paintCalendar(); };
  $('evDurationChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dur]');
    if (b) setDuration(b.dataset.dur);
  });

  let eventSubmitInFlight = false;

  function eventFormSubmitButton() {
    return $('eventForm').querySelector('button[type="submit"]');
  }

  function setEventFormBusy(busy) {
    eventSubmitInFlight = !!busy;
    const form = $('eventForm');
    const btn = eventFormSubmitButton();
    if (btn) btn.disabled = !!busy;
    form.setAttribute('aria-busy', busy ? 'true' : 'false');
    $('eventFormSubmitLabel').textContent = busy
      ? 'SAVING…'
      : (form.dataset.editingId ? 'SAVE CHANGES' : 'CREATE EVENT');
  }

  function setFormMode(mode, eventId) {
    const editing = mode === 'edit';
    $('eventFormTitle').textContent = editing ? 'EDIT EVENT' : 'NEW EVENT';
    const form = $('eventForm');
    if (editing && eventId != null) form.dataset.editingId = String(eventId);
    else delete form.dataset.editingId;
    if (!eventSubmitInFlight) $('eventFormSubmitLabel').textContent = editing ? 'SAVE CHANGES' : 'CREATE EVENT';
  }

  function closeEventForm() {
    const form = $('eventForm');
    form.classList.add('hidden');
    form.classList.remove('collapsed');
    selectedTemplateId = null;
    selectedEmails = [];
    editingEvent = null;
    setFormMode('create');
    setEventFormBusy(false);
    $('evErr').classList.add('hidden');
    $('evErr').textContent = '';
    // Don't form.reset() — custom time/policy widgets fight native reset and can leave the panel feeling stuck.
  }

  function finishFormToEventList(message) {
    closeEventForm();
    eventTab = 'active';
    [...$('eventTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.tab === 'active'));
    loadAdminEvents();
    toast(message, false, 4500);
    const list = $('adminEvents');
    if (list) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openEventForm() {
    // Always open a fresh New Event panel from the top button (never toggle-close)
    editingEvent = null;
    setFormMode('create');
    const form = $('eventForm');
    form.classList.remove('hidden');
    setEventFormCollapsed(false);
    meta = loadMeta();
    selectedTemplateId = null;
    $('evName').value = '';
    initTimePickers();
    timePickers.tpStart.set(10, 0);
    timePickers.tpEnd.set(22, 0);
    selectedEmails = dedupeEmails([...adminReportEmails, ...(meta.emails[0] ? [meta.emails[0]] : [])]);
    paintTemplates();
    paintPolicyChecks([]);
    paintEmailUI();
    rangeStart = localDate();
    rangeEnd = localDate();
    calCursor = new Date();
    setDuration('today');
    $('evErr').classList.add('hidden');
    $('evName').focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openEventFormForEdit(ev) {
    ev = applyEventEdit(ev);
    editingEvent = ev;
    setFormMode('edit', ev.id);
    const form = $('eventForm');
    form.classList.remove('hidden');
    setEventFormCollapsed(false);
    meta = loadMeta();
    selectedTemplateId = null;
    $('evName').value = ev.name || '';

    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);
    rangeStart = ymd(start);
    rangeEnd = ymd(end);
    // if overnight edit stored end on next day, keep that
    calCursor = start;
    durationKind = 'custom';
    [...$('evDurationChips').children].forEach((c) => c.classList.toggle('on', c.dataset.dur === 'custom'));
    paintCalendar();

    initTimePickers();
    timePickers.tpStart.set(start.getHours(), start.getMinutes());
    timePickers.tpEnd.set(end.getHours(), end.getMinutes());

    const packs = policiesForEvent(ev);
    paintPolicyChecks(packs.map((p) => p.id));

    selectedEmails = String(ev.owner_email || '')
      .split(/[,;]+/)
      .map(normalizeEmail)
      .filter(isEmail);
    if (!selectedEmails.length && meta.emails[0]) selectedEmails = [meta.emails[0]];
    paintEmailUI();
    paintTemplates();

    // highlight matching Choose Event chip if any
    const match = meta.templates.find((t) => t.name.toLowerCase() === String(ev.name || '').toLowerCase());
    if (match) selectedTemplateId = match.id;
    paintTemplates();

    $('evErr').classList.add('hidden');
    $('evName').focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('adminRefresh').onclick = loadAdmin;
  $('adminDate').onchange = loadAdmin;
  $('adminNewEvent').onclick = openEventForm;
  /**
   * Collapsing hides the FIELDS and keeps the NEW EVENT header with a ⌄, so the
   * panel can be reopened. It used to hide the whole form, which made the panel
   * vanish with nothing left to tap.
   */
  function setEventFormCollapsed(on) {
    const form = $('eventForm');
    const btn = $('eventFormCollapse');
    form.classList.toggle('collapsed', on);
    btn.textContent = on ? '⌄' : '⌃';
    btn.setAttribute('aria-expanded', on ? 'false' : 'true');
    btn.setAttribute('aria-label', on ? 'Open new event form' : 'Collapse new event form');
    btn.title = on ? 'Open' : 'Collapse';
  }

  $('eventFormCollapse').onclick = () => {
    if (eventSubmitInFlight) return;
    setEventFormCollapsed(!$('eventForm').classList.contains('collapsed'));
  };
  // The whole header is a target too — a 20px chevron is a poor thumb target.
  $('eventFormCollapse').closest('.form-card-head').onclick = (e) => {
    if (e.target.closest('#eventFormCollapse') || eventSubmitInFlight) return;
    if ($('eventForm').classList.contains('collapsed')) setEventFormCollapsed(false);
  };

  function normalizedEventName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function normalizedEventEmails(value) {
    return String(value || '')
      .split(/[,;]+/)
      .map(normalizeEmail)
      .filter(isEmail)
      .sort()
      .join(',');
  }

  function isSameEventDraft(ev, draft) {
    if (!ev || isMetaEvent(ev) || isDeleted(ev.id)) return false;
    const live = applyEventEdit(ev);
    return normalizedEventName(live.name) === normalizedEventName(draft.name)
      && Date.parse(live.start_at || '') === Date.parse(draft.start_at || '')
      && Date.parse(live.end_at || '') === Date.parse(draft.end_at || '')
      && normalizedEventEmails(live.owner_email) === normalizedEventEmails(draft.owner_email);
  }

  async function findMatchingEvent(draft) {
    const live = rows(await api('tc-events'));
    return live.find((ev) => isSameEventDraft(ev, draft)) || null;
  }

  $('eventForm').onsubmit = async (e) => {
    e.preventDefault();
    if (eventSubmitInFlight) return;
    $('evErr').classList.add('hidden');
    const name = $('evName').value.trim();
    if (!name) {
      $('evErr').textContent = 'Pick a template or type an event name.';
      $('evErr').classList.remove('hidden');
      return;
    }
    if (name === META_EVENT_NAME || name.startsWith('__JUSTUS_TC_META')) {
      $('evErr').textContent = 'That name is reserved for device sync — pick another.';
      $('evErr').classList.remove('hidden');
      return;
    }
    if (!rangeStart || !rangeEnd) {
      $('evErr').textContent = 'Select start and end days on the calendar.';
      $('evErr').classList.remove('hidden');
      return;
    }
    const startT = timePickers.tpStart.get();
    const endT = timePickers.tpEnd.get();
    const start = parseYmd(rangeStart); start.setHours(startT.hour, startT.min, 0, 0);
    const end = parseYmd(rangeEnd); end.setHours(endT.hour, endT.min, 0, 0);
    // Same-day / multi-day: if end clock is not after start, treat as overnight into the next calendar day
    // (no "overlap" block — many JustUs shifts run past midnight)
    if (!(end > start)) {
      end.setDate(end.getDate() + 1);
    }
    if (!(end > start)) {
      $('evErr').textContent = 'Check start/end times — something still looks off.';
      $('evErr').classList.remove('hidden');
      return;
    }
    if (!selectedEmails.length) {
      $('evErr').textContent = 'Add at least one report email.';
      $('evErr').classList.remove('hidden');
      return;
    }
    // Force the admin addresses back in. Whoever creates the event, the owners
    // always get its report — they cannot be un-ticked away.
    const owner = dedupeEmails([...adminReportEmails, ...selectedEmails]).join(', ');
    const policyKeys = selectedPolicyKeys();
    const startSnap = timePickers.tpStart.get();
    const endSnap = timePickers.tpEnd.get();
    const startISO = localISO(start);
    const endISO = localISO(end);
    const draft = {
      name,
      start_at: startISO,
      end_at: endISO,
      owner_email: owner,
    };

    // Lock on the first valid tap and collapse immediately. The old form stayed
    // visible until n8n answered, which invited the 13-tap duplicate incident.
    setEventFormBusy(true);
    $('eventForm').classList.add('hidden');
    toast('Saving event…', false, 8000);

    // Always refresh the Choose Event chip with the latest settings
    rememberTemplate(name, {
      policyKeys,
      startHour: startSnap.hour,
      startMin: startSnap.min,
      endHour: endSnap.hour,
      endMin: endSnap.min,
      emails: selectedEmails.slice(),
      duration: durationKind,
    });
    selectedEmails.forEach(rememberEmail);

    // ——— EDIT existing event (never POST create — n8n create webhook would spawn a duplicate) ———
    const editId = (editingEvent && editingEvent.id != null)
      ? editingEvent.id
      : ($('eventForm').dataset.editingId || null);
    if (editId != null && String(editId) !== '') {
      const id = editId;
      setEventPolicies(id, policyKeys);
      saveEventEdit(id, {
        name,
        start_at: startISO,
        end_at: endISO,
        owner_email: owner,
        policyKeys,
      });
      // Keep Choose Event chip in sync with this same event — do not create a live duplicate
      rememberTemplate(name, {
        policyKeys,
        startHour: startSnap.hour,
        startMin: startSnap.min,
        endHour: endSnap.hour,
        endMin: endSnap.min,
        emails: selectedEmails.slice(),
        duration: durationKind,
      });
      const policyLabel = policyKeys.length
        ? policyKeys.map((k) => (POLICY_PACKS[k] && POLICY_PACKS[k].title) || k).join(' · ')
        : 'no policies';
      let synced = true;
      try { synced = await flushCloudMeta(); } catch { synced = false; }
      finishFormToEventList(synced
        ? `Saved everywhere. Updated “${name}” — ${policyLabel}. No new event added.`
        : `Saved here. Updated “${name}”; shared sync will retry. No new event added.`);
      return;
    }

    // ——— CREATE new event (only from + CREATE EVENT, never from Edit) ———
    try {
      // Exact-match lookup makes retries idempotent if a prior request reached
      // n8n but its response was lost, or if the same saved event is reopened.
      let row = null;
      try { row = await findMatchingEvent(draft); } catch { /* create can still work */ }
      const alreadySaved = !!row;
      if (!row) {
        const created = await api('tc-events', {
          method: 'POST',
          body: JSON.stringify({
            pass: adminPinOk,
            ...draft,
            policy_keys: policyKeys,
          }),
        });
        row = Array.isArray(created) ? created[0] : created;
      }
      if (row && row.id != null) {
        setEventPolicies(row.id, policyKeys);
        markCreated(row.id);
      }
      rememberTemplate(name, {
        policyKeys,
        startHour: startSnap.hour,
        startMin: startSnap.min,
        endHour: endSnap.hour,
        endMin: endSnap.min,
        emails: selectedEmails.slice(),
        duration: durationKind,
      });
      try { await flushCloudMeta(); } catch { /* event itself is already live; queued retry keeps metadata moving */ }
      finishFormToEventList(alreadySaved
        ? `Already saved — “${name}” still has one event only.`
        : `Event live — ${name} saved once and synced.`);
    } catch {
      // A timeout can happen after n8n committed the row. Recover that row
      // before showing Retry so a second tap cannot manufacture a duplicate.
      let recovered = null;
      try { recovered = await findMatchingEvent(draft); } catch { /* show retry below */ }
      if (recovered) {
        if (recovered.id != null) {
          setEventPolicies(recovered.id, policyKeys);
          markCreated(recovered.id);
        }
        try { await flushCloudMeta(); } catch { /* queued retry */ }
        finishFormToEventList(`Saved — “${name}” was confirmed live once. No duplicate added.`);
      } else {
        setEventFormBusy(false);
        $('eventForm').classList.remove('hidden');
        $('evErr').textContent = 'Couldn’t confirm the live save. Nothing else was submitted — check the connection and retry once.';
        $('evErr').classList.remove('hidden');
        paintTemplates();
        $('eventForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('Event was not confirmed. The form is open to retry.', true, 6000);
      }
    }
  };

  /* ============================================================
     WAITING ROOM — the point of the split.
     An employee taps CLOCK IN on their own app; nothing is stamped. They show
     up here, and an admin standing in front of them approves it. The stamp is
     the moment the admin taps, so the hours start when a human confirmed the
     person was actually there.
     ============================================================ */
  let lastWaitSig = '';
  const waitBusy = new Set();

  function waitedFor(iso) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return 'just now';
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 1) return 'just now';
    if (mins === 1) return '1 min ago';
    if (mins < 60) return `${mins} mins ago`;
    const h = Math.floor(mins / 60);
    return `${h} hr${h > 1 ? 's' : ''} ${mins % 60} min ago`;
  }

  function waitPhotoHref(url) {
    // Older photos are Google Drive links; ones taken since the move live on the
    // backend and need the admin pass, exactly like the day sheet's SELFIE link.
    return String(url).startsWith(API) ? `${url}?pass=${encodeURIComponent(adminPinOk)}` : String(url);
  }

  async function loadWaiting(opts = {}) {
    const box = $('waitList');
    if (!box || !adminPinOk) return;
    const silent = opts.silent === true;
    if (!silent) box.innerHTML = `<p class="muted center">${spinnerHtml()}Loading the waiting room…</p>`;
    let list;
    try {
      list = rows(await api(`tc-pending?pass=${encodeURIComponent(adminPinOk)}`))
        .filter((r) => String(r.status || 'waiting') === 'waiting')
        .sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)));
    } catch {
      if (!silent) box.innerHTML = '<p class="form-err center">Couldn\'t reach the waiting room. Hit REFRESH.</p>';
      return;
    }
    const sig = list.map((r) => [r.id, r.profile_id, r.kind, r.requested_at].join('~')).join('|');
    // A silent poll must not blow away a row the admin is mid-tap on.
    if (silent && sig === lastWaitSig) return;
    lastWaitSig = sig;
    if (!list.length) {
      box.innerHTML = '<p class="muted center">Nobody waiting. When someone taps CLOCK IN on the employee app, they appear here.</p>';
      return;
    }
    box.innerHTML = '';
    list.forEach((r) => box.appendChild(buildWaitRow(r)));
  }

  function buildWaitRow(r) {
    const isOut = String(r.kind) === 'clock_out';
    const card = document.createElement('div');
    card.className = `wait-card${isOut ? ' wait-out' : ''}`;
    const photo = r.photo_selfie
      ? `<a class="wait-selfie" href="${esc(waitPhotoHref(r.photo_selfie))}" target="_blank" rel="noopener">SELFIE</a>`
      : '<span class="wait-selfie muted">no photo</span>';
    card.innerHTML = `
      <div class="wait-top">
        <span class="wait-name">${esc(r.profile_name || 'Unknown')}</span>
        <span class="wait-kind ${isOut ? 'out' : 'in'}">${isOut ? 'WANTS TO CLOCK OUT' : 'WANTS TO CLOCK IN'}</span>
      </div>
      <div class="wait-meta">
        <span>${esc(r.event_name || 'No job named')}</span>
        <span>asked ${esc(waitedFor(r.requested_at))}</span>
        ${photo}
      </div>`;

    const actions = document.createElement('div');
    actions.className = 'wait-actions';

    const go = document.createElement('button');
    go.type = 'button';
    go.className = `big-btn ${isOut ? 'danger' : 'green'}`;
    go.innerHTML = `<span class="big-btn-title">${isOut ? '⏹ CLOCK OUT' : '⏱ CLOCK IN'}</span>
      <span class="big-btn-sub">Stamps ${esc(r.profile_name || 'them')} at this moment</span>`;
    go.onclick = () => decideWaiting(r, isOut ? 'clock_out' : 'clock_in', go);

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'chip-btn wait-dismiss';
    no.textContent = 'DISMISS';
    no.onclick = () => decideWaiting(r, 'dismiss', no);

    actions.append(go, no);
    card.appendChild(actions);
    return card;
  }

  async function decideWaiting(row, decision, btn) {
    if (waitBusy.has(row.id)) return;
    if (decision === 'dismiss') {
      const yes = await confirmAsk('Dismiss this request?',
        `${row.profile_name || 'This person'} will NOT be clocked ${String(row.kind) === 'clock_out' ? 'out' : 'in'}. They can ask again from their phone.`);
      if (!yes) return;
    }
    waitBusy.add(row.id);
    const label = btn.querySelector('.big-btn-title') || btn;
    const original = label.textContent;
    btn.disabled = true;
    label.textContent = 'STAMPING…';

    /* Two admins with this app open can both be looking at the same row. Without
       this check, both taps create a punch and the person is clocked in twice.
       One re-read closes almost all of that window, and an approval happens once
       per person per shift — it is not a hot path worth optimising. */
    try {
      const live = rows(await api(`tc-pending?pass=${encodeURIComponent(adminPinOk)}`))
        .some((r) => String(r.id) === String(row.id)
                  && String(r.profile_id) === String(row.profile_id)
                  && String(r.status || 'waiting') === 'waiting');
      if (!live) {
        toast(`Someone already handled ${row.profile_name || 'that request'}.`, false, 5000);
        waitBusy.delete(row.id);
        lastWaitSig = '';
        await loadWaiting();
        return;
      }
    } catch {
      // Couldn't re-check. Fall through rather than block a real clock-in over a
      // flaky check — a duplicate is fixable from the day sheet, a worker stuck
      // outside unpaid is not.
    }

    const now = localISO();
    try {
      const res = await api('tc-approve', {
        method: 'POST',
        body: JSON.stringify({
          pass: adminPinOk,
          decision,
          pending_id: String(row.id),
          // profile_id is not decoration — the backend matches on id AND
          // profile_id, because data-table row ids are REUSED after a delete.
          // Without it a stale list could clear the next person's request.
          profile_id: String(row.profile_id || ''),
          profile_name: String(row.profile_name || ''),
          event_id: String(row.event_id || ''),
          event_name: String(row.event_name || ''),
          work_date: String(row.work_date || localDate()),
          photo_selfie: String(row.photo_selfie || ''),
          punch_id: String(row.punch_id || ''),
          clock_in: now,
          clock_out: now,
        }),
      });
      if (!res || res.ok !== true) throw new Error('approve rejected');
      toast(decision === 'dismiss'
        ? `Dismissed ${row.profile_name || 'that request'}.`
        : `${row.profile_name || 'They'} ${decision === 'clock_out' ? 'clocked out' : 'is on the clock'} — ${fmtTime(now)}.`);
      lastWaitSig = '';
      await loadWaiting();
      if (!$('view-admin').classList.contains('hidden')) loadAdmin({ silent: true });
    } catch {
      toast('That didn\'t go through — nobody was stamped. Try again.', true, 5000);
      btn.disabled = false;
      label.textContent = original;
    } finally {
      waitBusy.delete(row.id);
    }
  }

  /* ---------- boot: the URL decides which page opens ----------
     Last, not at the top: routing can call openAdmin/loadProfiles, so every
     view function has to exist before the first route runs. */
  routeFromHash();

  /* ---------- QA hooks (harmless in production) ---------- */
  window.__tc = {
    show, openProfile, loadProfiles, api,
    loadWaiting, decideWaiting, buildWaitRow, openAdmin,
    get adminPinOk() { return adminPinOk; },
    // The real functions, not test-only wrappers — a hook that reimplements the
    // path it is meant to check proves nothing.
    startWizard, renderCreateEventAccess,
    // The real wizard object and the real renderer, so a test can step past the
    // camera (which no headless DOM can drive) without faking the punch path.
    renderWizard, get wiz() { return wiz; },
    get current() { return current; },
    get meta() { return meta; },
    ensureMetaSynced, pushCloudMeta, pullAndMergeCloudMeta,
  };
})();
