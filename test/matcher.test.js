'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/matcher.js');

const wrap = (u) => 'https://l.facebook.com/l.php?u=' + encodeURIComponent(u) + '&h=AT0abc';

// A realistic-looking sponsored reel as the DOM layer would hand it over.
function adReel(overrides = {}) {
  return {
    lines: [
      'Acme Shoes', 'Sponsored', 'Follow',
      'Our summer sale is live now with half price on every running shoe in the store',
      'Shop now', '1.2K', '84', 'Original audio · Acme Shoes'
    ],
    anchors: [
      { href: 'https://www.facebook.com/AcmeShoes/?__tn__=-UC', text: 'Acme Shoes' },
      { href: wrap('https://www.shop.acme-shoes.co.uk/summer?utm=x'), text: 'Shop now' }
    ],
    ...overrides
  };
}

test('normalizeText strips accents, urls, punctuation', () => {
  assert.equal(M.normalizeText('  Commandité!! Voir https://x.com/a?b=1 ÇA  marche… '), 'commandite voir ca marche');
});

test('registrableDomain handles multi-part TLDs and IPs', () => {
  assert.equal(M.registrableDomain('www.shop.acme-shoes.co.uk'), 'acme-shoes.co.uk');
  assert.equal(M.registrableDomain('sub.example.com'), 'example.com');
  assert.equal(M.registrableDomain('10.0.0.1'), '10.0.0.1');
});

test('linkDomain unwraps l.facebook.com and ignores internal / generic links', () => {
  assert.equal(M.linkDomain(wrap('https://www.shop.acme-shoes.co.uk/x')), 'acme-shoes.co.uk');
  assert.equal(M.linkDomain('https://www.example.org/page'), 'example.org');
  assert.equal(M.linkDomain('https://www.facebook.com/AcmeShoes'), null);
  assert.equal(M.linkDomain(wrap('https://apps.apple.com/app/id1')), null);
  assert.equal(M.linkDomain(wrap('https://www.youtube.com/watch?v=1')), null);
  assert.equal(M.linkDomain('mailto:a@b.com'), null);
  assert.equal(M.linkDomain('https://l.facebook.com/l.php'), null);
});

test('advertiserKey recognises pages/profiles and rejects everything else', () => {
  assert.equal(M.advertiserKey('https://www.facebook.com/AcmeShoes/?x=1'), 'acmeshoes');
  assert.equal(M.advertiserKey('/AcmeShoes/posts/123'), 'acmeshoes');
  assert.equal(M.advertiserKey('https://www.facebook.com/profile.php?id=1000123'), 'id:1000123');
  assert.equal(M.advertiserKey('https://www.facebook.com/people/Acme/61555/'), 'id:61555');
  assert.equal(M.advertiserKey('https://www.facebook.com/p/Acme-Shoes-61555123/'), 'id:61555123');
  assert.equal(M.advertiserKey('https://www.facebook.com/reel/12345'), null);
  assert.equal(M.advertiserKey('https://www.facebook.com/hashtag/sale'), null);
  assert.equal(M.advertiserKey('https://www.facebook.com/AcmeShoes/some/deep/path'), null);
  assert.equal(M.advertiserKey('https://example.com/AcmeShoes'), null);
});

test('isSponsoredLine works across languages and rejects captions that merely start with the word', () => {
  assert.ok(M.isSponsoredLine('Sponsored'));
  assert.ok(M.isSponsoredLine('Sponsored · Paid for by Acme'));
  assert.ok(M.isSponsoredLine('Commandité'));
  assert.ok(M.isSponsoredLine('Sponsorisé'));
  assert.ok(M.isSponsoredLine('Publicidad'));
  assert.ok(M.isSponsoredLine('广告'));
  assert.ok(!M.isSponsoredLine('Sponsored by my mom is the funniest thing I have seen all week long'));
  assert.ok(!M.isSponsoredLine('Not sponsored'));
});

