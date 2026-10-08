import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateBoundaryOrDorkHome } from '../../../../lib/boundary.js';
import { SessionDiscoveryUnavailableError } from '../../../session/resolution/session-lookup-error.js';
import { CodexNativeSessionReader } from '../native-session-reader.js';
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue(undefined),
}));

describe('Codex native sessions', () => {
  it('distinguishes an empty imported transcript from a missing or unreadable one', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'codex-required-native-'));
    const id = '0195bfa1-e000-7000-8000-000000000001';
    const reader = new CodexNativeSessionReader(() => home);
    try {
      await mkdir(path.join(home, 'sessions'), { recursive: true });
      const file = path.join(home, 'sessions', `rollout-2026-01-01T00-00-00-${id}.jsonl`);
      await writeFile(
        file,
        JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-01-01',
          payload: { id, cwd: '/project' },
        })
      );
      expect(await reader.readHistory(id, { required: true })).toEqual([]);
      const denied = Object.assign(new Error('Outside boundary'), {
        name: 'BoundaryError',
        code: 'OUTSIDE_BOUNDARY',
      });
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(denied);
      await expect(reader.readHistory(id, { required: true })).rejects.toBe(denied);
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(
        Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      );
      await expect(reader.readHistory(id, { required: true })).rejects.toBeInstanceOf(
        SessionDiscoveryUnavailableError
      );
      await rm(file);
      await expect(reader.readHistory(id, { required: true })).rejects.toBeInstanceOf(
        SessionDiscoveryUnavailableError
      );
      const missing = new CodexNativeSessionReader(() => home);
      await expect(missing.readHistory(id, { required: true })).rejects.toBeInstanceOf(
        SessionDiscoveryUnavailableError
      );
      expect(await missing.readHistory(id)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('opens local desktop/CLI history without duplicating event_msg records or launching a turn', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'codex-native-'));
    try {
      const id = '0195bfa1-e000-7000-8000-000000000001';
      await mkdir(path.join(home, 'sessions'), { recursive: true });
      const records = [
        {
          type: 'session_meta',
          timestamp: '2026-01-01T00:00:00Z',
          payload: { id, cwd: '/project', source: 'desktop', instructions: 'x'.repeat(300_000) },
        },
        {
          type: 'response_item',
          timestamp: '2026-01-01T00:00:01Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        },
        { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
        {
          type: 'response_item',
          timestamp: '2026-01-01T00:00:02Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'world' }],
          },
        },
      ];
      await writeFile(
        path.join(home, 'sessions', `rollout-2026-01-01T00-00-00-${id}.jsonl`),
        records.map((r) => JSON.stringify(r)).join('\n')
      );
      const put = vi.fn().mockResolvedValue({ url: '/api/image', mediaType: 'image/png', size: 3 });
      const reader = new CodexNativeSessionReader(() => home, {
        put,
        peek: vi.fn().mockResolvedValue(null),
      } as never);
      await expect(reader.findSession(id)).resolves.toMatchObject({
        id,
        cwd: '/project',
        runtime: 'codex',
        title: 'hello',
      });
      expect((await reader.readHistory(id)).map((m) => m.content)).toEqual(['hello', 'world']);
      records.push(
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
          },
        } as never,
        {
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-1', output: '/project' },
        } as never
      );
      await writeFile(
        path.join(home, 'sessions', `rollout-2026-01-01T00-00-00-${id}.jsonl`),
        records.map((r) => JSON.stringify(r)).join('\n')
      );
      expect((await reader.readHistory(id)).flatMap((message) => message.toolCalls ?? [])).toEqual([
        {
          toolCallId: 'call-1',
          toolName: 'exec_command',
          input: '{"cmd":"pwd"}',
          result: '/project',
          status: 'complete',
        },
      ]);
      records.push(
        {
          type: 'response_item',
          payload: {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Inspecting the change' }],
            encrypted_content: 'private-ciphertext',
          },
        } as never,
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'custom-1',
            name: 'apply_patch',
            input: 'patch text',
          },
        } as never,
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'custom-1', output: 'patched' },
        } as never,
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,YWJj' }],
          },
        } as never,
        { type: 'compacted', payload: { message: 'Summary so far' } } as never
      );
      await writeFile(
        path.join(home, 'sessions', `rollout-2026-01-01T00-00-00-${id}.jsonl`),
        records.map((r) => JSON.stringify(r)).join('\n')
      );
      const full = await reader.readHistory(id);
      expect(full.flatMap((message) => message.parts ?? [])).toContainEqual({
        type: 'thinking',
        text: 'Inspecting the change',
        isStreaming: false,
      });
      expect(full.flatMap((message) => message.toolCalls ?? [])).toContainEqual({
        toolCallId: 'custom-1',
        toolName: 'apply_patch',
        input: 'patch text',
        result: 'patched',
        status: 'complete',
      });
      expect(full.flatMap((message) => message.parts ?? [])).toContainEqual(
        expect.objectContaining({ type: 'image', url: '/api/image' })
      );
      expect(full).toContainEqual(
        expect.objectContaining({ messageType: 'compaction', content: 'Summary so far' })
      );
      expect(JSON.stringify(full)).not.toContain('private-ciphertext');
      expect(put).toHaveBeenCalledOnce();
      records.push(
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'image-tool',
            name: 'screenshot',
            arguments: '{}',
          },
        } as never,
        {
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'image-tool',
            output: JSON.stringify({
              content: [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }],
            }),
          },
        } as never
      );
      await writeFile(
        path.join(home, 'sessions', `rollout-2026-01-01T00-00-00-${id}.jsonl`),
        records.map((r) => JSON.stringify(r)).join('\n')
      );
      const withToolImage = await reader.readHistory(id);
      const screenshot = withToolImage.find(
        (message) => message.toolCalls?.[0]?.toolCallId === 'image-tool'
      );
      expect(screenshot?.parts).toContainEqual(
        expect.objectContaining({ type: 'image', url: '/api/image' })
      );
      expect(JSON.stringify(withToolImage)).not.toContain('YWJj');
      records.push({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'last' }],
        },
      } as never);
      await writeFile(
        path.join(home, 'sessions', `rollout-2026-01-01T00-00-00-${id}.jsonl`),
        records.map((r) => JSON.stringify(r)).join('\n')
      );
      expect((await reader.readHistory(id)).find((message) => message.content === 'last')?.id).toBe(
        'native-2'
      );

      expect((await reader.listSessions('/project')).map((s) => s.id)).toEqual([id]);
      await expect(reader.findSession('unknown')).resolves.toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
