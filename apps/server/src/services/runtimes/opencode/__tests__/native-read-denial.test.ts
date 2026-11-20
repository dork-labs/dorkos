/** Synthetic controls for attribution of the pinned OpenCode read-denial result. */
import { expect, it } from 'vitest';
import { matchesNativeReadDenial } from './native-read-denial.js';
const prefix =
  'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ';
const contents =
  prefix + JSON.stringify([{ permission: 'read', pattern: '*.env', action: 'deny' }]);
const tool = { role: 'tool', tool_call_id: 'owned-call', content: contents };
it.each([
  { name: '.env.ci', pattern: '.env*' },
  { name: 'prod.env', pattern: '*.env' },
])('recognizes the pinned native read-denial message for synthetic $name', ({ pattern }) => {
  const content = prefix + JSON.stringify([{ permission: 'read', pattern, action: 'deny' }]);
  expect(matchesNativeReadDenial({ ...tool, content }, 1, 'owned-call')).toBe(true);
});
it.each([
  { name: 'unrelated tool id', message: { ...tool, tool_call_id: 'other-call' } },
  { name: 'user quotation', message: { ...tool, role: 'user' } },
  { name: 'assistant quotation', message: { ...tool, role: 'assistant' } },
  { name: 'read file prose', message: { ...tool, content: 'file contents: ' + contents } },
  { name: 'embedded denial', message: { ...tool, content: JSON.stringify({ message: contents }) } },
  { name: 'trailing prose', message: { ...tool, content: contents + '\nfinished' } },
  { name: 'unversioned prefix', message: { ...tool, content: 'Error: ' + contents } },
  { name: 'malformed rule data', message: { ...tool, content: prefix + '{' } },
  {
    name: 'non-read denial',
    message: {
      ...tool,
      content: prefix + JSON.stringify([{ permission: 'edit', pattern: '*', action: 'deny' }]),
    },
  },
  {
    name: 'no deny rule',
    message: {
      ...tool,
      content: prefix + JSON.stringify([{ permission: 'read', pattern: '*', action: 'allow' }]),
    },
  },
])('refuses $name as this native denial', ({ message }) => {
  expect(matchesNativeReadDenial(message, 1, 'owned-call')).toBe(false);
});
it('refuses an unissued or ambiguous repeated read', () => {
  expect(matchesNativeReadDenial(tool, 0, 'owned-call')).toBe(false);
  expect(matchesNativeReadDenial(tool, 2, 'owned-call')).toBe(false);
});
