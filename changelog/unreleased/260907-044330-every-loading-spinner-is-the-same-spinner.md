---
covers:
  - 'fix(client): every loading spinner is the same spinner (DOR-1811)'
---

### Changed

- Loading spinners now look the same everywhere in the app. They were drawn by hand in three dozen places, at six different sizes for the same job, so two panels loading side by side could disagree about how big "loading" is.
- The spinner on a running task now uses the app's own blue, which means it stays readable in dark mode instead of staying stuck at the light-mode shade.
- Spinners that sit next to words like "Loading files" no longer get read out a second time by a screen reader, and the ones that sit alone now say what they are waiting for.
