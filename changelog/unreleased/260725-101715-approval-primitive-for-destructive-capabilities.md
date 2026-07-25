### Added

- DorkOS can now ask you before an agent does something you cannot undo. When an agent requests
  approval, a card appears on your dashboard with what would happen, which agent asked, how
  consequential it is, and how long you have to decide, plus Allow and "Don't allow" buttons. The
  card shows up in every window you have open and disappears everywhere as soon as you answer
  (DOR-447).

### Changed

- Marketplace installs, uninstalls, and new packages requested by an outside agent now go through
  the same approval card as everything else, so there is one place to look and one way to answer.
  You get 10 minutes to decide instead of 5 (DOR-447).

### Security

- An approval now only covers the exact thing you approved. Saying yes to uninstalling one package
  can no longer be reused to uninstall a different one, each approval works once, and approvals are
  never stored in a form anything could reuse (DOR-447).
