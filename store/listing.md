# Store listing text (Firefox Add-ons / addons.mozilla.org)

Copy these into the submission form. Not part of the extension package.

## Name
Reel Ad Blocker for Facebook

## Summary (max 250 characters)
Hides, mutes and skips Facebook reels labelled Sponsored. Spot an ad that slips through? One button (or Alt+X) teaches it to block look-alikes. Everything stays on your device.

## Categories
Social & Communication; Privacy & Security  (pick what the form offers)

## Tags
facebook, reels, ad blocker, sponsored, ads

## Description
Facebook reels carrying the **Sponsored** label are hidden, muted and skipped automatically.

For an ad that slips through, press the red **Block this ad** button (bottom right of the reel) or **Alt+X**. The extension remembers what that ad says and links to, and blocks look-alikes from then on, without you doing anything.

**How it recognises an ad**
- The **Sponsored** label, in about 20 languages (English, French, Spanish, German, Portuguese, Italian, Chinese, Japanese, Korean...).
- Rules you create by marking an ad: the website it links to, a fingerprint of its caption, the advertiser's Page (only when the reel is also labelled Sponsored or has a call-to-action button, so a Page's normal reels are not blocked).
- It uses no Facebook class names, which change constantly, only what the reel says and links to.

**You stay in control**
- Every blocked reel shows a banner: **Show anyway**, **Delete rule**, **Turn off auto-block**.
- The toolbar icon opens a page to review, disable, edit, delete, export and import your rules.

**Skipping is best effort.** Facebook has no "next reel" command, so the extension tries several ways of moving on. If none works, the ad stays hidden and muted and a banner tells you to scroll on. It never retries in a loop.

**Private.** No account, no tracking, no network requests. Rules are stored locally in your browser. Source code and privacy policy: https://github.com/Carlsans/reel-ad-blocker

Desktop Firefox only. Works on facebook.com reels pages (/reel, /reels, /watch). Ads in the home-feed reels carousel are not handled yet.

Not affiliated with or endorsed by Meta Platforms, Inc.

## Support / homepage
https://github.com/Carlsans/reel-ad-blocker
Support site: https://github.com/Carlsans/reel-ad-blocker/issues

## License
MIT (choose "MIT License" in the form's license picker)

## Privacy policy
Paste the contents of PRIVACY.md into the "privacy policy" field.

## Notes to reviewer
- No build step, minification or bundling: the zip contains the source files as they are in the repository
  (https://github.com/Carlsans/reel-ad-blocker).
- Permission `storage`: saves the user's rules and settings locally. No host permissions beyond the content-script
  match patterns https://www.facebook.com/* and https://web.facebook.com/*.
- No network requests, no remote code, no eval, no innerHTML with page data (all UI is built with DOM APIs and textContent).
- To see it work you need a Facebook account: open https://www.facebook.com/reel/ and scroll until a reel labelled
  "Sponsored" appears; it is hidden, muted and skipped. The manage page opens from the toolbar icon.
- Tests: `npm test` (unit), `npm run test:e2e` and `BROWSER=firefox npm run test:e2e` (browser end-to-end against a mock page).
