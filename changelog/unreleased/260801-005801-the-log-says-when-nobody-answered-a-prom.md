---
covers:
  - 'fix(runtime): the log says when nobody answered a prompt in time'
---

### Fixed

- When an agent asks to use a tool and nobody answers, it gives up after ten minutes. That used to happen in complete silence. DorkOS now writes a line saying which agent gave up and what it was asking about, so you can find out afterwards why it stopped.
