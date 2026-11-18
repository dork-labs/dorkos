### Changed

- The "signed out" notice on a Claude account now clears itself when a usage check finds the
  account working again. You no longer have to sign in again from DorkOS to make it go away
  (DOR-4425).
- If you sign in to a signed-out Claude account again from the command line, DorkOS notices,
  checks the account, and clears the notice once the check works (DOR-4425).
- One failed sign-in no longer raises an alert right away. DorkOS waits 30 seconds and checks
  the account once more. If it works, nothing is shown. If it fails twice, you hear at once
  (DOR-4424).
