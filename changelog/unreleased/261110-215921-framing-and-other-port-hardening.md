---
covers:
  - "fix(http): the canvas browser never frames DorkOS with the app's own powers, and refused frames say so to older browsers (DOR-3370)"
---

### Security

- The browser in the side panel opens DorkOS's own address in a locked-down frame, so a page there can't act as the app. DorkOS pages also tell older browsers they can't be shown inside other sites (DOR-3370).
