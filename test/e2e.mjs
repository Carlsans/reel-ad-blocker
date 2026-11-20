// End-to-end test: loads the unpacked extension into Chromium and drives it against the mock reel
// page in test/fixture. This proves the extension's own behaviour (button, shortcut, rule storage,
// blocking, skipping, undo, manage page). It does NOT prove it works on real facebook.com markup.
//
//   npm install && npm run test:e2e              Chromium  (CHROMIUM=/path/to/chromium to override /usr/bin/chromium)
//   BROWSER=firefox npm run test:e2e             Firefox   (FIREFOX=/path/to/firefox to override /usr/bin/firefox)

import assert from 'node:assert/strict';
import { browser, base, cleanup, errors, extOrigin, isFirefox, results, skip, sleep, step, until } from './harness.mjs';

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const reels = () => page.evaluate(() => Array.from(document.querySelectorAll('.reel'), (s) => {
    const v = s.querySelector('video');
    return { id: Number(s.dataset.id), blocked: s.hasAttribute('data-fbab-blocked'), paused: v.paused, muted: v.muted };
  }));
  const blockedIds = async () => (await reels()).filter((r) => r.blocked).map((r) => r.id);
  const activeId = () => page.evaluate(() => Math.round(document.getElementById('feed').scrollTop / innerHeight) + 1);
  const toastText = () => page.evaluate(() => { const t = document.querySelector('.fbab-toast'); return t && !t.hidden ? t.textContent : ''; });
  const bannerText = () => page.evaluate(() => { const t = document.querySelector('.fbab-banner'); return t && !t.hidden ? t.textContent : ''; });
  const pressAltX = async () => { await page.keyboard.down('Alt'); await page.keyboard.press('KeyX'); await page.keyboard.up('Alt'); };
  const goTo = (id) => page.evaluate((n) => window.goTo(n), id);
  const clickUi = (selector, text) => page.evaluate((sel, t) => {
    const el = Array.from(document.querySelectorAll('#fbab-ui ' + sel)).find((e) => !t || e.textContent.trim() === t);
    el.click();
  }, selector, text);

  // Firefox's WebDriver BiDi refuses to navigate to moz-extension:// pages, so the manage page cannot
  // be opened there; the steps that need it are skipped (see test/firefox-manage.mjs for that part).
  const MANAGE_SKIP = 'WebDriver BiDi cannot open moz-extension:// pages';
  async function manageSnapshot() {
    if (isFirefox) return null;
    const m = await browser.newPage();
    await m.goto(`${extOrigin}/manage.html`);
    await m.waitForSelector('#count, #empty');
    const snap = await m.evaluate(() => ({
      titles: Array.from(document.querySelectorAll('.rule .title'), (e) => e.textContent),
      chips: Array.from(document.querySelectorAll('.rule .chip > span'), (e) => e.textContent),
      meta: Array.from(document.querySelectorAll('.rule .meta'), (e) => e.textContent),
      always: Array.from(document.querySelectorAll('.rule .opt input'), (e) => e.checked),
      autoChecked: document.getElementById('blockSponsored').checked,
      stats: document.getElementById('stats').textContent
    }));
    await m.close();
    return snap;
  }

  console.log('Automatic blocking of Sponsored reels (defaults: no rules, no clicks)');
  await page.goto(`${base}/reel/101`);
  await page.bringToFront();
  await step('floating button appears on a reel page', () => until(
    () => page.evaluate(() => { const b = document.querySelector('.fbab-fab'); return b && !b.hidden && b.getBoundingClientRect().width > 0; }), 'button'));
  await step('reels with a scrambled Sponsored label are blocked; organic reels (even the same Page\'s) are not', async () => {
    await until(async () => (await blockedIds()).join() === '2,4,5', 'reels 2,4,5 auto-blocked');
    await sleep(1200);
    assert.deepEqual(await blockedIds(), [2, 4, 5]);
  });
  await step('the banner names the reason and "Turn off auto-block" releases every reel', async () => {
    await until(async () => {
      await goTo(2); await sleep(250);
      if (!/Sponsored label/.test(await bannerText())) return false;
      await clickUi('.fbab-link', 'Turn off auto-block');
      return true;
    }, 'banner on an auto-blocked reel', 12000);
    await until(async () => (await blockedIds()).length === 0, 'reels released');
    assert.match(await toastText(), /no longer blocked automatically/);
  });

  console.log('Teaching it by hand (labels hidden, so only learned rules can match)');
  await page.goto(`${base}/reel/101?labels=0`);
  await page.bringToFront();
  await step('nothing is blocked before any rule exists', async () => {
    await sleep(1200);
    assert.deepEqual(await blockedIds(), []);
  });

  console.log('Marking an ad with Alt+X');
  await goTo(2);
  await until(async () => (await activeId()) === 2, 'scroll to reel 2');
  await sleep(500);
  await pressAltX();
  await step('toast reports what was captured', async () => {
    const t = await until(toastText, 'toast');
    assert.match(t, /Ad blocked: Acme Shoes/);
    assert.match(t, /acme-shoes\.co\.uk/);
  });
  await step('every mounted look-alike is blocked, organic reels are left alone', async () => {
    // 2 = the marked ad, 4 = same page + Sponsored (new creative), 5 = other page linking to the same domain
    await until(async () => (await blockedIds()).join() === '2,4,5', 'reels 2,4,5 blocked');
    assert.ok(!(await blockedIds()).includes(1) && !(await blockedIds()).includes(3) && !(await blockedIds()).includes(6));
  });
  await step('blocked videos are paused and muted', async () => {
    for (const r of (await reels()).filter((x) => x.blocked)) { assert.ok(r.paused, `reel ${r.id} paused`); assert.ok(r.muted, `reel ${r.id} muted`); }
  });
  await step('auto-skip moves past the blocked reel to the next organic one', async () => {
    await until(async () => (await activeId()) === 3, 'skip 2 -> 3');
  });

  console.log('Future ads are caught without any click');
  await step('scrolling onto a blocked reel skips it, and the next blocked one, to reel 6', async () => {
    await goTo(4);
    await until(async () => (await activeId()) === 6, 'skip 4 -> 5 -> 6', 12000);
    assert.deepEqual(await blockedIds(), [2, 4, 5]);
  });
  await step('the organic reel from the same advertiser is still playable', async () => {
    await goTo(3); await sleep(1500);
    const r3 = (await reels()).find((r) => r.id === 3);
    assert.equal(r3.blocked, false);
    assert.equal(r3.paused, false);
  });

  console.log('Escape hatches');
  await step('"Show anyway" reveals a reel and it stays revealed', async () => {
    await goTo(2);
    await until(async () => /Ad blocked \(.+\)/.test(await bannerText()), 'banner');
    await page.evaluate(() => document.getElementById('feed').scrollTo(0, innerHeight)); // stay on reel 2 if skipped away
    await goTo(2);
    await clickUi('.fbab-link', 'Show anyway');
    await until(async () => !(await blockedIds()).includes(2), 'reel 2 revealed');
    await sleep(2500);
    assert.ok(!(await blockedIds()).includes(2), 'reel 2 re-blocked itself');
  });

  if (isFirefox) skip('manage page lists one rule with the captured signals', MANAGE_SKIP);
  else await step('manage page lists one rule with the captured signals', async () => {
    const s = await manageSnapshot();
    assert.deepEqual(s.titles, ['Acme Shoes']);
    assert.ok(s.chips.includes('Page: Acme Shoes'));
    assert.ok(s.chips.includes('Links to acme-shoes.co.uk'));
    assert.ok(s.chips.some((c) => c.startsWith('Caption: our summer sale')));
    assert.match(s.meta[0], /Blocked [1-9]\d*×/);
    assert.deepEqual(s.always, [false], 'advertiser needs Sponsored/CTA because the marked ad had a call-to-action button');
    assert.equal(s.autoChecked, false, 'auto-block was turned off from the banner');
    assert.ok(Number(s.stats.match(/(\d+)$/)[1]) >= 3, 'counter: ' + s.stats);
  });

  await step('marking an unlabelled organic reel blocks its Page outright, and Undo reverts it', async () => {
    await goTo(6);
    await until(async () => (await activeId()) === 6, 'reel 6');
    await sleep(800);
    await pressAltX();
    await until(async () => (await blockedIds()).includes(6), 'reel 6 blocked');
    assert.match(await toastText(), /Cooking Club/);
    await clickUi('.fbab-link', 'Undo');
    await until(async () => !(await blockedIds()).includes(6), 'reel 6 restored');
    const s = await manageSnapshot();
    if (s) assert.deepEqual(s.titles, ['Acme Shoes'], 'undo removed the rule');
  });

  if (isFirefox) skip('disabling the extension from the manage page releases everything', MANAGE_SKIP);
  else await step('disabling the extension from the manage page releases everything', async () => {
    const m = await browser.newPage();
    await m.goto(`${extOrigin}/manage.html`);
    await m.click('#enabled');
    await until(async () => (await blockedIds()).length === 0, 'all released');
    await m.click('#enabled');
    await until(async () => (await blockedIds()).length > 0, 're-enabled');
    await m.close();
  });

  console.log('Failure paths');
  await step('a reel with nothing identifiable saves no rule and says so', async () => {
    await page.evaluate(() => { document.querySelector('.reel[data-id="1"] .overlay').remove(); });
    await goTo(1); await sleep(600);
    await pressAltX();
    assert.match(await until(toastText, 'toast'), /Couldn't read anything identifying/);
    const s = await manageSnapshot();
    if (s) assert.deepEqual(s.titles, ['Acme Shoes']);
  });

  await step('no extension errors were logged', () => {
    const own = errors.filter((e) => /reel-ad-blocker|fbab|chrome-extension|moz-extension/i.test(e));
    assert.deepEqual(own, []);
  });
} finally {
  await cleanup();
}

console.log(results.failures ? `\n${results.failures} step(s) failed` : '\nall steps passed');
process.exit(results.failures ? 1 : 0);
