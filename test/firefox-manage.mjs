// Checks the manage page (popup / options page) in real Firefox via geckodriver, because puppeteer's
// WebDriver BiDi cannot open moz-extension:// pages. Needs `geckodriver` and `firefox` on the system.
//
//   node test/firefox-manage.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = createRequire(import.meta.url)('../src/matcher.js');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const EXT_PATH = process.env.EXT_PATH || root; // e.g. a packaged .zip/.xpi
const UUID = '5b1a7c3e-0d2f-4c64-9a8e-3f7d1e2b4a60';
const PORT = 4444 + Math.floor(Math.random() * 500);
const api = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const driver = spawn('geckodriver', ['--port', String(PORT), '--allow-system-access'], { stdio: 'ignore' });
let session;
async function call(method, url, body) {
  const res = await fetch(api + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const json = await res.json();
  if (json.value && json.value.error) throw new Error(`${json.value.error}: ${json.value.message}`);
  return json.value;
}
const run = (script, ...args) => call('POST', `/session/${session}/execute/async`, {
  script: `const done = arguments[arguments.length - 1]; (async () => { ${script} })().then(done, (e) => done({ __error: String(e) }));`,
  args
}).then((v) => { if (v && v.__error) throw new Error(v.__error); return v; });

let failures = 0;
async function step(name, fn) {
  try { await fn(); console.log('  ✔', name); } catch (e) { failures++; console.log('  ✖', name, '\n     ', e.message); }
}

try {
  for (let i = 0; i < 50; i++) { try { await fetch(api + '/status'); break; } catch { await sleep(100); } }
  session = (await call('POST', '/session', {
    capabilities: { alwaysMatch: {
      browserName: 'firefox',
      'moz:firefoxOptions': {
        binary: process.env.FIREFOX || '/usr/bin/firefox',
        args: ['-headless'],
        prefs: { 'extensions.webextensions.uuids': JSON.stringify({ [manifest.browser_specific_settings.gecko.id]: UUID }) }
      }
    } }
  })).sessionId;

  await call('POST', `/session/${session}/moz/addon/install`, { path: EXT_PATH, temporary: true });
  const url = `moz-extension://${UUID}/manage.html`;
  // WebDriver refuses to navigate to moz-extension:// pages, so open the tab from privileged browser code.
  const before = await call('GET', `/session/${session}/window/handles`);
  await call('POST', `/session/${session}/moz/context`, { context: 'chrome' });
  await call('POST', `/session/${session}/execute/sync`, {
    script: 'gBrowser.selectedTab = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });',
    args: [url]
  });
  await call('POST', `/session/${session}/moz/context`, { context: 'content' });
  const handle = await (async () => { for (let i = 0; i < 50; i++) { const now = await call('GET', `/session/${session}/window/handles`); const h = now.find((x) => !before.includes(x)); if (h) return h; await sleep(100); } throw new Error('extension tab never opened'); })();
  await call('POST', `/session/${session}/window`, { handle });

  const fp = M.buildFingerprint({
    lines: ['Acme Shoes', 'Sponsored', 'Our summer sale is live now with half price on every running shoe', 'Shop now'],
    anchors: [{ href: 'https://www.facebook.com/AcmeShoes/', text: 'Acme Shoes' },
      { href: 'https://l.facebook.com/l.php?u=' + encodeURIComponent('https://acme-shoes.co.uk/x'), text: 'Shop now' }]
  });
  const rule = M.ruleFromFingerprint(fp);
  // A rule saved by version 0.1.0 for a real Aveeno ad, whose domain is now classed as too generic.
  const stale = M.ruleFromFingerprint(M.buildFingerprint({
    lines: ['Aveeno', 'Commandité', 'Acheter'],
    anchors: [{ href: 'https://www.facebook.com/aveenocanada/', text: 'Aveeno' }]
  }));
  stale.domains = ['amazon.ca'];
  await run(`await browser.storage.local.set(${JSON.stringify({ rules: [rule, stale], stats: { sponsoredBlocked: 7 } })})`);

  const snap = () => run(`
    await new Promise((r) => setTimeout(r, 300));
    const q = (s) => Array.from(document.querySelectorAll(s), (e) => e.textContent);
    const st = await browser.storage.local.get({ rules: [], settings: {} });
    return { titles: q('.rule .title'), chips: q('.rule .chip > span'), emptyShown: !document.getElementById('empty').hidden, st };`);

  console.log('Manage page in Firefox');
  await step('renders a stored rule with its signals', async () => {
    await run('location.reload();');
    await sleep(800);
    const s = await snap();
    assert.deepEqual(s.titles, ['Acme Shoes', 'Aveeno']);
    assert.ok(s.chips.includes('Page: Acme Shoes'));
    assert.ok(s.chips.includes('Links to acme-shoes.co.uk'));
  });
  await step('a stored domain that is now too generic is shown as ignored', async () => {
    assert.ok((await snap()).chips.includes('Links to amazon.ca (ignored: too generic)'));
  });
  await step('shows the auto-block setting (on by default) and the counter', async () => {
    const r = await run(`return { on: document.getElementById('blockSponsored').checked, stats: document.getElementById('stats').textContent };`);
    assert.equal(r.on, true);
    assert.match(r.stats, /: 7$/);
  });
  await step('turning auto-block off is saved', async () => {
    await run(`document.getElementById('blockSponsored').click();`);
    assert.equal((await snap()).st.settings.blockSponsored, false);
  });
  await step('settings checkboxes persist to storage', async () => {
    await run(`document.getElementById('autoSkip').click();`);
    assert.equal((await snap()).st.settings.autoSkip, false);
  });
  await step('removing a chip edits the rule', async () => {
    await run(`Array.from(document.querySelectorAll('.chip')).find((c) => c.textContent.startsWith('Links to acme')).querySelector('button').click();`);
    const s = await snap();
    assert.ok(!s.chips.includes('Links to acme-shoes.co.uk'));
    assert.deepEqual(s.st.rules[0].domains, []);
  });
  await step('the enable toggle is saved', async () => {
    await run(`document.querySelector('.rule input[type=checkbox]').click();`);
    assert.equal((await snap()).st.rules[0].enabled, false);
  });
  await step('delete removes rules until the list is empty', async () => {
    await run(`document.querySelector('.rule .del').click();`);
    assert.deepEqual((await snap()).titles, ['Aveeno']);
    await run(`document.querySelector('.rule .del').click();`);
    const s = await snap();
    assert.deepEqual(s.titles, []);
    assert.equal(s.emptyShown, true);
  });
} finally {
  if (session) await call('DELETE', `/session/${session}`).catch(() => {});
  driver.kill();
}
console.log(failures ? `\n${failures} step(s) failed` : '\nall steps passed');
process.exit(failures ? 1 : 0);
