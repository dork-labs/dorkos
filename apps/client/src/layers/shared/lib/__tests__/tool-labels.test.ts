import { describe, it, expect } from 'vitest';
import {
  getToolLabel,
  getMcpServerBadge,
  parseMcpToolName,
  formatActivityLabel,
  activityClause,
} from '../tool-labels';

describe('getToolLabel', () => {
  it('returns raw tool name for non-JSON input', () => {
    expect(getToolLabel('Read', 'not json')).toBe('Read');
  });

  it('returns raw tool name for empty input', () => {
    expect(getToolLabel('Read', '')).toBe('Read');
  });

  // Bash
  it('uses description for Bash when available', () => {
    expect(getToolLabel('Bash', '{"command":"npm test","description":"Run unit tests"}')).toBe(
      'Run "Run unit tests"'
    );
  });

  it('falls back to command for Bash when no description', () => {
    expect(getToolLabel('Bash', '{"command":"npm test"}')).toBe('Run "npm test"');
  });

  it('truncates long Bash commands', () => {
    const long = 'a'.repeat(50);
    const label = getToolLabel('Bash', JSON.stringify({ command: long }));
    expect(label.length).toBeLessThan(60);
    expect(label).toContain('…');
  });

  // Read / Write / Edit
  it('shows basename for Read', () => {
    expect(getToolLabel('Read', '{"file_path":"/Users/me/project/src/utils.ts"}')).toBe(
      'Read utils.ts'
    );
  });

  it('shows basename for Write', () => {
    expect(getToolLabel('Write', '{"file_path":"/tmp/output.json","content":"..."}')).toBe(
      'Write output.json'
    );
  });

  it('shows basename for Edit', () => {
    expect(
      getToolLabel('Edit', '{"file_path":"/src/index.ts","old_string":"a","new_string":"b"}')
    ).toBe('Edit index.ts');
  });

  // Glob
  it('shows pattern for Glob', () => {
    expect(getToolLabel('Glob', '{"pattern":"**/*.tsx"}')).toBe('Find **/*.tsx');
  });

  // Grep
  it('shows quoted pattern for Grep', () => {
    expect(getToolLabel('Grep', '{"pattern":"function\\\\s+\\\\w+"}')).toBe(
      'Search "function\\s+\\w+"'
    );
  });

  it('truncates long Grep patterns', () => {
    const long = 'x'.repeat(40);
    const label = getToolLabel('Grep', JSON.stringify({ pattern: long }));
    expect(label).toContain('…');
  });

  // Task
  it('shows description for Task agent', () => {
    expect(
      getToolLabel(
        'Task',
        '{"description":"Find auth code","prompt":"...","subagent_type":"Explore"}'
      )
    ).toBe('Agent: Find auth code');
  });

  it('falls back to prompt for Task when no description', () => {
    expect(getToolLabel('Task', '{"prompt":"Search the codebase"}')).toBe(
      'Agent: Search the codebase'
    );
  });

  // TaskCreate
  it('shows subject for TaskCreate', () => {
    expect(getToolLabel('TaskCreate', '{"subject":"Fix login bug","description":"..."}')).toBe(
      'Create task "Fix login bug"'
    );
  });

  // TaskUpdate
  it('shows id and status for TaskUpdate', () => {
    expect(getToolLabel('TaskUpdate', '{"taskId":"3","status":"completed"}')).toBe(
      'Update task #3 → completed'
    );
  });

  it('shows only id for TaskUpdate without status', () => {
    expect(getToolLabel('TaskUpdate', '{"taskId":"5","subject":"New name"}')).toBe(
      'Update task #5'
    );
  });

  // TaskList
  it('returns static label for TaskList', () => {
    expect(getToolLabel('TaskList', '{}')).toBe('List tasks');
  });

  // TodoWrite
  it('shows item count for TodoWrite with multiple items', () => {
    expect(
      getToolLabel(
        'TodoWrite',
        '{"todos":[{"content":"Buy milk","status":"pending"},{"content":"Buy eggs","status":"pending"},{"content":"Buy bread","status":"pending"}]}'
      )
    ).toBe('Update tasks (3 items)');
  });

  it('shows singular for TodoWrite with one item', () => {
    expect(getToolLabel('TodoWrite', '{"todos":[{"content":"Buy milk","status":"pending"}]}')).toBe(
      'Update tasks (1 item)'
    );
  });

  it('shows zero count for TodoWrite with empty todos', () => {
    expect(getToolLabel('TodoWrite', '{"todos":[]}')).toBe('Update tasks (0 items)');
  });

  // Skill
  it('shows skill name for Skill', () => {
    expect(getToolLabel('Skill', '{"skill":"daily-note"}')).toBe('Skill daily-note');
  });

  // WebSearch
  it('shows query for WebSearch', () => {
    expect(getToolLabel('WebSearch', '{"query":"React hooks best practices"}')).toBe(
      'Search "React hooks best practices"'
    );
  });

  // WebFetch
  it('shows hostname for WebFetch', () => {
    expect(
      getToolLabel('WebFetch', '{"url":"https://docs.example.com/api/v2","prompt":"..."}')
    ).toBe('Fetch docs.example.com');
  });

  it('handles invalid URL in WebFetch gracefully', () => {
    expect(getToolLabel('WebFetch', '{"url":"not-a-url"}')).toBe('Fetch not-a-url');
  });

  // Unknown tool
  it('returns raw name for unknown tools', () => {
    expect(getToolLabel('CustomMCPTool', '{"foo":"bar"}')).toBe('CustomMCPTool');
  });

  // MCP tool names via getToolLabel
  it('humanizes MCP tool name for known server', () => {
    expect(getToolLabel('mcp__slack__send_message', '{}')).toBe('Send Message');
  });

  it('humanizes MCP tool name for unknown server', () => {
    expect(getToolLabel('mcp__my_custom_server__do_thing', '{}')).toBe('Do Thing');
  });

  it('humanizes MCP tool name when input is empty string', () => {
    expect(getToolLabel('mcp__dorkos__mesh_list', '')).toBe('Mesh List');
  });

  it('humanizes MCP tool name when input is invalid JSON', () => {
    expect(getToolLabel('mcp__slack__send_message', 'not json')).toBe('Send Message');
  });

  it('returns raw name for mcp__ prefix with only one segment', () => {
    expect(getToolLabel('mcp__slack', '{}')).toBe('mcp__slack');
  });
});

