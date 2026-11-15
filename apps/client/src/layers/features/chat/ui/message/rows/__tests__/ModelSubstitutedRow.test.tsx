// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import {
  projectInProgressTurn,
  projectSessionMessages,
} from '../../../../model/stream/project-session-turn';
import { ModelSubstitutedRow } from '../ModelSubstitutedRow';

describe('ModelSubstitutedRow', () => {
  it('names both models by their display names and where to change it (DOR-2636)', () => {
    render(<ModelSubstitutedRow fromName="Opus" toName="Suggested" />);
    expect(screen.getByTestId('model-substituted-row')).toHaveTextContent(
      'DorkOS credits don’t cover Opus, so this ran on Suggested. Switch in the model menu.'
    );
  });
  it('explains an account replacement without claiming credits paid for it', () => {
    render(
      <ModelSubstitutedRow fromName="old-model" toName="Available" reason="account-not-available" />
    );
    expect(screen.getByTestId('model-substituted-row')).toHaveTextContent(
      'Using Available. old-model isn’t available on this account.'
    );
    expect(screen.getByTestId('model-substituted-row')).not.toHaveTextContent('credits');
  });
  it('keeps the real notice row when text arrives in the same replay batch and history reopens', () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        type: 'model_substituted',
        from: 'old-model',
        fromName: 'old-model',
        to: 'available',
        toName: 'Available',
        reason: 'account-not-available',
      },
      { seq: 2, type: 'text_delta', text: 'Hi' },
    ];
    const parts = projectInProgressTurn(events);
    expect(parts.map((part) => part.type)).toEqual(['model_substituted', 'text']);
    const row = (items: typeof parts) => (
      <>
        {items.map((part, index) =>
          part.type === 'model_substituted' ? <ModelSubstitutedRow key={index} {...part} /> : null
        )}
      </>
    );
    const view = render(row(parts));
    expect(screen.getByTestId('model-substituted-row')).toHaveTextContent(
      'Using Available. old-model isn’t available on this account.'
    );
    const history: HistoryMessage[] = [
      { id: 'notice', role: 'assistant', content: '', parts: [parts[0]!] },
      { id: 'reply', role: 'assistant', content: 'Hi' },
    ];
    const reopened = projectSessionMessages(history, []);
    view.rerender(row(reopened.flatMap((message) => message.parts)));
    expect(screen.getAllByTestId('model-substituted-row')).toHaveLength(1);
    expect(screen.getByTestId('model-substituted-row')).toHaveTextContent(
      'Using Available. old-model isn’t available on this account.'
    );
  });
});
