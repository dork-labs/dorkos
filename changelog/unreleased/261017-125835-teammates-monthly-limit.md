---
covers:
  - 'feat(spaces): set how much teammates can spend on your agents in a space each month (DOR-2956)'
---

### Added

- A space's agent panel now has a **Teammates** section. In it you choose who can wake your agents there: anyone in the space, or only you.
- You can also set a monthly limit, in dollars, on what turns started by teammates may cost you in that space. The smallest limit is one cent, and there is no limit until you set one. Once teammates' turns reach it, their messages stay in the space but wake none of your agents until the next month. A turn that is already running when the limit is reached finishes, so the total can go a little past it. You get one notice when that happens. Your own messages always work.
- If the saved limits can't be read, DorkOS sets the file aside, starts with no limits, and tells you once so you can set them again.
- The section shows what teammates' turns cost this month. If a turn didn't report its cost, it is counted at a fixed estimate, and the total is marked approximate.
