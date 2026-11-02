/** Boot's registered modes for route fixtures that do not start runtimes. */
import { afterEach, beforeEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { runtimeRegistry } from '../../../services/core/runtime-registry.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../services/runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../services/runtimes/codex/runtime-constants.js';

/** Keep the real registry and route checks; declare the modes production boot supplies. */
export function taskRuntimeCapabilitiesFixture(): void {
  let restore = () => {};
  beforeEach(() => {
    const caps = { 'claude-code': CLAUDE_CODE_CAPABILITIES, codex: CODEX_CAPABILITIES };
    const runtimes = new Map(
      Object.entries(caps).map(([type, declared]) => {
        const runtime = new FakeAgentRuntime(type);
        runtime.getCapabilities.mockReturnValue(declared);
        return [type, runtime] as const;
      })
    );
    const get = runtimeRegistry.get.bind(runtimeRegistry);
    const spies = [
      vi
        .spyOn(runtimeRegistry, 'get')
        .mockImplementation((type) => runtimes.get(type) ?? get(type)),
      vi.spyOn(runtimeRegistry, 'getDefaultType').mockReturnValue('claude-code'),
      vi.spyOn(runtimeRegistry, 'has').mockImplementation((type) => Object.hasOwn(caps, type)),
      vi.spyOn(runtimeRegistry, 'getAllCapabilities').mockReturnValue(caps),
    ];
    restore = () => {
      for (const spy of spies) spy.mockRestore();
    };
  });
  afterEach(() => restore());
}
