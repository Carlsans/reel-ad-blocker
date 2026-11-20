'use strict';

const ext = globalThis.browser || globalThis.chrome;
const DEFAULT_SETTINGS = { enabled: true, autoSkip: true, blockSponsored: true, debug: false };
const $ = (id) => document.getElementById(id);

let rules = [];
let settings = Object.assign({}, DEFAULT_SETTINGS);
let stats = {};

function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

async function load() {
  const s = await ext.storage.local.get({ rules: [], settings: DEFAULT_SETTINGS, stats: {} });
  rules = s.rules || [];
  settings = Object.assign({}, DEFAULT_SETTINGS, s.settings);
  stats = s.stats || {};
}

const saveRules = () => ext.storage.local.set({ rules });
const saveSettings = () => ext.storage.local.set({ settings });

function ruleTitle(rule) {
  if (rule.advertiser) return rule.advertiser.name;
  if (rule.domains.length) return rule.domains[0];
  if (rule.caption) return '“' + rule.caption.norm.slice(0, 40) + '”';
  if (rule.reelId) return 'Reel ' + rule.reelId;
  return 'Empty rule';
}

function chip(text, onRemove, title) {
  const remove = h('button', { type: 'button', title: 'Stop matching on this' }, '×');
  remove.addEventListener('click', onRemove);
  return h('span', { class: 'chip', title: title || text }, h('span', {}, text), remove);
}

async function removeSignal(rule, signal, value) {
  if (signal === 'advertiser') rule.advertiser = null;
  if (signal === 'domain') rule.domains = rule.domains.filter((d) => d !== value);
  if (signal === 'caption') rule.caption = null;
  if (signal === 'reel') rule.reelId = null;
  const empty = !rule.advertiser && !rule.domains.length && !rule.caption && !rule.reelId;
  if (empty) rules = rules.filter((r) => r.id !== rule.id);
  await saveRules();
  render();
}

function ruleCard(rule) {
  const toggle = h('input', { type: 'checkbox', title: 'Enabled' });
  toggle.checked = rule.enabled !== false;
  toggle.addEventListener('change', async () => { rule.enabled = toggle.checked; await saveRules(); render(); });

  const del = h('button', { class: 'del', type: 'button' }, 'Delete');
  del.addEventListener('click', async () => { rules = rules.filter((r) => r.id !== rule.id); await saveRules(); render(); });

  const chips = h('div', { class: 'chips' });
  if (rule.advertiser) chips.append(chip('Page: ' + rule.advertiser.name, () => removeSignal(rule, 'advertiser'), rule.advertiser.key));
  for (const d of rule.domains) {
    // Domains like amazon.ca are ignored when matching (too many unrelated sellers link to them).
    const ignored = globalThis.FBAB.isGenericDomain(d);
    chips.append(chip('Links to ' + d + (ignored ? ' (ignored: too generic)' : ''), () => removeSignal(rule, 'domain', d), ignored ? d + ' is shared by too many unrelated sites to block on' : d));
  }
  if (rule.caption) chips.append(chip('Caption: ' + rule.caption.norm, () => removeSignal(rule, 'caption'), rule.caption.norm));
  if (rule.reelId) chips.append(chip('Reel ' + rule.reelId, () => removeSignal(rule, 'reel')));

  const card = h('li', { class: 'rule' + (rule.enabled === false ? ' off' : '') },
    h('div', { class: 'row' }, h('span', { class: 'title' }, ruleTitle(rule)), h('span', { class: 'row' }, toggle, del)),
    chips,
    h('div', { class: 'meta' },
      'Blocked ' + (rule.hits || 0) + '×' + (rule.lastHit ? ' · last ' + new Date(rule.lastHit).toLocaleString() : '') +
      ' · added ' + new Date(rule.createdAt).toLocaleDateString())
  );

  if (rule.advertiser) {
    const always = h('input', { type: 'checkbox' });
    always.checked = !!rule.advertiserAlways;
    always.addEventListener('change', async () => { rule.advertiserAlways = always.checked; await saveRules(); });
    card.append(h('label', { class: 'opt' }, always, "Also block this Page's reels that aren't labelled Sponsored"));
  }
  return card;
}

function render() {
  const list = $('rules');
  list.replaceChildren(...rules.map(ruleCard));
  $('count').textContent = rules.length ? '(' + rules.length + ')' : '';
  $('empty').hidden = rules.length > 0;
  for (const key of Object.keys(DEFAULT_SETTINGS)) $(key).checked = !!settings[key];
  const n = stats.sponsoredBlocked || 0;
  $('stats').textContent = 'Reels blocked automatically by the Sponsored label so far: ' + n;
}

function isValidRule(r) {
  return r && typeof r.id === 'string' && Array.isArray(r.domains) && typeof r.createdAt === 'number';
}

async function init() {
  await load();
  render();

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    $(key).addEventListener('change', () => { settings[key] = $(key).checked; saveSettings(); });
  }

  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version: 1, rules, settings }, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'reel-ad-blocker-rules.json' });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('import').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async () => {
    const file = $('file').files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = (Array.isArray(data) ? data : data.rules || []).filter(isValidRule);
      const have = new Set(rules.map((r) => r.id));
      rules = rules.concat(incoming.filter((r) => !have.has(r.id)));
      await saveRules();
      render();
    } catch (e) {
      alert('Could not read that file: ' + e.message);
    }
    $('file').value = '';
  });

  $('clear').addEventListener('click', async () => {
    if (!rules.length || !confirm('Delete all ' + rules.length + ' rules?')) return;
    rules = [];
    await saveRules();
    render();
  });

  // Hit counters change while a reel is being blocked in another tab.
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.rules) rules = changes.rules.newValue || [];
    if (changes.settings) settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue);
    if (changes.stats) stats = changes.stats.newValue || {};
    render();
  });
}

init();
