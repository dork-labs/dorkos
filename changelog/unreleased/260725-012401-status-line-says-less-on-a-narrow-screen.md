### Changed

- On a narrow window the status line now says things in fewer words. The runtime drops the model name the item next to it already shows, the model drops its effort and Fast tags, and a long permission mode gets shortened — all of it still spelled out in full in the Session panel. "Default (recommended)" now reads "Default" everywhere: the parenthetical is advice for picking a model, not news about the one you picked (DOR-452).
- Anything still too long for the row now ends in an ellipsis you can see, instead of being cut off where nothing hinted it was there (DOR-452).

### Fixed

- The status line no longer runs past the edge of a narrow window. On a 375px-wide phone it needed 46px more room than it had, and on a 330px phone 91px — and every one of those pixels was silently cut off, taking the model and part of the runtime with it. The `⋯` is still always there, still the size of a thumb (DOR-452).