describe('parseMcpToolName', () => {
  it('returns null for non-MCP tool names', () => {
    expect(parseMcpToolName('Bash')).toBeNull();
    expect(parseMcpToolName('Read')).toBeNull();
    expect(parseMcpToolName('CustomTool')).toBeNull();
  });

  it('returns null for mcp__ prefix without enough segments', () => {
    expect(parseMcpToolName('mcp__slack')).toBeNull();
  });

  it('parses a known server correctly', () => {
    const result = parseMcpToolName('mcp__slack__send_message');
    expect(result).toEqual({
      server: 'slack',
      serverLabel: 'Slack',
      tool: 'send_message',
      toolLabel: 'Send Message',
    });
  });

  it('parses an unknown server using humanizeSnakeCase', () => {
    const result = parseMcpToolName('mcp__my_server__do_thing');
    expect(result).toEqual({
      server: 'my_server',
      serverLabel: 'My Server',
      tool: 'do_thing',
      toolLabel: 'Do Thing',
    });
  });

  it('uses known label overrides for all predefined servers', () => {
    expect(parseMcpToolName('mcp__dorkos__relay_send')?.serverLabel).toBe('DorkOS');
    expect(parseMcpToolName('mcp__telegram__send_message')?.serverLabel).toBe('Telegram');
    expect(parseMcpToolName('mcp__github__create_issue')?.serverLabel).toBe('GitHub');
    expect(parseMcpToolName('mcp__filesystem__read_file')?.serverLabel).toBe('Files');
    expect(parseMcpToolName('mcp__playwright__navigate')?.serverLabel).toBe('Browser');
    expect(parseMcpToolName('mcp__context7__get_context')?.serverLabel).toBe('Context7');
  });

  it("reads OpenCode's single-underscore spelling of a DorkOS tool (DOR-1613)", () => {
    // What this catches: OpenCode does not spell an MCP tool `mcp__server__tool`
    // — it builds `sanitize(server) + '_' + sanitize(tool)` and hands that key
    // straight through. Keyed on `mcp__` alone, every DorkOS tool an OpenCode
    // agent called rendered as its raw wire name, with no badge and no label.
    const result = parseMcpToolName('dorkos_post_to_room');
    expect(result).toEqual({
      server: 'dorkos',
      serverLabel: 'DorkOS',
      tool: 'post_to_room',
      toolLabel: 'Post To Room',
    });
  });

  it('does not mistake another server for the DorkOS one', () => {
    // The prefix is scoped to the one server DorkOS itself injects, deliberately:
    // `a_b_c` cannot be split into a server and a tool without guessing, and a
    // guess would relabel somebody's own tool under a server that does not exist.
    expect(parseMcpToolName('slack_send_message')).toBeNull();
    expect(parseMcpToolName('dorkos_')).toBeNull();
    // And the two spellings cannot collide: the qualified one does not start
    // with the bare prefix.
    expect(parseMcpToolName('mcp__dorkos__post_to_room')?.tool).toBe('post_to_room');
  });

  it('joins extra segments into the tool name', () => {
    const result = parseMcpToolName('mcp__slack__channel__send');
    expect(result?.tool).toBe('channel__send');
    // humanizeSnakeCase splits on '_', so double underscores produce an intermediate
    // empty word and a double space — this is expected behavior for the simple utility
    expect(result?.toolLabel).toBe('Channel  Send');
  });
});

