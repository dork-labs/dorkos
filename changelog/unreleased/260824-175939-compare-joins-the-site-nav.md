---
covers:
  - 'feat(site): Compare joins the site nav — pill overlap fixed, hub gets its money shot (DOR-1504)'
  - 'fix(site): the homepage shares the one nav list, and the pill waits for keyboard users (DOR-1504)'
---

### Added

- Compare is now in the menu at the bottom of dorkos.ai, right after Features. The comparison pages have been there for a while, but you had to already know they existed, or find the link in the footer (DOR-1504)
- The menu now shows you where you are. Reading a comparison, Compare is the word that stands out; reading a feature page, it is Features (DOR-1504)
- The Compare page opens with a picture of DorkOS instead of only words, so you can see the thing being compared before you read about it (DOR-1504)

### Fixed

- The floating menu no longer sits on top of what you are reading. As you scroll down a long page it steps out of the way, and it comes back the moment you scroll up, reach the top, or arrive at the end. Before this, it could cover a link and swallow the click (DOR-1504)
- The menu fits on a phone screen again now that it holds six words. On the narrowest screens it drops "home", which the logo at the top already does (DOR-1504)
- If you are moving through the menu with the keyboard, it now waits for you. It used to slide away mid-tab and drop you back at the start of the page (DOR-1504)
