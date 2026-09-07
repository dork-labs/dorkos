---
covers:
  - 'fix(client): every loading spinner is the same spinner (DOR-1811)'
  - 'fix(client,desktop): review fixes for the spinner sweep — icons that match on a phone (DOR-1811, DOR-1815)'
---

### Changed

- Loading spinners now look the same everywhere in the app. They were drawn by hand in three dozen places, at six different sizes for the same job, so two panels loading side by side could disagree about how big "loading" is.
- The spinner on a running task now uses the app's own blue, which means it stays readable in dark mode instead of staying stuck at the light-mode shade.
- Spinners that sit next to words like "Loading files" no longer get read out a second time by a screen reader, and the ones that sit alone now say what they are waiting for.
- On a phone, the icon that replaces a spinner when something finishes is now the same size as the spinner was. Buttons and rows used to shift by a few pixels at the moment they finished loading.
