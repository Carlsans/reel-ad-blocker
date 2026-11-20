// Stress test: what does the extension do when the page fights back? Each scenario switches on one of
// the fixture's "hostile" behaviours (see test/fixture/reels.html) and measures how hard the extension
// pushes. The point is that it must never get stuck in an endless loop of its own making, even when it
// cannot get past an ad.
//
//   npm run test:hostile          BROWSER=firefox npm run test:hostile

import assert from 'node:assert/strict';
import { base, browser, cleanup, errors, results, sleep, step, until } from './harness.mjs';

const attempts = (s) => s.keys + s.nextClicks + s.scrollBursts;

async function scenario(flags, fn) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(`${base}/reel/101?hostile=${flags}`);
    await page.bringToFront();
    await until(() => page.evaluate(() => !!document.querySelector('.fbab-fab') && !!window.__stats), 'extension UI');
    await page.evaluate(() => {
      window.__uiMutations = 0;
      new MutationObserver((r) => { window.__uiMutations += r.length; })
        .observe(document.getElementById('fbab-ui'), { subtree: true, childList: true, characterData: true, attributes: true });
    });
    const api = {
      page,
      stats: () => page.evaluate(() => ({ ...window.__stats })),
      uiMutations: () => page.evaluate(() => window.__uiMutations),
      blocked: () => page.evaluate(() => Array.from(document.querySelectorAll('.reel'), (s) => s.hasAttribute('data-fbab-blocked'))),
      active: () => page.evaluate(() => Math.round(document.getElementById('feed').scrollTop / innerHeight) + 1),
      banner: () => page.evaluate(() => { const b = document.querySelector('.fbab-banner'); return b && !b.hidden ? b.textContent : ''; }),
      goTo: (id) => page.evaluate((n) => window.goTo(n), id)
    };
    await fn(api);
  } finally {
    await page.close();
  }
}

console.log('Page cannot be moved by script at all (no button, keys ignored, scrolling refused)');
await scenario('nonext,nokeys,noscroll', async (t) => {
  await t.goTo(2);
  await sleep(10000);
  const at10 = await t.stats();
  const mut10 = await t.uiMutations();
  await sleep(6000);
  const at16 = await t.stats();
  const mut16 = await t.uiMutations();

  await step('it tries a bounded number of times', () => assert.ok(attempts(at10) >= 2 && attempts(at10) <= 10, `attempts in first 10s: ${JSON.stringify(at10)}`));
  await step('then it stops trying (no attempts between 10s and 16s)', () => assert.equal(attempts(at16) - attempts(at10), 0, JSON.stringify({ at10, at16 })));
  await step('its own UI is quiet once settled (no self-triggered update loop)', () => assert.ok(mut16 - mut10 <= 2, `${mut16 - mut10} UI changes in 6s`));
  await step('the ad stays hidden and muted, and the banner says it could not skip', async () => {
    assert.deepEqual((await t.blocked()).map(Number), [0, 1, 0, 1, 1, 0]);
    assert.match(await t.banner(), /couldn.t skip/i);
  });
  await step('the user can still scroll on, and the next reel plays normally', async () => {
    await t.goTo(3);
    await until(async () => (await t.blocked()).join() === 'false,true,false,true,true,false' && (await t.banner()) === '', 'reel 3 shown');
  });
});

console.log('Player restarts any video the moment it is paused (and the ad cannot be skipped, so it stays on screen)');
await scenario('replay,nonext,nokeys,noscroll', async (t) => {
  await t.goTo(2);
  await sleep(1500);
  const a = await t.stats();
  await sleep(4000);
  const b = await t.stats();
  await step('it does not get into a pause/play fight (few pauses in 4s)', () => assert.ok(b.pauses - a.pauses <= 8, `${b.pauses - a.pauses} pauses, ${b.plays - a.plays} plays in 4s`));
  await step('the video is at least muted', async () => {
    assert.equal(await t.page.evaluate(() => document.querySelector('.reel[data-id="2"] video').muted), true);
  });
});

console.log("Page rebuilds every reel's elements twice a second, and cannot be moved by script");
await scenario('rebuild,nonext,nokeys,noscroll', async (t) => {
  await t.goTo(2);
  await sleep(10000);
  const at10 = await t.stats();
  await sleep(6000);
  const at16 = await t.stats();
  await step('rebuilding does not reset the attempt counter into an endless retry loop', () => {
    assert.ok(attempts(at10) <= 10, `attempts in first 10s: ${JSON.stringify(at10)}`);
    assert.equal(attempts(at16) - attempts(at10), 0, JSON.stringify({ at10, at16 }));
  });
});

console.log('Only some ways of moving on work');
for (const [flags, what] of [
  ['nonext,nokeys', 'scrolling works (no button, keys ignored)'],
  ['nonext,noscroll', 'keys work (no button, scrolling refused)'],
  ['nokeys,noscroll', 'only the button works'],
  ['rebuild', 'everything works but the page rebuilds constantly']
]) {
  await scenario(flags, async (t) => {
    await t.goTo(2);
    await step(`gets past the ad when ${what}`, () => until(async () => (await t.active()) === 3, 'reel 3', 6000));
  });
}

await cleanup();
const own = errors.filter((e) => /reel-ad-blocker|fbab|chrome-extension|moz-extension/i.test(e));
if (own.length) { results.failures++; console.log('  ✖ extension errors:', own); }
console.log(results.failures ? `\n${results.failures} step(s) failed` : '\nall steps passed');
process.exit(results.failures ? 1 : 0);
