/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { RuntimePicker } from '../ui/RuntimePicker';

afterEach(cleanup);

describe('RuntimePicker — package safety checks (DOR-4379)', () => {
  it("says Codex doesn't run them yet when Codex is chosen", () => {
    render(<RuntimePicker value="codex" onChange={() => {}} />);
    expect(screen.getByTestId('runtime-package-hooks-note')).toHaveTextContent(
      "Package safety checks don't run on this runtime yet."
    );
  });

  it.each(['claude-code', 'opencode', 'doe'] as const)('says nothing for %s', (runtime) => {
    render(<RuntimePicker value={runtime} onChange={() => {}} />);
    expect(screen.queryByTestId('runtime-package-hooks-note')).toBeNull();
  });
});
