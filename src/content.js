/*
 * Wires everything together on facebook.com:
 *   - a floating "Block this ad" button (and Alt+X) that fingerprints the reel on screen and saves a rule
 *   - a scan loop that fingerprints every mounted reel and blocks the ones that match a rule
 * Rules and settings live in extension storage, shared with the manage page and all open tabs.
 */
(function () {
  'use strict';
  if (globalThis.__fbabLoaded) return;
  globalThis.__fbabLoaded = true;

  const F = globalThis.FBAB;
  const P = F.page;
  const ext = globalThis.browser || globalThis.chrome;
  const DEFAULT_SETTINGS = { enabled: true, autoSkip: true, blockSponsored: true, debug: false };
  const SPONSORED_REASON = 'Sponsored label';
  const SCAN_EVERY_MS = 1000;
  const SCAN_DEBOUNCE_MS = 200;
  const SKIP_RETRY_MS = 900;           // wait this long after an attempt before judging it a failure
  const MAX_TRIES_PER_AD = 8;          // then give up on that ad (the user scrolls past it)
  const SKIP_WINDOW_MS = 30000;
  const MAX_TRIES_PER_WINDOW = 14;     // hard ceiling across all ads, whatever the page does to our state
  const CLEAR_AFTER_MS = 1200;         // an unblocked reel must stay on screen this long to count as success
  const PAUSE_BURST = 3;               // at most this many pauses per video per PAUSE_WINDOW_MS ...
  const PAUSE_WINDOW_MS = 3000;        // ... beyond that the page is fighting us; mute and hide instead
  const BLOCKED_SELECTOR = '[data-fbab-blocked="1"]';

  let rules = [];
  let settings = Object.assign({}, DEFAULT_SETTINGS);

  const states = new WeakMap();      // reel container -> { ruleId (null when auto-blocked), reason, key, video }
  const blockedNow = new Set();      // containers currently blocked (strong refs; removed on unblock)
  const allowed = new WeakMap();     // reel container -> fingerprint key the user chose to "Show anyway"
  const mutedBefore = new WeakMap(); // video -> muted state before we silenced it
  const lastDebugKey = new WeakMap();
  const pauseLog = new WeakMap();    // video -> timestamps of our recent pauses
  const videoIds = new WeakMap();
  let nextVideoId = 1;

  // Skipping progress lives here, NOT on the per-reel state: Facebook may replace a reel's elements
  // at any moment, and attempt counts must survive that or we would retry forever.
  const skipper = { target: null, stuckTarget: null, tried: 0, lastAt: 0, lastStrategy: null, preferred: null, recent: [], clearSince: 0, cursor: 0 };

  const dbg = (...args) => { if (settings.debug) console.log('[reel-ad-blocker]', ...args); };

  // ---- Storage ------------------------------------------------------------------------------

  async function load() {
    const s = await ext.storage.local.get({ rules: [], settings: DEFAULT_SETTINGS });
    rules = s.rules || [];
    settings = Object.assign({}, DEFAULT_SETTINGS, s.settings);
  }

  // Every update is read-modify-write on a whole key, so overlapping updates would overwrite each
  // other (three reels blocked in the same scan counted as one). Run them strictly one at a time.
  let writeChain = Promise.resolve();
  function serialized(fn) {
    const run = writeChain.then(fn);
    writeChain = run.catch(() => {});
    return run;
  }

  const saveRule = (rule) => serialized(async () => {
    const cur = (await ext.storage.local.get({ rules: [] })).rules;
    cur.push(rule);
    await ext.storage.local.set({ rules: cur });
    rules = cur;
  });

  const deleteRule = (id) => serialized(async () => {
    const cur = (await ext.storage.local.get({ rules: [] })).rules.filter((r) => r.id !== id);
    await ext.storage.local.set({ rules: cur });
    rules = cur;
  });

  const recordAutoBlock = () => serialized(async () => {
    const stats = (await ext.storage.local.get({ stats: {} })).stats;
    stats.sponsoredBlocked = (stats.sponsoredBlocked || 0) + 1;
    await ext.storage.local.set({ stats });
  });

  const recordHit = (id) => serialized(async () => {
    const cur = (await ext.storage.local.get({ rules: [] })).rules;
    const rule = cur.find((r) => r.id === id);
    if (!rule) return;
    rule.hits = (rule.hits || 0) + 1;
    rule.lastHit = Date.now();
    await ext.storage.local.set({ rules: cur });
  });

  // ---- Small UI toolkit ---------------------------------------------------------------------

  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) node.setAttribute(k, v);
    node.append(...kids);
    return node;
  }

  const ui = {};
  let toastTimer = 0;

  function buildUi() {
    ui.fab = h('button', {
      class: 'fbab-fab', type: 'button',
      title: 'Mark the reel on screen as an ad and block look-alikes'
    }, '🚫 Block this ad', h('kbd', {}, 'Alt+X'));
    ui.toast = h('div', { class: 'fbab-toast', hidden: '' });
    ui.bannerText = h('span');
    ui.showAnyway = h('button', { class: 'fbab-link', type: 'button' }, 'Show anyway');
    ui.deleteRule = h('button', { class: 'fbab-link', type: 'button' }, 'Delete rule');
    ui.stopAuto = h('button', { class: 'fbab-link', type: 'button' }, 'Turn off auto-block');
    ui.banner = h('div', { class: 'fbab-banner', hidden: '' }, ui.bannerText, ui.showAnyway, ui.deleteRule, ui.stopAuto);
    ui.root = h('div', { id: 'fbab-ui' }, ui.banner, ui.toast, ui.fab);
    document.documentElement.appendChild(ui.root);

    // Keep keyboard focus on the page so Facebook's own arrow-key navigation keeps working.
    for (const b of ui.root.querySelectorAll('button')) b.addEventListener('mousedown', (e) => e.preventDefault());
    ui.fab.addEventListener('click', markCurrentAsAd);
    ui.showAnyway.addEventListener('click', () => {
      const container = ui.bannerFor;
      const st = container && states.get(container);
      if (!st) return;
      allowed.set(container, st.key);
      unblock(container);
      updateBanner(null);
    });
    ui.deleteRule.addEventListener('click', async () => {
      const st = ui.bannerFor && states.get(ui.bannerFor);
      if (!st || !st.ruleId) return;
      await deleteRule(st.ruleId);
      scan();
      toast('Rule deleted.');
    });
    ui.stopAuto.addEventListener('click', async () => {
      settings = Object.assign({}, settings, { blockSponsored: false });
      await ext.storage.local.set({ settings });
      scan();
      toast('Sponsored reels are no longer blocked automatically. Turn it back on from the toolbar icon.');
    });
  }

  function toast(message, undo) {
    clearTimeout(toastTimer);
    ui.toast.replaceChildren(h('span', {}, message));
    if (undo) {
      const btn = h('button', { class: 'fbab-link', type: 'button' }, 'Undo');
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => { ui.toast.hidden = true; undo(); });
      ui.toast.append(btn);
    }
    ui.toast.hidden = false;
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 8000);
  }

  function updateFab() {
    const hidden = !(settings.enabled && P.isReelPage());
    if (ui.fab.hidden !== hidden) ui.fab.hidden = hidden;
  }

  function updateBanner(active) {
    const st = active && states.get(active.container);
    if (!st) { if (!ui.banner.hidden) ui.banner.hidden = true; ui.bannerFor = null; return; }
    ui.bannerFor = active.container;
    let text = 'Ad blocked (' + st.reason + ')';
    if (settings.autoSkip) {
      text += skipper.stuckTarget === targetOf(st)
        ? ". Couldn't skip it automatically: scroll down to move on."
        : ', skipping…';
    }
    // Write only on change: our own UI updates must not look like page activity (see the observer below).
    if (ui.bannerText.textContent !== text) ui.bannerText.textContent = text;
    if (ui.deleteRule.hidden !== !st.ruleId) ui.deleteRule.hidden = !st.ruleId;   // auto-blocked reels have no rule
    if (ui.stopAuto.hidden !== !!st.ruleId) ui.stopAuto.hidden = !!st.ruleId;
    if (ui.banner.hidden) ui.banner.hidden = false;
  }

  // ---- Blocking -----------------------------------------------------------------------------

  const inCenter = (el) => {
    const r = el.getBoundingClientRect();
    return r.top < innerHeight / 2 && r.bottom > innerHeight / 2;
  };

  function block(reel, hit, key) {
    const { container, video } = reel;
    P.setBlocked(container, true);
    blockedNow.add(container);
    states.set(container, { ruleId: hit.rule ? hit.rule.id : null, reason: hit.reason, key, video });
    dbg('BLOCK', hit.reason, key);
    (hit.rule ? recordHit(hit.rule.id) : recordAutoBlock()).catch(() => {});
  }

  // Some players restart a video the moment it is paused. Answering every restart with another pause is
  // an endless fight, so after a short burst we leave it playing: it is muted and invisible anyway.
  function pauseUnlessFighting(video) {
    if (video.paused) return;
    const now = Date.now();
    const recent = (pauseLog.get(video) || []).filter((t) => now - t < PAUSE_WINDOW_MS);
    if (recent.length >= PAUSE_BURST) { pauseLog.set(video, recent); return; }
    recent.push(now);
    pauseLog.set(video, recent);
    video.pause();
  }

  function silence(video) {
    if (!mutedBefore.has(video)) mutedBefore.set(video, video.muted);
    if (!video.muted) video.muted = true;
    pauseUnlessFighting(video);
  }

  function unblock(container) {
    const st = states.get(container);
    if (st) dbg('UNBLOCK', st.reason);
    P.setBlocked(container, false);
    blockedNow.delete(container);
    states.delete(container);
    const video = st && st.video;
    if (video && mutedBefore.has(video)) {
      video.muted = mutedBefore.get(video);
      mutedBefore.delete(video);
    }
    if (video && video.isConnected && inCenter(container)) video.play().catch(() => {});
  }

  function releaseAll() {
    for (const c of Array.from(blockedNow)) unblock(c);
    updateBanner(null);
  }

  const videoId = (v) => {
    if (!videoIds.has(v)) videoIds.set(v, nextVideoId++);
    return videoIds.get(v);
  };

  // Identity of "the ad we are trying to get past". The reel's text, not its elements, so that Facebook
  // re-creating the elements does not make it look like a new ad. Without any text, fall back to the video.
  function targetOf(st) {
    return st.key === '||' ? 'video#' + videoId(st.video) : st.key;
  }

  const orderedStrategies = () => (skipper.preferred
    ? [skipper.preferred, ...P.SKIP_ORDER.filter((n) => n !== skipper.preferred)]
    : P.SKIP_ORDER);

  // One attempt per call, escalating through the strategies; never more than the caps allow.
  function maybeSkip(st, reel) {
    const now = Date.now();
    const target = targetOf(st);
    if (skipper.target !== target) {
      // A different reel is in front of us. If we pushed a moment ago, whatever we used worked.
      if (skipper.target && skipper.lastStrategy && now - skipper.lastAt < 3000) skipper.preferred = skipper.lastStrategy;
      Object.assign(skipper, { target, stuckTarget: null, tried: 0, lastStrategy: null, clearSince: 0, cursor: 0 });
    }
    if (skipper.stuckTarget === target) return;

    skipper.recent = skipper.recent.filter((t) => now - t < SKIP_WINDOW_MS);
    if (skipper.tried >= MAX_TRIES_PER_AD || skipper.recent.length >= MAX_TRIES_PER_WINDOW) return giveUp(target);
    if (now - skipper.lastAt < SKIP_RETRY_MS) return;

    const order = orderedStrategies();
    for (let i = 0; i < order.length; i++) {
      const at = (skipper.cursor + i) % order.length;
      const name = order[at];
      if (!P.runSkip(name, reel.container)) continue;     // not applicable on this page: try the next one now
      skipper.cursor = at + 1;                            // next attempt uses a different method
      skipper.tried++;
      skipper.lastAt = now;
      skipper.lastStrategy = name;
      skipper.recent.push(now);
      dbg('SKIP attempt', skipper.tried + '/' + MAX_TRIES_PER_AD, 'via', name);
      return;
    }
    giveUp(target);
  }

  // We only count an ad as "got past" once an unblocked reel has STAYED on screen for a moment. A skip
  // that moves the page partway and snaps back must not reset the attempt counter, or we would retry forever.
  function noteProgress(active) {
    if (!skipper.target) return;
    if (active && states.get(active.container)) { skipper.clearSince = 0; return; }
    const now = Date.now();
    if (!skipper.clearSince) skipper.clearSince = now;
    if (now - skipper.clearSince < CLEAR_AFTER_MS) return;
    if (skipper.lastStrategy && now - skipper.lastAt < 4000 + CLEAR_AFTER_MS) skipper.preferred = skipper.lastStrategy;
    Object.assign(skipper, { target: null, stuckTarget: null, tried: 0, lastStrategy: null, clearSince: 0, cursor: 0 });
    dbg('Got past the ad; will prefer', skipper.preferred || '(none yet)');
  }

  function giveUp(target) {
    if (skipper.stuckTarget === target) return;
    skipper.stuckTarget = target;
    dbg('STUCK: could not get past this ad after', skipper.tried, 'attempts; leaving it hidden for the user to scroll past');
  }

  function evaluate(reel, isActive) {
    const fp = F.buildFingerprint(P.collectRaw(reel.container));
    const key = F.fingerprintKey(fp);
    // A learned rule wins (it explains itself better); otherwise the Sponsored label alone is enough.
    let hit = F.findMatch(fp, rules);
    if (!hit && settings.blockSponsored && fp.sponsored) hit = { rule: null, reason: SPONSORED_REASON };
    if (hit && allowed.get(reel.container) === key) hit = null;

    if (settings.debug) debugReport(reel, fp, hit, key, isActive);

    let st = states.get(reel.container);
    if (!hit) {
      if (st) unblock(reel.container);
      return;
    }
    if (!st) { block(reel, hit, key); st = states.get(reel.container); }
    else { st.ruleId = hit.rule ? hit.rule.id : null; st.reason = hit.reason; st.key = key; st.video = reel.video; }
    silence(reel.video);
    if (isActive && settings.autoSkip) maybeSkip(st, reel);
  }

  function debugReport(reel, fp, hit, key, isActive) {
    P.setDebugOutline(reel.container, isActive);
    const sig = key + (hit ? hit.reason : '');
    if (lastDebugKey.get(reel.container) === sig) return;
    lastDebugKey.set(reel.container, sig);
    console.log('[reel-ad-blocker]', isActive ? 'active reel' : 'other reel', {
      summary: F.summarize(fp), sponsored: fp.sponsored, cta: fp.cta, advertiser: fp.advertiser,
      domains: fp.domains, reelId: fp.reelId, caption: fp.caption && fp.caption.norm,
      match: hit && hit.reason, container: reel.container
    });
  }

  // ---- Scan loop ----------------------------------------------------------------------------

  let scanQueued = false;
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  function scan() {
    scanQueued = false;
    if (!ext.runtime || !ext.runtime.id) return; // extension was reloaded; this copy is orphaned
    updateFab();
    if (!settings.enabled || !P.isReelPage()) { releaseAll(); return; }

    const reels = P.findReels();
    const active = P.activeReel(reels);
    const mounted = new Set(reels.map((r) => r.container));
    for (const c of Array.from(blockedNow)) if (!mounted.has(c) || !c.isConnected) unblock(c);
    for (const r of reels) evaluate(r, r === active);
    noteProgress(active);
    updateBanner(active);
  }

  // ---- The button -----------------------------------------------------------------------------

  async function markCurrentAsAd() {
    if (!P.isReelPage()) return toast('Open a reel first.');
    const active = P.activeReel(P.findReels());
    if (!active) return toast('No reel found on screen.');

    const raw = P.collectRaw(active.container);
    const fp = F.buildFingerprint(raw);
    if (!F.hasSignals(fp)) {
      console.warn('[reel-ad-blocker] nothing identifiable in this reel', raw, active.container);
      return toast("Couldn't read anything identifying from this reel, so no rule was saved. " +
        'Turn on debug mode in the extension settings to see what was captured.');
    }

    allowed.delete(active.container);
    const existing = F.findMatch(fp, rules);
    if (existing) {
      scan();
      return toast('Already covered by the rule for ' + F.ruleLabel(existing.rule) + '.');
    }

    const rule = F.ruleFromFingerprint(fp);
    await saveRule(rule);
    scan();
    toast('Ad blocked: ' + F.summarize(fp), async () => {
      await deleteRule(rule.id);
      allowed.set(active.container, F.fingerprintKey(fp));
      scan();
    });
  }

  function isEditable(el) {
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  // ---- Boot ---------------------------------------------------------------------------------

  async function init() {
    await load();
    buildUi();

    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.rules) rules = changes.rules.newValue || [];
      if (changes.settings) settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue);
      scheduleScan();
    });

    document.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyX' && !isEditable(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        markCurrentAsAd();
      }
    }, true);

    // Media events don't bubble, so listen in the capture phase.
    document.addEventListener('play', (e) => {
      const v = e.target;
      if (v instanceof HTMLVideoElement && v.closest(BLOCKED_SELECTOR)) pauseUnlessFighting(v);
      scheduleScan();
    }, true);
    document.addEventListener('loadeddata', scheduleScan, true);

    // Changes to our own banner/toast are not page activity. Reacting to them would re-scan, which
    // updates the banner, which re-scans... forever.
    new MutationObserver((records) => {
      if (records.every((r) => ui.root.contains(r.target))) return;
      scheduleScan();
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(scan, SCAN_EVERY_MS); // also catches SPA URL changes, which fire no DOM event of their own
    scan();
  }

  init().catch((err) => console.error('[reel-ad-blocker] failed to start', err));
})();