describe('getMcpServerBadge', () => {
  it('returns null for non-MCP tool names', () => {
    expect(getMcpServerBadge('Bash')).toBeNull();
    expect(getMcpServerBadge('Read')).toBeNull();
  });

  it('returns null for DorkOS MCP tools', () => {
    expect(getMcpServerBadge('mcp__dorkos__relay_send')).toBeNull();
  });

  it('returns the server label for non-DorkOS MCP tools', () => {
    expect(getMcpServerBadge('mcp__slack__send_message')).toBe('Slack');
    expect(getMcpServerBadge('mcp__github__create_issue')).toBe('GitHub');
    expect(getMcpServerBadge('mcp__playwright__navigate')).toBe('Browser');
  });

  it('humanizes unknown servers', () => {
    expect(getMcpServerBadge('mcp__my_custom__do_thing')).toBe('My Custom');
  });

  it('returns null for malformed mcp__ names', () => {
    expect(getMcpServerBadge('mcp__slack')).toBeNull();
  });
});

describe('formatActivityLabel — the honesty ladder', () => {
  // Rung 1: a tool this client knows, with the argument a person would recognize.
  it('names the file, the command, or the query when it has one', () => {
    expect(formatActivityLabel({ toolName: 'Edit', target: 'lane-state.ts' })).toBe(
      'Editing lane-state.ts…'
    );
    expect(formatActivityLabel({ toolName: 'Read', target: 'README.md' })).toBe(
      'Reading README.md…'
    );
    expect(formatActivityLabel({ toolName: 'Bash', target: 'pnpm verify' })).toBe(
      'Running pnpm verify…'
    );
    expect(formatActivityLabel({ toolName: 'Grep', target: 'deriveLaneState' })).toBe(
      'Searching for deriveLaneState…'
    );
  });

  // Rung 1, other runtimes: the same act, spelled three ways on the wire.
  it('reads codex and opencode tool names as what they are', () => {
    expect(formatActivityLabel({ toolName: 'Shell', target: 'git status' })).toBe(
      'Running git status…'
    );
    expect(formatActivityLabel({ toolName: 'ApplyPatch', target: 'index.ts' })).toBe(
      'Editing index.ts…'
    );
    expect(formatActivityLabel({ toolName: 'bash', target: 'ls -la' })).toBe('Running ls -la…');
    expect(formatActivityLabel({ toolName: 'webfetch', target: 'dorkos.ai' })).toBe(
      'Reading dorkos.ai…'
    );
  });

  // Rung 2: the tool is known, the argument is not. Say the less specific true
  // thing rather than the more specific invented one.
  it('degrades to a generic phrase when the tool has no target', () => {
    expect(formatActivityLabel({ toolName: 'Bash' })).toBe('Running a command…');
    expect(formatActivityLabel({ toolName: 'Edit' })).toBe('Editing a file…');
    expect(formatActivityLabel({ toolName: 'WebSearch' })).toBe('Searching the web…');
    expect(formatActivityLabel({ toolName: 'TodoWrite' })).toBe('Updating its task list…');
  });

  // Rung 3: an MCP tool — the server is the honest unit, not the method name.
  it('names the MCP server it is talking to', () => {
    expect(formatActivityLabel({ toolName: 'mcp__slack__send_message' })).toBe('Using Slack…');
    expect(formatActivityLabel({ toolName: 'mcp__my_custom__do_thing' })).toBe('Using My Custom…');
    expect(formatActivityLabel({ toolName: 'mcp__dorkos__relay_send' })).toBe('Using DorkOS…');
  });

  // Rung 4: a name nothing here has ever seen. Say the name.
  it('falls back to the tool name itself, never a guess', () => {
    expect(formatActivityLabel({ toolName: 'some_future_tool' })).toBe('Using some_future_tool…');
    // A malformed MCP name is not an MCP name — it is just a name.
    expect(formatActivityLabel({ toolName: 'mcp__slack' })).toBe('Using mcp__slack…');
  });

  // Rung 5: nothing is known at all.
  it('says only that it is working when there is no activity', () => {
    expect(formatActivityLabel(null)).toBe('Working…');
    expect(formatActivityLabel(undefined)).toBe('Working…');
  });
});

