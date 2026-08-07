---
covers:
  - 'feat(identity): carry a photo as the fourth render-cache field (DOR-975)'
---

### Added

- People and agents can now carry a photo, alongside the name, emoji and colour they already had. Wherever the app draws a face — a room roster, a message, the hover card — the photo is what shows, and the emoji stays as the backup. Nothing sets a photo yet; the page for choosing one comes next. (DOR-975)
- A photo that will not load quietly falls back to the emoji, or to the first letter of the name. You never see a broken-image icon in place of somebody's face. (DOR-975)
