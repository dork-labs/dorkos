/** Require the binary to acknowledge a named profile before any model turn starts. */
import type { CodexJsonRpcClient } from './json-rpc-client.js';
import type {
  ThreadLoadOverrides,
  ThreadLoadResult,
  ThreadStartParams,
  ThreadResumeParams,
} from './protocol/methods.js';

/** Start a protected thread and verify its effective profile. */
export function loadWithProtectedProfile(
  client: CodexJsonRpcClient,
  method: 'thread/start',
  params: ThreadStartParams
): Promise<ThreadLoadResult>;
/** Resume or fork a protected thread and verify its effective profile. */
export function loadWithProtectedProfile(
  client: CodexJsonRpcClient,
  method: 'thread/resume' | 'thread/fork',
  params: ThreadResumeParams
): Promise<ThreadLoadResult>;
/** No absent or mismatched acknowledgment is accepted as protection. */
export async function loadWithProtectedProfile(
  client: CodexJsonRpcClient,
  method: 'thread/start' | 'thread/resume' | 'thread/fork',
  params: ThreadLoadOverrides | ThreadResumeParams
): Promise<ThreadLoadResult> {
  const result = await client.request(method, params);
  if (result.activePermissionProfile?.id !== params.permissions) {
    throw new Error('Codex did not confirm file protection. Update Codex and try again.');
  }
  return result;
}