/**
 * Every label the session's status line has ever drawn, written down.
 *
 * `[toolName, target, label]` — one row per phrasing the table can produce, plus
 * the three fallback rungs underneath it. `target` is `undefined` for the bare
 * form.
 *
 * **This table was written and run GREEN against the pre-clause implementation**,
 * which is the only moment that evidence could be gathered: once
 * `ACTIVITY_PHRASES` holds clauses, a table copied out of the new code would only
 * restate whatever the new code does. Exactly one row moved in the refactor and
 * it is marked below.
 */
const SHIPPED_LABELS: ReadonlyArray<[string, string | undefined, string]> = [
  ['Bash', 'pnpm verify', 'Running pnpm verify…'],
  ['Bash', undefined, 'Running a command…'],
  ['Shell', 'git status', 'Running git status…'],
  ['Shell', undefined, 'Running a command…'],
  ['Read', 'README.md', 'Reading README.md…'],
  ['Read', undefined, 'Reading a file…'],
  ['Write', 'notes.md', 'Writing notes.md…'],
  ['Write', undefined, 'Writing a file…'],
  ['Edit', 'lane-state.ts', 'Editing lane-state.ts…'],
  ['Edit', undefined, 'Editing a file…'],
  ['ApplyPatch', 'index.ts', 'Editing index.ts…'],
  ['ApplyPatch', undefined, 'Editing a file…'],
  ['NotebookEdit', 'analysis.ipynb', 'Editing analysis.ipynb…'],
  ['NotebookEdit', undefined, 'Editing a notebook…'],
  ['Glob', '**/*.tsx', 'Looking for **/*.tsx…'],
  ['Glob', undefined, 'Looking through files…'],
  ['Grep', 'deriveLaneState', 'Searching for deriveLaneState…'],
  ['Grep', undefined, 'Searching the code…'],
  ['WebSearch', 'zod openapi', 'Searching the web for zod openapi…'],
  ['WebSearch', undefined, 'Searching the web…'],
  ['WebFetch', 'dorkos.ai', 'Reading dorkos.ai…'],
  ['WebFetch', undefined, 'Reading a web page…'],
  // THE ONE ROW THAT MOVED. It read `Running an agent — review the diff…` until
  // the clause refactor, and the em dash went because these clauses are now
  // printed as user-facing sentences in a room, where `writing-for-humans` rules
  // it out. Every other row above is byte-identical to what shipped.
  ['Task', 'review the diff', 'Running an agent: review the diff…'],
  ['Task', undefined, 'Running an agent…'],
  ['Skill', 'writing-for-humans', 'Using the writing-for-humans skill…'],
  ['Skill', undefined, 'Using a skill…'],
  ['TodoWrite', 'ignored', 'Updating its task list…'],
  ['TodoWrite', undefined, 'Updating its task list…'],
  // The rungs under the table, pinned in the same place so a refactor that
  // reaches them cannot pass by touching only the fourteen entries above.
  ['mcp__slack__send_message', undefined, 'Using Slack…'],
  ['mcp__my_custom__do_thing', undefined, 'Using My Custom…'],
  ['some_future_tool', undefined, 'Using some_future_tool…'],
];

describe('formatActivityLabel — the shipped labels, pinned', () => {
  it.each(SHIPPED_LABELS)('says %s/%s exactly as it always has', (toolName, target, label) => {
    expect(formatActivityLabel(target === undefined ? { toolName } : { toolName, target })).toBe(
      label
    );
  });

  it('covers every entry in the phrasing table twice — with a target and without', () => {
    // Without this the table above could silently stop covering a tool: a row
    // deleted from `SHIPPED_LABELS` takes its own assertion with it, and nothing
    // else would notice. Fourteen tools, both forms, plus three fallback rungs.
    expect(SHIPPED_LABELS.length).toBe(31);
    const bare = SHIPPED_LABELS.filter(([, target]) => target === undefined);
    expect(bare.length).toBe(17);
  });
});

describe('activityClause — the rung both framings share', () => {
  it('says the same reading as a clause that follows "is"', () => {
    expect(activityClause({ toolName: 'Read', target: 'standup.md' })).toBe('reading standup.md');
    expect(activityClause({ toolName: 'Bash', target: 'pnpm test' })).toBe('running pnpm test');
    expect(activityClause({ toolName: 'Edit' })).toBe('editing a file');
    expect(activityClause({ toolName: 'mcp__slack__send_message' })).toBe('using Slack');
    expect(activityClause({ toolName: 'some_future_tool' })).toBe('using some_future_tool');
  });

  it('answers null where the session\u2019s label answers "Working…"', () => {
    // The two floors are different on purpose: a room says its own less specific
    // truth ("Kai is working on it") rather than borrowing the session's word.
    expect(activityClause(null)).toBeNull();
    expect(activityClause(undefined)).toBeNull();
    expect(activityClause({ toolName: '   ' })).toBeNull();
    expect(formatActivityLabel(null)).toBe('Working…');
  });
});