test('buildFingerprint extracts the signals from a sponsored reel', () => {
  const fp = M.buildFingerprint(adReel());
  assert.equal(fp.sponsored, true);
  assert.equal(fp.cta, 'shop now');
  assert.deepEqual(fp.advertiser, { key: 'acmeshoes', name: 'Acme Shoes' });
  assert.deepEqual(fp.domains, ['acme-shoes.co.uk']);
  assert.equal(fp.reelId, null);
  assert.match(fp.caption.norm, /^our summer sale is live now/);
  assert.ok(!fp.caption.norm.includes('original audio'));
  assert.ok(!fp.caption.norm.includes('sponsored'));
});

test('reel id is only trusted when the subtree points at exactly one reel', () => {
  const one = M.buildFingerprint({ lines: [], anchors: [{ href: '/reel/111?s=x', text: '' }, { href: '/reel/111', text: '' }] });
  assert.equal(one.reelId, '111');
  const two = M.buildFingerprint({ lines: [], anchors: [{ href: '/reel/111', text: '' }, { href: '/reel/222', text: '' }] });
  assert.equal(two.reelId, null);
});

test('an empty reel has no signals', () => {
  assert.equal(M.hasSignals(M.buildFingerprint({ lines: ['Follow', '12', 'Like'], anchors: [] })), false);
});

// ---- Matching ---------------------------------------------------------------------------------

const ruleFrom = (raw) => M.ruleFromFingerprint(M.buildFingerprint(raw));

test('same advertiser with a new creative matches when it is sponsored', () => {
  const rule = ruleFrom(adReel());
  const next = M.buildFingerprint({
    lines: ['Acme Shoes', 'Sponsored', 'Totally different words about socks and laces and gloves', 'Learn more'],
    anchors: [{ href: '/AcmeShoes/', text: 'Acme Shoes' }]
  });
  assert.match(M.matchRule(next, rule), /advertiser Acme Shoes/);
});

test("same advertiser's organic reel is NOT blocked", () => {
  const rule = ruleFrom(adReel());
  const organic = M.buildFingerprint({
    lines: ['Acme Shoes', 'Follow', 'Behind the scenes at our factory this morning with the whole team', '340'],
    anchors: [{ href: '/AcmeShoes/', text: 'Acme Shoes' }]
  });
  assert.equal(M.matchRule(organic, rule), null);
});

test('advertiserAlways is set when the flagged reel had no ad markers, and then matches organic reels', () => {
  const flagged = {
    lines: ['Spammy Page', 'Follow', 'You will never believe what happened next in this video clip', '99'],
    anchors: [{ href: '/spammypage/', text: 'Spammy Page' }]
  };
  const rule = ruleFrom(flagged);
  assert.equal(rule.advertiserAlways, true);
  const later = M.buildFingerprint({
    lines: ['Spammy Page', 'Follow', 'Something else entirely about cooking pasta at home today'],
    anchors: [{ href: '/spammypage/', text: 'Spammy Page' }]
  });
  assert.match(M.matchRule(later, rule), /advertiser/);
});

test('a different advertiser selling through the same domain is matched by domain', () => {
  const rule = ruleFrom(adReel());
  const other = M.buildFingerprint({
    lines: ['Another Brand', 'Sponsored', 'Completely unrelated copy about gardening tools and soil'],
    anchors: [
      { href: '/AnotherBrand/', text: 'Another Brand' },
      { href: wrap('https://acme-shoes.co.uk/other'), text: 'Shop now' }
    ]
  });
  assert.match(M.matchRule(other, rule), /links to acme-shoes.co.uk/);
});

test('near-identical caption matches even from another advertiser, with no links at all', () => {
  const rule = ruleFrom(adReel());
  const copy = M.buildFingerprint({
    lines: ['Reseller Page', 'Our SUMMER sale is live now, with half price on every running shoe in the store!!! 🔥'],
    anchors: [{ href: '/resellerpage/', text: 'Reseller Page' }]
  });
  assert.match(M.matchRule(copy, rule), /similar caption/);
});

test('a truncated caption still matches', () => {
  const rule = ruleFrom(adReel());
  const cut = M.buildFingerprint({
    lines: ['Acme', 'Our summer sale is live now with half price on every running… See more'],
    anchors: []
  });
  assert.match(M.matchRule(cut, rule), /similar caption/);
});

