/*
 * Everything that touches Facebook's DOM lives here, so the part most likely to need tuning
 * when Facebook changes its markup is in one place. Facebook's class names are obfuscated and
 * rotate, so this relies only on structure: <video> elements, links, and rendered text.
 */
(function (root) {
  'use strict';

  const F = (root.FBAB = root.FBAB || {});

  const REEL_PATH_RE = /^\/(reel|reels|watch)(\/|$)/;
  // Never climb out of (or into) these landmarks when looking for the per-reel wrapper.
  const BOUNDARY_ROLES = new Set(['main', 'banner', 'navigation', 'complementary', 'dialog']);
  // aria-labels of the "next reel" arrow: "Next card", "Next", "Carte suivante", "Suivant", ...
  const NEXT_LABEL_RE = /^(next\b|.*\bnext (card|reel|video)\b|suivant|.*\b(carte|vid[eé]o|reel) suivante?\b|prochain)/i;
  const MAX_LABEL_LENGTH = 40;
  const MIN_VIDEO_SIZE = 200;

  function isReelPage() {
    return REEL_PATH_RE.test(location.pathname);
  }

  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /**
   * The per-reel wrapper: the largest ancestor of the video that still contains only that one
   * video and is no bigger than the viewport. The caption, advertiser link and call-to-action
   * button all live inside it, whatever their class names are this week.
   */
  function reelContainer(video) {
    let best = video;
    for (let el = video.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (BOUNDARY_ROLES.has(el.getAttribute('role') || '')) break;
      const r = el.getBoundingClientRect();
      if (r.height > innerHeight * 1.3 || r.width > innerWidth * 1.01) break;
      if (el.querySelectorAll('video').length !== 1) break;
      best = el;
    }
    return best;
  }

  /** Every reel currently mounted (Facebook pre-renders the neighbours of the one on screen). */
  function findReels() {
    const seen = new Set();
    const reels = [];
    for (const video of document.querySelectorAll('video')) {
      const r = video.getBoundingClientRect();
      if (r.width < MIN_VIDEO_SIZE && r.height < MIN_VIDEO_SIZE) continue;
      const container = reelContainer(video);
      if (seen.has(container)) continue;
      seen.add(container);
      reels.push({ video, container, visible: visibleArea(container) });
    }
    return reels;
  }

  /** The reel the user is looking at: the one with the most area inside the viewport. */
  function activeReel(reels) {
    let best = null;
    for (const r of reels) if (r.visible > 0 && (!best || r.visible > best.visible)) best = r;
    return best;
  }

  /**
   * Raw material for F.buildFingerprint. innerText (not textContent) on purpose: Facebook
   * scrambles labels like "Sponsored" with hidden decoy characters, and innerText only returns
   * what is actually rendered.
   */
  function collectRaw(container) {
    const lines = (container.innerText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const anchors = Array.from(container.querySelectorAll('a[href]'), (a) => ({
      href: a.href,
      text: (a.innerText || '').trim()
    }));
    return { lines, anchors };
  }

  // ---- Blocking -----------------------------------------------------------------------------

  // opacity (not visibility/display) so innerText keeps working and the fingerprint stays readable.
  function setBlocked(container, on) {
    if (on) container.setAttribute('data-fbab-blocked', '1');
    else container.removeAttribute('data-fbab-blocked');
  }

  function setDebugOutline(container, on) {
    if (on) container.setAttribute('data-fbab-debug', '1');
    else container.removeAttribute('data-fbab-debug');
  }

  function isVisibleBox(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // The element that actually scrolls the reels (the page itself, or an overflow container around them).
  function scrollableAncestor(el) {
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && n.scrollHeight > n.clientHeight + 1) return n;
    }
    const se = document.scrollingElement;
    return se && se.scrollHeight > se.clientHeight + 1 ? window : null;
  }

  function pressKey(key, keyCode) {
    const init = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /**
   * Ways of moving on to the next reel. Facebook offers no API and may ignore script-generated input,
   * so there are several. Each returns true if it did something (false = not applicable here).
   * The caller escalates when one makes no difference and remembers the one that worked.
   */
  const SKIP_STRATEGIES = {
    // The on-screen "next" arrow.
    button() {
      const btn = Array.from(document.querySelectorAll('[aria-label]')).find((el) => {
        const label = el.getAttribute('aria-label').trim();
        return label.length <= MAX_LABEL_LENGTH && NEXT_LABEL_RE.test(label) && isVisibleBox(el);
      });
      if (!btn) return false;
      btn.click();
      return true;
    },
    // Scroll the element that holds the reels down by one reel.
    scroll(container) {
      const scroller = scrollableAncestor(container);
      if (!scroller) return false;
      const step = Math.round(container.getBoundingClientRect().height) || innerHeight;
      scroller.scrollBy({ top: step, behavior: 'smooth' });
      return true;
    },
    // The Down-arrow shortcut.
    key() {
      pressKey('ArrowDown', 40);
      return true;
    },
    // A scroll-wheel tick over the reel, for viewers that handle wheel events in script.
    wheel(container) {
      const target = document.elementFromPoint(innerWidth / 2, innerHeight / 2) || container;
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true, clientX: innerWidth / 2, clientY: innerHeight / 2
      }));
      return true;
    },
    // Bring the nearest reel below this one into view.
    'next-reel'(container) {
      const top = container.getBoundingClientRect().top;
      const below = findReels()
        .map((r) => ({ r, t: r.container.getBoundingClientRect().top }))
        .filter((x) => x.r.container !== container && x.t > top + 10)
        .sort((a, b) => a.t - b.t)[0];
      if (!below) return false;
      below.r.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
  };
  const SKIP_ORDER = Object.keys(SKIP_STRATEGIES);

  function runSkip(name, container) {
    return SKIP_STRATEGIES[name](container);
  }

  F.page = { isReelPage, findReels, activeReel, collectRaw, setBlocked, setDebugOutline, runSkip, SKIP_ORDER };
})(typeof globalThis !== 'undefined' ? globalThis : this);
