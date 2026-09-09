---
covers:
  - 'feat(harness): a global plan, pure, with the dork-home tier (DOR-1923)'
  - 'feat(harness): a global plan applies and sweeps only what it wrote (DOR-1923)'
  - 'test(harness): P8 exists, and P8b/P8c hold the global plan to its roots (DOR-1923)'
  - "feat(server): global rows in every project's status answer (DOR-1923)"
  - "feat(harness): a global package's timers are told they work (DOR-1923)"
  - 'feat(cli): dorkos harness sync --global (DOR-1923)'
  # Folds in here: all four refine this same unreleased behaviour, and nothing a
  # person could have seen before it.
  - 'fix(harness): a sweep never acts on a plan it could not build (DOR-1923)'
  - "fix(harness): a package's timers are only said to work once they do (DOR-1923)"
  - 'fix(cli): --global refuses --strict, which it could never act on (DOR-1923)'
  - 'feat(client): a skill from an all-projects package says so (DOR-1923)'
  # Folds in here too: it gives the same unreleased removal list the reasons
  # DOR-1906 gave the project one, in the same words.
  - 'fix(harness,cli): the global sweep says why each link goes (DOR-1923)'
---

### Added

- A skill that runs on a timer inside a package you installed for all your projects now actually runs. `dorkos harness sync --global` puts those skills where DorkOS looks for timed work, so a daily job in a package you installed once shows up for you to approve like any other. It works from any folder and needs no project (DOR-1923)
- Before it removes a link, `--global` prints every path it is about to remove — each with one plain sentence saying why — and prints them again once they are gone. It only ever removes links it made itself: a folder you made, or a link you made yourself, is left exactly where it is. Run it twice and the second run does nothing (DOR-1923)
- The Skills page now lists the skills in your all-projects packages alongside your project's own, tagged "for all your projects", with the same sentence about who can see them — and the count above the list counts both (DOR-1923)

### Changed

- The line about a package installed for all your projects now ends with "Its skills that run on a timer now work" once those skills are actually linked, and tells you which command links them until then. Packages with no timed skill say nothing new (DOR-1923)
- If DorkOS cannot read the folder your all-projects packages live in, `--global` stops and removes nothing instead of treating the folder as empty. A package that is still installed also keeps its links when DorkOS cannot make sense of its settings file (DOR-1923)
