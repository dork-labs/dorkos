### Fixed

- Run a scheduled task at its agent's own level. If its file asks for no prompts, an agent at Full runs it at Full and an agent at Ask runs it at Ask, instead of everything stopping at "accept edits". A file that asks for fewer prompts than you approved waits for you again; for an agent at Full, that wait is a quiet row under Needs you, with no alert. (DOR-3425)
