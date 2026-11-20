/*
 * Fingerprinting and matching. Pure functions only: no DOM, no storage.
 * Loaded as a content script (attaches to globalThis.FBAB) and from Node tests (module.exports).
 *
 * A "fingerprint" describes one reel using signals that survive Facebook's obfuscated,
 * constantly-changing CSS class names: who posted it, where it links, what the caption says.
 * A "rule" is a saved fingerprint. A reel is blocked when a new fingerprint matches any rule.
 */
(function (root) {
  'use strict';

  // ---- Tunables -----------------------------------------------------------------------------

  const CAPTION_THRESHOLD = 0.7;   // share of the shorter caption's shingles found in the other
  const MIN_SHINGLES = 5;          // below this a caption is too short for fuzzy matching
  const MIN_CAPTION_WORDS = 4;     // lines shorter than this are UI chrome, not caption
  const MAX_CAPTION_LINES = 2;
  const MAX_CAPTION_CHARS = 300;

  // Facebook's own hosts: never an advertiser's destination.
  const FB_HOST_RE = /(^|\.)(facebook\.com|fb\.com|fb\.watch|fbcdn\.net|messenger\.com|instagram\.com|meta\.com)$/i;

  // Destinations too broad to block on: the link says nothing about WHO is advertising. Platforms and
  // shorteners (an app-store link), plus marketplaces and site builders that thousands of unrelated
  // sellers, creators and affiliates link to.
  const GENERIC_DOMAINS = new Set([
    'apple.com', 'goo.gl', 'wa.me', 'whatsapp.com', 'tiktok.com', 'twitter.com', 'x.com',
    'wikipedia.org', 'spotify.com', 'linkedin.com', 'lnkd.in', 'youtu.be', 'amzn.com',
    'bit.ly', 'tinyurl.com', 't.co', 'ow.ly', 'rebrand.ly', 'linktr.ee', 'a.co', 'amzn.to',
    'myshopify.com', 'forms.gle'
  ]);
  // Same, matched on the name alone so every country variant counts (amazon.ca, amazon.co.uk, ...).
  const GENERIC_NAMES = new Set([
    'google', 'youtube', 'amazon', 'amzn', 'ebay', 'etsy', 'aliexpress', 'alibaba', 'shopify',
    'wixsite', 'squarespace', 'gofundme', 'patreon', 'eventbrite'
  ]);

  const MULTI_PART_TLDS = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in',
    'com.br', 'com.mx', 'com.ar', 'co.za', 'com.tr', 'com.cn', 'com.hk', 'com.sg', 'co.kr', 'com.tw'
  ]);

  // First path segments on facebook.com that are not a Page or profile.
  const RESERVED_PATHS = new Set([
    'reel', 'reels', 'watch', 'hashtag', 'groups', 'events', 'marketplace', 'gaming', 'stories',
    'story.php', 'photo', 'photo.php', 'permalink.php', 'share', 'sharer', 'sharer.php', 'login',
    'help', 'policies', 'ads', 'business', 'privacy', 'settings', 'notifications', 'friends',
    'bookmarks', 'pages', 'search', 'video.php', 'videos', 'l.php', 'dialog', 'plugins', 'messages',
    'direct', 'live', 'fundraisers', 'saved', 'memories', 'ad_center', 'places', 'recommendations',
    'lite', 'about', 'home.php', 'composer', 'ufi', 'reaction', 'comment', 'checkpoint', 'recover'
  ]);
  const PAGE_SUBPATHS = new Set(['posts', 'videos', 'reels', 'about', 'photos', 'videos_by', 'community']);

  // The "Sponsored" label in the languages Facebook is most often used in. Compared after
  // normalizeText(), which lowercases and strips accents ("Commandité" -> "commandite").
  const SPONSORED_WORDS = new Set([
    'sponsored', 'sponsorise', 'commandite', 'publicidad', 'patrocinado', 'gesponsert', 'sponsorizzato',
    'gesponsord', 'sponsrad', 'sponsoreret', 'sponsoroitu', 'sponsorowane', 'reklam', 'sponsorlu',
    'реклама', 'спонсировано', '广告', '廣告', '贊助', '赞助', '広告', '광고', 'إعلان', 'प्रायोजित'
  ]);

  // Call-to-action button labels, normalized. Only used as supporting evidence that a reel is an ad.
  const CTA_LABELS = new Set([
    'shop now', 'learn more', 'install now', 'install', 'sign up', 'book now', 'download', 'get offer',
    'order now', 'watch more', 'apply now', 'contact us', 'send message', 'get quote', 'play game',
    'use app', 'get directions', 'call now', 'see menu', 'listen now', 'donate now', 'get started',
    'buy now', 'open link', 'send whatsapp message', 'get showtimes',
    'en savoir plus', 'acheter', 'acheter maintenant', 'magasiner', 'magasinez', 'installer',
    'installer maintenant', 's inscrire', 'reserver', 'reserver maintenant', 'telecharger',
    'commander', 'commander maintenant', 'nous contacter', 'envoyer un message', 'appeler',
    'obtenir l offre', 'jouer', 'utiliser l application'
  ]);

  const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/;
  const AUDIO_LINE_RE = /^(original audio|audio original|son original|original sound)\b/;

  // ---- Text ---------------------------------------------------------------------------------

  function normalizeText(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function wordCount(norm) {
    if (!norm) return 0;
    return CJK_RE.test(norm) ? Math.ceil(norm.replace(/\s/g, '').length / 2) : norm.split(' ').length;
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // Hashed word 3-grams (character 4-grams for CJK text). Hashes keep storage small.
  function shingleHashes(norm) {
    const cjk = CJK_RE.test(norm);
    const tokens = cjk ? Array.from(norm.replace(/\s+/g, '')) : norm.split(' ').filter(Boolean);
    const size = cjk ? 4 : 3;
    const joiner = cjk ? '' : ' ';
    const out = new Set();
    if (tokens.length && tokens.length < size) out.add(fnv1a(tokens.join(joiner)));
    for (let i = 0; i + size <= tokens.length; i++) out.add(fnv1a(tokens.slice(i, i + size).join(joiner)));
    return Array.from(out).sort((a, b) => a - b);
  }

  // ---- Individual signals -------------------------------------------------------------------

  function isSponsoredNorm(norm) {
    if (!norm) return false;
    const words = norm.split(' ');
    // "Sponsored", "Sponsored · Paid for by X": short lines that open with the label.
    return words.length <= 6 && SPONSORED_WORDS.has(words[0]);
  }

  function isSponsoredLine(line) {
    return isSponsoredNorm(normalizeText(line));
  }

  function findCta(lines) {
    for (const line of lines) {
      const norm = normalizeText(line);
      if (CTA_LABELS.has(norm)) return norm;
    }
    return null;
  }

  function isFbHost(host) {
    return FB_HOST_RE.test(host);
  }

  function registrableDomain(host) {
    const h = String(host).toLowerCase().replace(/\.$/, '');
    if (/^\d+(\.\d+){3}$/.test(h)) return h;
    const labels = h.split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    const last2 = labels.slice(-2).join('.');
    return MULTI_PART_TLDS.has(last2) ? labels.slice(-3).join('.') : last2;
  }

  // Facebook wraps outbound links as l.facebook.com/l.php?u=<real url>. Returns the real URL.
  function linkTarget(href) {
    let u;
    try { u = new URL(href, 'https://www.facebook.com'); } catch (e) { return null; }
    if (/^(l|lm)\.(facebook|instagram)\.com$/i.test(u.hostname)) {
      const target = u.searchParams.get('u');
      if (!target) return null;
      try { u = new URL(target); } catch (e) { return null; }
    }
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  }

  function isGenericDomain(domain) {
    return GENERIC_DOMAINS.has(domain) || GENERIC_NAMES.has(String(domain).split('.')[0]);
  }

  // Destination domain of an outbound link, or null if internal / too generic to be useful.
  function linkDomain(href) {
    const u = linkTarget(href);
    if (!u || isFbHost(u.hostname)) return null;
    const d = registrableDomain(u.hostname);
    return isGenericDomain(d) ? null : d;
  }

  // Stable identity of the Page/profile an anchor points at, or null if it is not one.
  function advertiserKey(href) {
    let u;
    try { u = new URL(href, 'https://www.facebook.com'); } catch (e) { return null; }
    if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    const first = seg[0].toLowerCase();
    if (first === 'profile.php') {
      const id = u.searchParams.get('id');
      return id ? 'id:' + id : null;
    }
    if (first === 'people' && /^\d+$/.test(seg[2] || '')) return 'id:' + seg[2];
    if (first === 'p') {
      const m = /-(\d{6,})$/.exec(seg[1] || '');
      return m ? 'id:' + m[1] : null;
    }
    if (RESERVED_PATHS.has(first)) return null;
    if (seg.length > 1 && !PAGE_SUBPATHS.has(seg[1].toLowerCase())) return null;
    return first;
  }

  function findAdvertiser(anchors) {
    for (const a of anchors) {
      const name = String(a.text || '').replace(/\s+/g, ' ').trim();
      if (!name || name.length > 80) continue;
      const key = advertiserKey(a.href);
      if (key) return { key, name };
    }
    return null;
  }

  // Only trust a reel id when the reel's own subtree points at exactly one reel.
  function findReelId(anchors) {
    const ids = new Set();
    for (const a of anchors) {
      const m = /\/reel\/(\d+)/.exec(a.href || '');
      if (m) ids.add(m[1]);
    }
    return ids.size === 1 ? Array.from(ids)[0] : null;
  }

  function captionFingerprint(lines) {
    const picked = [];
    for (const line of lines) {
      const norm = normalizeText(line);
      if (!norm || wordCount(norm) < MIN_CAPTION_WORDS) continue;
      if (isSponsoredNorm(norm) || AUDIO_LINE_RE.test(norm)) continue;
      picked.push(norm);
      if (picked.length === MAX_CAPTION_LINES) break;
    }
    if (!picked.length) return null;
    const norm = picked.join(' ').slice(0, MAX_CAPTION_CHARS).trim();
    const shingles = shingleHashes(norm);
    // Too short to tell an ad from page chrome ("Create a new reel"): unsafe to match on.
    if (shingles.length < MIN_SHINGLES) return null;
    return { norm, words: wordCount(norm), shingles };
  }

  function captionSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a.norm === b.norm) return 1;
    if (a.shingles.length < MIN_SHINGLES || b.shingles.length < MIN_SHINGLES) return 0;
    const set = new Set(b.shingles);
    let common = 0;
    for (const h of a.shingles) if (set.has(h)) common++;
    return common / Math.min(a.shingles.length, b.shingles.length);
  }

  // ---- Fingerprint --------------------------------------------------------------------------

  /**
   * raw = { lines: string[]   visible text of the reel, one entry per line (innerText split on \n)
   *         anchors: [{ href, text }] }   every link inside the reel
   */
  function buildFingerprint(raw) {
    const lines = (raw.lines || []).map((l) => String(l).trim()).filter(Boolean);
    const anchors = raw.anchors || [];
    const domains = [];
    for (const a of anchors) {
      const d = linkDomain(a.href);
      if (d && !domains.includes(d)) domains.push(d);
    }
    return {
      sponsored: lines.some(isSponsoredLine),
      cta: findCta(lines),
      advertiser: findAdvertiser(anchors),
      domains,
      reelId: findReelId(anchors),
      caption: captionFingerprint(lines)
    };
  }

  function hasSignals(fp) {
    return !!(fp.advertiser || fp.domains.length || fp.reelId || fp.caption);
  }

  // Identifies "this particular reel" so a "Show anyway" decision sticks to it only.
  function fingerprintKey(fp) {
    return [fp.advertiser && fp.advertiser.key, fp.reelId, fp.caption && fp.caption.norm.slice(0, 60)].join('|');
  }

  function summarize(fp) {
    const parts = [];
    if (fp.advertiser) parts.push(fp.advertiser.name);
    if (fp.domains.length) parts.push(fp.domains.slice(0, 2).join(', '));
    if (fp.caption) parts.push('caption (' + fp.caption.words + ' words)');
    if (fp.reelId) parts.push('reel ' + fp.reelId);
    return parts.join(' · ') || 'unidentified reel';
  }

  // ---- Rules --------------------------------------------------------------------------------

  function newId() {
    const c = root.crypto;
    return c && c.randomUUID ? c.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function ruleFromFingerprint(fp, now) {
    const adLike = fp.sponsored || !!fp.cta;
    return {
      id: newId(),
      createdAt: now || Date.now(),
      enabled: true,
      hits: 0,
      lastHit: null,
      advertiser: fp.advertiser ? { key: fp.advertiser.key, name: fp.advertiser.name } : null,
      // If the reel the user flagged shows no ad markers at all, requiring markers on future
      // reels would mean the advertiser signal can never fire. Trust the user and match outright.
      advertiserAlways: !!fp.advertiser && !adLike,
      domains: fp.domains.slice(),
      reelId: fp.reelId,
      caption: fp.caption ? { norm: fp.caption.norm, words: fp.caption.words, shingles: fp.caption.shingles.slice() } : null,
      cta: fp.cta,
      wasSponsored: fp.sponsored
    };
  }

  function ruleHasSignals(rule) {
    return !!(rule.advertiser || (rule.domains && rule.domains.length) || rule.reelId || rule.caption);
  }

  function ruleLabel(rule) {
    if (rule.advertiser) return rule.advertiser.name;
    if (rule.domains && rule.domains.length) return rule.domains[0];
    if (rule.caption) return '"' + rule.caption.norm.slice(0, 40) + '"';
    if (rule.reelId) return 'reel ' + rule.reelId;
    return 'empty rule';
  }

  /**
   * Returns a human-readable reason if the fingerprint matches the rule, otherwise null.
   *
   * Reel id, destination domain and near-identical caption each match on their own.
   * The advertiser alone is not enough, because a Page's organic reels share its name with its ads;
   * it must be accompanied by a "Sponsored" label or a call-to-action button (unless the rule says
   * advertiserAlways).
   */
  function matchRule(fp, rule) {
    if (!rule || rule.enabled === false) return null;
    if (rule.reelId && fp.reelId === rule.reelId) return 'same reel';
    if (rule.domains && rule.domains.length) {
      // Re-check genericness here too, so rules saved before a domain was classed as generic stop matching on it.
      const hit = fp.domains.find((d) => rule.domains.includes(d) && !isGenericDomain(d));
      if (hit) return 'links to ' + hit;
    }
    if (rule.caption && fp.caption) {
      const sim = captionSimilarity(rule.caption, fp.caption);
      if (sim >= CAPTION_THRESHOLD) return 'similar caption (' + Math.round(sim * 100) + '%)';
    }
    if (rule.advertiser && fp.advertiser && rule.advertiser.key === fp.advertiser.key) {
      if (rule.advertiserAlways || fp.sponsored || fp.cta) return 'advertiser ' + rule.advertiser.name;
    }
    return null;
  }

  function findMatch(fp, rules) {
    for (const rule of rules || []) {
      const reason = matchRule(fp, rule);
      if (reason) return { rule, reason };
    }
    return null;
  }

  const api = {
    CAPTION_THRESHOLD, normalizeText, shingleHashes, captionFingerprint, captionSimilarity,
    isSponsoredLine, findCta, registrableDomain, linkDomain, isGenericDomain, advertiserKey, buildFingerprint,
    hasSignals, fingerprintKey, summarize, ruleFromFingerprint, ruleHasSignals, ruleLabel,
    matchRule, findMatch
  };

  root.FBAB = Object.assign(root.FBAB || {}, api);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
