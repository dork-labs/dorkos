---
covers:
  - 'fix(site): muted text meets WCAG AA on cream surfaces (DOR-1503)'
---

### Fixed

- The light gray text on dorkos.ai is darker now, so it is easier to read. It is the color used for the small print all over the site: breadcrumbs, table column headers, card labels, captions, and the source lists under the comparison tables. Against the site's cream background it was too faint to meet the accessibility standard for readable text, and most of it is only nine to twelve pixels tall, which is exactly the text you can least afford to squint at (DOR-1503)
- The credit lines on the story page were the opposite problem. That page is dark, and the same gray was being used on it, which made it fainter still. Those lines now use the warm cream the footer already uses on dark backgrounds, so they are comfortably readable too (DOR-1503)
