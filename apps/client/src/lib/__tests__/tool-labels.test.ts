import { describe, it, expect } from 'vitest';
import { getToolLabel } from '../tool-labels';

describe('getToolLabel', () => {
  it('returns raw tool name for non-JSON input', () => {
    expect(getToolLabel('Read', 'not json')).toBe('Read');
  });

  it('returns raw tool name for empty input', () => {
    expect(getToolLabel('Read', '')).toBe('Read');
  });

  // Bash
  it('uses description for Bash when available', () => {
    expect(getToolLabel('Bash', '{"command":"npm test","description":"Run unit tests"}')).toBe('Run "Run unit tests"');
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
    expect(getToolLabel('Read', '{"file_path":"/Users/me/project/src/utils.ts"}')).toBe('Read utils.ts');
  });

  it('shows basename for Write', () => {
    expect(getToolLabel('Write', '{"file_path":"/tmp/output.json","content":"..."}')).toBe('Write output.json');
  });

  it('shows basename for Edit', () => {
    expect(getToolLabel('Edit', '{"file_path":"/src/index.ts","old_string":"a","new_string":"b"}')).toBe('Edit index.ts');
  });

  // Glob
  it('shows pattern for Glob', () => {
    expect(getToolLabel('Glob', '{"pattern":"**/*.tsx"}')).toBe('Find **/*.tsx');
  });

  // Grep
  it('shows quoted pattern for Grep', () => {
    expect(getToolLabel('Grep', '{"pattern":"function\\\\s+\\\\w+"}')).toBe('Search "function\\s+\\w+"');
  });

  it('truncates long Grep patterns', () => {
    const long = 'x'.repeat(40);
    const label = getToolLabel('Grep', JSON.stringify({ pattern: long }));
    expect(label).toContain('…');
  });

  // Task
  it('shows description for Task agent', () => {
    expect(getToolLabel('Task', '{"description":"Find auth code","prompt":"...","subagent_type":"Explore"}')).toBe('Agent: Find auth code');
  });

  it('falls back to prompt for Task when no description', () => {
    expect(getToolLabel('Task', '{"prompt":"Search the codebase"}')).toBe('Agent: Search the codebase');
  });

  // TaskCreate
  it('shows subject for TaskCreate', () => {
    expect(getToolLabel('TaskCreate', '{"subject":"Fix login bug","description":"..."}')).toBe('Create task "Fix login bug"');
  });

  // TaskUpdate
  it('shows id and status for TaskUpdate', () => {
    expect(getToolLabel('TaskUpdate', '{"taskId":"3","status":"completed"}')).toBe('Update task #3 → completed');
  });

  it('shows only id for TaskUpdate without status', () => {
    expect(getToolLabel('TaskUpdate', '{"taskId":"5","subject":"New name"}')).toBe('Update task #5');
  });

  // TaskList
  it('returns static label for TaskList', () => {
    expect(getToolLabel('TaskList', '{}')).toBe('List tasks');
  });

  // Skill
  it('shows skill name for Skill', () => {
    expect(getToolLabel('Skill', '{"skill":"daily-note"}')).toBe('Skill daily-note');
  });

  // WebSearch
  it('shows query for WebSearch', () => {
    expect(getToolLabel('WebSearch', '{"query":"React hooks best practices"}')).toBe('Search "React hooks best practices"');
  });

  // WebFetch
  it('shows hostname for WebFetch', () => {
    expect(getToolLabel('WebFetch', '{"url":"https://docs.example.com/api/v2","prompt":"..."}')).toBe('Fetch docs.example.com');
  });

  it('handles invalid URL in WebFetch gracefully', () => {
    expect(getToolLabel('WebFetch', '{"url":"not-a-url"}')).toBe('Fetch not-a-url');
  });

  // Unknown tool
  it('returns raw name for unknown tools', () => {
    expect(getToolLabel('CustomMCPTool', '{"foo":"bar"}')).toBe('CustomMCPTool');
  });
});
