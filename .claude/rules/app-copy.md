---
paths: apps/client/src/**/*.tsx, apps/client/src/**/*.ts
---

# App Copy

Any string this file renders is in-app copy. The standard is the **`writing-app-copy`** skill: load it before you write or change a string a person will see or hear.

The rules in one breath: dry and calm, a control panel and not a consumer app. Never "we", "I", "please" or "sorry". Name the actor and talk to "you". No blame words (failed, invalid, fatal) and no code names (Relay, Mesh, Pulse, runtime). Buttons name the exact action; only Cancel, Close and Done are generic. Errors say what did not happen and what to do next.

**Length, per block** (one label, title, body, toast or tooltip): 1-3 words preferred, 4-6 good, 7-15 flagged, 16+ never. Too much to say? Cut, then split into title and body, then disclose in place (expandable section, popover, info tip), and link to docs last. `pnpm check:copy-length` lists the long blocks.

Before changing an existing string, `grep -rn "<old text>" apps/e2e`: browser specs assert literal copy, and they run only in the merge queue.

Not copy: code samples in `<code>`, Dev Playground commentary (`src/dev/`), test fixtures, and prompt text written for a model.
