---
covers:
  - 'feat(client): the Skills page shows what each tool can see (DOR-1894)'
  - 'fix(client): the profile row counts real skills, from cache (DOR-1894)'
  - 'fix(client): the drop panel counts agent files, not a number (DOR-1894)'
  - 'fix(client): the enable command never breaks a flag in half (DOR-1894)'
---

### Changed

- Your agent's Skills page now shows every skill it has and which of your coding tools can see each one, with a reason when one can't. It used to list only the skill packs you had installed from the marketplace, which is how an agent with thirty-one skills came to be told it had none. Each skill is one line with a small tag per tool — reads it, has a copy, out of date, can't see it, or needs you to decide something — and where a tool can't see one, the page gives you the same sentence `dorkos harness sync` prints in your terminal, word for word, so the two can never tell you different things about the same file. Under the list there is a panel per tool holding every agent file that tool cannot see — skills, rules, commands and more, so that count is usually bigger than the number of skills — and a line when DorkOS finds files for a tool in your folder that it is not sharing to, with the one command that turns it on. Reading this page never writes anything (DOR-1894)

### Fixed

- The Skills row in an agent's profile no longer says "Skills 0" about an agent with thirty-one of them. It says how many there really are once you have opened the Skills page, and says nothing at all before that. Counting them means reading your project folder, and doing that every time a profile opens would slow every chat down for a number you had not asked to see (DOR-1894)