test('unrelated reel does not match', () => {
  const rule = ruleFrom(adReel());
  const other = M.buildFingerprint({
    lines: ['Dog Videos', 'Follow', 'Wait for the part where he tries to climb the stairs backwards'],
    anchors: [{ href: '/dogvideos/', text: 'Dog Videos' }, { href: wrap('https://www.nytimes.com/x'), text: 'link' }]
  });
  assert.equal(M.matchRule(other, rule), null);
});

test('shared UI chrome does not make unrelated reels match', () => {
  const chrome = ['Home', 'Reels', 'Friends', 'Notifications', 'Menu', 'Search Facebook', 'Create a new reel'];
  const rule = ruleFrom({ lines: [...chrome, 'Acme Shoes', 'Sponsored', 'Shop now'], anchors: [{ href: '/AcmeShoes/', text: 'Acme Shoes' }] });
  assert.equal(rule.caption, null);
  const fp = M.buildFingerprint({ lines: [...chrome, 'Dog Videos', 'Follow'], anchors: [{ href: '/dogvideos/', text: 'Dog Videos' }] });
  assert.equal(M.matchRule(fp, rule), null);
});

test('exact reel id matches; disabled rules never match', () => {
  const rule = ruleFrom({ lines: [], anchors: [{ href: '/reel/777', text: '' }] });
  const fp = M.buildFingerprint({ lines: [], anchors: [{ href: '/reel/777', text: '' }] });
  assert.equal(M.matchRule(fp, rule), 'same reel');
  rule.enabled = false;
  assert.equal(M.matchRule(fp, rule), null);
});

test('findMatch returns the rule that matched', () => {
  const a = ruleFrom(adReel());
  const b = ruleFrom({ lines: [], anchors: [{ href: '/reel/777', text: '' }] });
  const hit = M.findMatch(M.buildFingerprint({ lines: [], anchors: [{ href: '/reel/777', text: '' }] }), [a, b]);
  assert.equal(hit.rule.id, b.id);
  assert.equal(M.findMatch(M.buildFingerprint({ lines: [], anchors: [] }), [a, b]), null);
});

test('rules survive a JSON round trip (they live in extension storage)', () => {
  const rule = ruleFrom(adReel());
  const copy = JSON.parse(JSON.stringify(rule));
  assert.match(M.matchRule(M.buildFingerprint(adReel()), copy), /./);
});

test('CJK captions are fingerprinted with character n-grams', () => {
  const cap = M.captionFingerprint(['今日だけの特別セール全品半額で販売中です']);
  assert.ok(cap.shingles.length >= 5);
  const same = M.captionFingerprint(['今日だけの特別セール全品半額で販売中です!!']);
  assert.ok(M.captionSimilarity(cap, same) >= 0.9);
});

// ---- Generic destinations (found from real exported rules) ------------------------------------

test('marketplaces and site builders are never used as a destination signal, in any country', () => {
  for (const u of ['https://www.amazon.ca/dp/B0', 'https://www.amazon.co.uk/x', 'https://www.ebay.com/itm/1',
    'https://store.myshopify.com/p', 'https://www.etsy.com/shop/x', 'https://amzn.to/3abc', 'https://www.google.ca/']) {
    assert.equal(M.linkDomain(wrap(u)), null, u);
  }
  assert.equal(M.isGenericDomain('amazon.ca'), true);
  assert.equal(M.isGenericDomain('amazon-fan-club.com'), false);
});

test('ad-serving and shopping-link services stay usable as signals', () => {
  assert.equal(M.linkDomain(wrap('https://ad.doubleclick.net/ddm/clk/1')), 'doubleclick.net');
  assert.equal(M.linkDomain(wrap('https://mikmak.ai/x')), 'mikmak.ai');
});

test('a rule saved earlier with a now-generic domain no longer matches on it', () => {
  const stale = M.ruleFromFingerprint(M.buildFingerprint(adReel()));
  stale.domains = ['amazon.ca'];        // as stored by version 0.1.0 for the Aveeno ad
  stale.caption = null;
  stale.advertiser = null;
  const organic = { sponsored: false, cta: null, advertiser: null, domains: ['amazon.ca'], reelId: null, caption: null };
  assert.equal(M.matchRule(organic, stale), null);
});
