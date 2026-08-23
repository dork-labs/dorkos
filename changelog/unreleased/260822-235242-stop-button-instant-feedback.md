---
covers:
  - 'fix(client): pressing Stop now responds instantly and never sends the request twice (DOR-1300)'
  - 'fix(client): close the reachable Stop-button gaps a review found (DOR-1300)'
---

### Fixed

- Pressing Stop now responds the moment you click — the button says it's stopping, and clicking again doesn't send the request twice. Before, a Stop that took a few seconds to take effect left the button looking untouched, so a second (or third) click fired off extra requests with nothing on screen to explain the wait.
