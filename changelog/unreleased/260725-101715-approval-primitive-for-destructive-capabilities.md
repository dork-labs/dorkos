### Added

- DorkOS can now ask you before an agent does something you cannot undo. When an agent requests
  approval, a card appears on your dashboard saying what would happen in plain words, with Allow
  and "Don't allow" buttons and how long you have to decide. The card shows up in every window you
  have open and disappears everywhere as soon as you answer (DOR-447).

### Changed

- Marketplace installs, uninstalls, and new packages requested by an outside agent now go through
  the same approval card as everything else, so there is one place to look and one way to answer.
  You get 10 minutes to decide instead of 5 (DOR-447).

### Security

- An approval now only covers the exact thing you approved. Saying yes to uninstalling one package
  cannot be reused to uninstall a different one, to delete that package's saved data when you agreed
  to keep it, or to change a different project. Each approval works once, only a person can answer
  one, and approvals are never stored in a form anything could reuse (DOR-447).
