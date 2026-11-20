// Shared setup for the browser tests: builds a test copy of the extension (also allowed to run on the
// local fixture server), starts the server, and launches Chromium or Firefox (BROWSER=firefox) with it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.readFileSync(path.join(root, 'test/fixture/reels.html'));

export const results = { failures: 0 };
export const errors = [];
// ---- Build a test copy of the extension that also runs on the local fixture server ----------
export const extDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fbab-ext-')));
for (const f of ['src', 'icons', 'manage.html', 'manage.css', 'manage.js']) fs.cpSync(path.join(root, f), path.join(extDir, f), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
// Chromium derives an unpacked extension's id from its path.
const extId = [...crypto.createHash('sha256').update(extDir).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

export const isFirefox = process.env.BROWSER === 'firefox';
// Firefox gives every install a random moz-extension:// UUID; pin it so the manage page has a known URL.
const FIREFOX_UUID = '5b1a7c3e-0d2f-4c64-9a8e-3f7d1e2b4a60';
export const extOrigin = isFirefox ? `moz-extension://${FIREFOX_UUID}` : `chrome-extension://${extId}`;

const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(fixture); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
export const base = `http://127.0.0.1:${server.address().port}`;

export const browser = isFirefox
  ? await puppeteer.launch({
    browser: 'firefox',
    executablePath: process.env.FIREFOX || '/usr/bin/firefox',
    headless: true,
    extraPrefsFirefox: {
      'extensions.webextensions.uuids': JSON.stringify({ [manifest.browser_specific_settings.gecko.id]: FIREFOX_UUID }),
      'media.autoplay.default': 0,
      'media.autoplay.blocking_policy': 0
    }
  })
  : await puppeteer.launch({
    executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
      '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--window-size=1000,800']
  });
if (isFirefox) await browser.installExtension(extDir);

export async function step(name, fn) {
  try { await fn(); console.log('  ✔', name); }
  catch (e) { results.failures++; console.log('  ✖', name, '\n     ', String(e.message).split('\n').join('\n      ')); }
}
export const skip = (name, why) => console.log('  –', name, `(skipped: ${why})`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}
export async function cleanup() {
  await browser.close();
  server.close();
  fs.rmSync(extDir, { recursive: true, force: true });
}
