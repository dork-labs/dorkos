// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { QuestionPrompt, type QuestionPromptHandle } from '../ui/QuestionPrompt';
import type { QuestionItem } from '@dorkos/shared/types';

// Mock Radix RadioGroup for jsdom
vi.mock('@radix-ui/react-radio-group', () => {
  const React = require('react');
  const RadioGroupContext = React.createContext({ value: '', onValueChange: (_v: string) => {} });

  function Root({
    children,
    value,
    onValueChange,
    className,
    ...props
  }: Record<string, unknown> & {
    children?: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
    className?: string;
  }) {
    return React.createElement(
      RadioGroupContext.Provider,
      { value: { value: value || '', onValueChange: onValueChange || (() => {}) } },
      React.createElement('div', { role: 'radiogroup', className, ...props }, children)
    );
  }

  function Item({
    value,
    id,
    disabled,
    className,
    ...props
  }: Record<string, unknown> & {
    value?: string;
    id?: string;
    disabled?: boolean;
    className?: string;
  }) {
    const ctx = React.useContext(RadioGroupContext);
    const checked = ctx.value === value;
    return React.createElement('button', {
      role: 'radio',
      'aria-checked': checked,
      'data-state': checked ? 'checked' : 'unchecked',
      id,
      disabled,
      className,
      onClick: () => !disabled && ctx.onValueChange(value || ''),
      ...props,
    });
  }

  return { Root, Item };
});

// Mock Radix Checkbox for jsdom
vi.mock('@radix-ui/react-checkbox', () => {
  const React = require('react');

  function Root({
    checked,
    onCheckedChange,
    id,
    disabled,
    className,
    ...props
  }: Record<string, unknown> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    id?: string;
    disabled?: boolean;
    className?: string;
  }) {
    return React.createElement('button', {
      role: 'checkbox',
      'aria-checked': !!checked,
      'data-state': checked ? 'checked' : 'unchecked',
      id,
      disabled,
      className,
      onClick: () => !disabled && onCheckedChange?.(!checked),
      ...props,
    });
  }

  function Indicator({
    children,
    ...props
  }: Record<string, unknown> & { children?: React.ReactNode }) {
    return React.createElement('span', props, children);
  }

  return { Root, Indicator };
});

// Mock Radix Tabs with controlled state support for jsdom.
// The mock components explicitly exclude `ref` from the props spread to avoid
// React 19 warnings when `tabs.tsx` wraps them with `forwardRef` and passes
// the forwarded ref down as a regular prop.
vi.mock('@radix-ui/react-tabs', () => {
  const React = require('react');
  const TabsContext = React.createContext({ value: '', onValueChange: (_v: string) => {} });

  function Root({
    children,
    value,
    onValueChange,
    ...props
  }: Record<string, unknown> & {
    children?: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) {
    const { ref: _ref, ...rest } = props as Record<string, unknown> & { ref?: unknown };
    return React.createElement(
      TabsContext.Provider,
      { value: { value: value || '', onValueChange: onValueChange || (() => {}) } },
      React.createElement('div', rest, children)
    );
  }
  function List({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) {
    const { ref: _ref, ...rest } = props as Record<string, unknown> & { ref?: unknown };
    return React.createElement('div', { role: 'tablist', ...rest }, children);
  }
  function Trigger({
    children,
    value,
    ...props
  }: Record<string, unknown> & { children?: React.ReactNode; value?: string }) {
    const { ref: _ref, ...rest } = props as Record<string, unknown> & { ref?: unknown };
    const ctx = React.useContext(TabsContext);
    const isActive = ctx.value === value;
    return React.createElement(
      'button',
      {
        role: 'tab',
        'data-state': isActive ? 'active' : 'inactive',
        'data-value': value,
        onClick: () => ctx.onValueChange(value || ''),
        ...rest,
      },
      children
    );
  }
  function Content({
    children,
    value,
    ...props
  }: Record<string, unknown> & { children?: React.ReactNode; value?: string }) {
    const { ref: _ref, ...rest } = props as Record<string, unknown> & { ref?: unknown };
    const ctx = React.useContext(TabsContext);
    if (ctx.value !== value) return null;
    return React.createElement(
      'div',
      { role: 'tabpanel', 'data-state': 'active', ...rest },
      children
    );
  }

  return { Root, List, Trigger, Content };
});

const mockSubmitAnswers = vi.fn().mockResolvedValue({ ok: true });
vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: () => ({
    submitAnswers: mockSubmitAnswers,
  }),
}));

afterEach(() => {
  cleanup();
  mockSubmitAnswers.mockClear();
});

const singleSelectQuestion: QuestionItem = {
  header: 'Approach',
  question: 'How should I handle the conflicting meeting times?',
  options: [
    {
      label: 'Reschedule the internal meeting',
      description: 'External meetings are harder to move.',
    },
    { label: 'Decline the external meeting' },
  ],
  multiSelect: false,
};

const multiSelectQuestion: QuestionItem = {
  header: 'Features',
  question: 'Which features should we include?',
  options: [{ label: 'Dark mode' }, { label: 'Notifications' }, { label: 'Search' }],
  multiSelect: true,
};

const baseProps = {
  sessionId: 'session-1',
  toolCallId: 'tc-1',
};

describe('QuestionPrompt', () => {
  it('I-03: calls transport.submitAnswers() with correct answer format on submit (single-select)', async () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Select first option
    const radio = screen.getAllByRole('radio')[0];
    fireEvent.click(radio);

    // Submit
    const submitButton = screen.getByRole('button', { name: /^Send answer/ });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockSubmitAnswers).toHaveBeenCalledWith('session-1', 'tc-1', {
        '0': 'Reschedule the internal meeting',
      });
    });
  });

  it('calls onDecided with the canonical answers so the part can persist them', async () => {
    const onDecided = vi.fn();
    render(
      <QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} onDecided={onDecided} />
    );
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Send answer/ }));

    await waitFor(() => {
      expect(onDecided).toHaveBeenCalledWith({ '0': 'Reschedule the internal meeting' });
    });
  });

  it('for multi-select, answer is the selected labels joined with ", "', async () => {
    render(<QuestionPrompt {...baseProps} questions={[multiSelectQuestion]} />);
    // Select first two checkboxes
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // Dark mode
    fireEvent.click(checkboxes[1]); // Notifications

    const submitButton = screen.getByRole('button', { name: /^Send answer/ });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockSubmitAnswers).toHaveBeenCalledWith('session-1', 'tc-1', {
        '0': 'Dark mode, Notifications',
      });
    });
  });

  it('for "Other" selection, answer is the user’s typed text (single-select)', async () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Select "Other"
    const otherRadio = screen.getAllByRole('radio')[2];
    fireEvent.click(otherRadio);

    // Type custom text
    const textInput = screen.getByPlaceholderText('Type your answer…');
    fireEvent.change(textInput, { target: { value: 'My custom answer' } });

    const submitButton = screen.getByRole('button', { name: /^Send answer/ });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockSubmitAnswers).toHaveBeenCalledWith('session-1', 'tc-1', {
        '0': 'My custom answer',
      });
    });
  });

  it('collapses to compact single-row summary after successful submission', async () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Select and submit
    const radio = screen.getAllByRole('radio')[0];
    fireEvent.click(radio);
    fireEvent.click(screen.getByRole('button', { name: /^Send answer/ }));

    await waitFor(() => {
      // After submission, the form should collapse
      expect(screen.queryByRole('radio')).toBeNull();
      // Single-question submitted shows "header: value" format on one line
      expect(screen.getByText('Approach: Reschedule the internal meeting')).toBeDefined();
    });

    // Container uses neutral bg-muted/50 with shadow-msg-tool (ToolCallCard pattern)
    const container = screen.getByTestId('question-prompt-submitted');
    expect(container).not.toBeNull();
    expect(container.className).toContain('shadow-msg-tool');
    expect(container.className).toContain('bg-muted/50');
  });

  it('treats already_resolved error as successful submission', async () => {
    const alreadyResolvedError = Object.assign(new Error('Interaction already resolved'), {
      code: 'already_resolved',
      status: 409,
    });
    mockSubmitAnswers.mockRejectedValueOnce(alreadyResolvedError);

    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    const radio = screen.getAllByRole('radio')[0];
    fireEvent.click(radio);
    fireEvent.click(screen.getByRole('button', { name: /^Send answer/ }));

    await waitFor(() => {
      // Should collapse to submitted state, not show an error
      expect(screen.queryByRole('radio')).toBeNull();
      expect(screen.getByTestId('question-prompt-submitted')).toBeDefined();
    });
  });

  it('shows error text when submission fails', async () => {
    mockSubmitAnswers.mockRejectedValueOnce(new Error('Network error'));

    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Select and submit
    const radio = screen.getAllByRole('radio')[0];
    fireEvent.click(radio);
    fireEvent.click(screen.getByRole('button', { name: /^Send answer/ }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeDefined();
    });

    // Form should still be visible (not collapsed)
    expect(screen.getAllByRole('radio').length).toBe(3);
  });

  it('submit button stays disabled when "Other" is selected but no text entered', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Select "Other" without typing anything
    const otherRadio = screen.getAllByRole('radio')[2];
    fireEvent.click(otherRadio);

    const submitButton = screen.getByRole('button', { name: /^Send answer/ });
    expect(submitButton.hasAttribute('disabled')).toBe(true);
  });

  it('joins an option label to its description with a colon, not a middot (DOR-1261)', () => {
    // The description is a gloss on the label, not a second peer fact — a
    // middot (used elsewhere for two short facts of equal weight) reads wrong
    // here. Checked via the shared <label> textContent since the label and
    // description live in separate spans that getByText cannot join.
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    const optionLabel = screen.getByText('Reschedule the internal meeting');
    expect(optionLabel.closest('label')?.textContent).toContain(
      'Reschedule the internal meeting: External meetings are harder to move.'
    );
  });
});

describe('Multi-question Back/Next navigation', () => {
  // Verifies Back is disabled on first question
  it('Back button is disabled on the first question', () => {
    render(
      <QuestionPrompt {...baseProps} questions={[singleSelectQuestion, multiSelectQuestion]} />
    );
    const backBtn = screen.getByRole('button', { name: /back/i });
    expect(backBtn.hasAttribute('disabled')).toBe(true);
  });

  // Verifies Next button navigates to next question
  it('Next button navigates to next question and shows its content', () => {
    render(
      <QuestionPrompt {...baseProps} questions={[singleSelectQuestion, multiSelectQuestion]} />
    );
    // First question visible
    expect(screen.getByText(singleSelectQuestion.question)).toBeDefined();
    expect(screen.queryByText(multiSelectQuestion.question)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    // Second question now visible
    expect(screen.getByText(multiSelectQuestion.question)).toBeDefined();
    expect(screen.queryByText(singleSelectQuestion.question)).toBeNull();
  });

  // Verifies submit requires ALL questions answered
  it('submit disabled until all questions answered', () => {
    const ref = createRef<QuestionPromptHandle>();
    render(
      <QuestionPrompt
        ref={ref}
        {...baseProps}
        questions={[singleSelectQuestion, multiSelectQuestion]}
        isActive
      />
    );
    // Answer first question only
    fireEvent.click(screen.getAllByRole('radio')[0]);
    // Navigate to last question
    act(() => {
      ref.current!.navigateQuestion('next');
    });
    expect(screen.getByRole('button', { name: /^Send answer/ }).hasAttribute('disabled')).toBe(
      true
    );
  });
});

describe('Answer summary layout', () => {
  // Verifies multi-question pre-answered stacks each answer on its own line
  // (one "header / value" pair per row; legacy JSON multi-select tolerated).
  it('renders each answer on its own line for pre-answered questions (multi-question)', () => {
    render(
      <QuestionPrompt
        {...baseProps}
        questions={[singleSelectQuestion, multiSelectQuestion]}
        answers={{
          '0': 'Reschedule the internal meeting',
          '1': JSON.stringify(['Dark mode', 'Search']),
        }}
      />
    );
    // Each question's header and value render as separate elements (not one line).
    expect(screen.getByText(singleSelectQuestion.header)).toBeInTheDocument();
    expect(screen.getByText('Reschedule the internal meeting')).toBeInTheDocument();
    expect(screen.getByText(multiSelectQuestion.header)).toBeInTheDocument();
    expect(screen.getByText('Dark mode, Search')).toBeInTheDocument();
    // The cramped single-line join is gone.
    expect(
      screen.queryByText('Approach: Reschedule the internal meeting · Features: Dark mode, Search')
    ).not.toBeInTheDocument();
  });

  // A recorded question can arrive with no header (DOR-2075); the summary must
  // show the answer alone rather than a dangling ": answer".
  it('shows just the answer when the question has no header', () => {
    render(
      <QuestionPrompt
        {...baseProps}
        questions={[{ ...singleSelectQuestion, header: '' }]}
        answers={{ '0': 'Reschedule the internal meeting' }}
      />
    );
    expect(screen.getByText('Reschedule the internal meeting')).toBeDefined();
  });

  // A single-select freeform answer that looks like JSON must display verbatim —
  // the JSON tolerance is multi-select-only.
  it('shows a single-select answer that looks like JSON verbatim', () => {
    render(
      <QuestionPrompt
        {...baseProps}
        questions={[singleSelectQuestion]}
        answers={{ '0': '[experimental]' }}
      />
    );
    expect(screen.getByText('Approach: [experimental]')).toBeDefined();
  });
});

describe('QuestionPrompt interactive UX (Phase 2)', () => {
  describe('focusedOptionIndex prop', () => {
    it('adds the focus ring to the focused option', () => {
      render(
        <QuestionPrompt
          {...baseProps}
          questions={[singleSelectQuestion]}
          isActive={true}
          focusedOptionIndex={1}
        />
      );
      // Query option wrapper divs with data-selected attribute
      const optionDivs = document.querySelectorAll('[data-selected]');
      // Index 1 carries the focus mark; index 0 does not
      expect(optionDivs[1].hasAttribute('data-focused')).toBe(true);
      expect(optionDivs[0].hasAttribute('data-focused')).toBe(false);
    });
  });

  describe('imperative handle', () => {
    it('toggleOption selects a regular option (single-select)', () => {
      const ref = createRef<QuestionPromptHandle>();
      render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} ref={ref} />);

      act(() => {
        ref.current!.toggleOption(0);
      });

      // First radio should now be aria-checked (Radix renders as button role="radio")
      const radios = screen.getAllByRole('radio');
      expect(radios[0].getAttribute('aria-checked')).toBe('true');
    });

    it('toggleOption toggles a checkbox (multi-select)', () => {
      const ref = createRef<QuestionPromptHandle>();
      render(<QuestionPrompt {...baseProps} questions={[multiSelectQuestion]} ref={ref} />);

      act(() => {
        ref.current!.toggleOption(0);
      }); // Select Dark mode
      act(() => {
        ref.current!.toggleOption(2);
      }); // Select Search

      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0].getAttribute('aria-checked')).toBe('true');
      expect(checkboxes[1].getAttribute('aria-checked')).toBe('false'); // Notifications
      expect(checkboxes[2].getAttribute('aria-checked')).toBe('true');
    });

    it('toggleOption untoggle works for multi-select', () => {
      const ref = createRef<QuestionPromptHandle>();
      render(<QuestionPrompt {...baseProps} questions={[multiSelectQuestion]} ref={ref} />);

      act(() => {
        ref.current!.toggleOption(0);
      }); // Select Dark mode
      act(() => {
        ref.current!.toggleOption(0);
      }); // Deselect Dark mode

      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0].getAttribute('aria-checked')).toBe('false');
    });

    it('navigateQuestion switches active tab', () => {
      const ref = createRef<QuestionPromptHandle>();
      render(
        <QuestionPrompt
          {...baseProps}
          questions={[singleSelectQuestion, multiSelectQuestion]}
          ref={ref}
        />
      );

      expect(ref.current!.getActiveTab()).toBe('0');

      act(() => {
        ref.current!.navigateQuestion('next');
      });
      expect(ref.current!.getActiveTab()).toBe('1');

      // Should show second tab content now
      expect(screen.getByText(multiSelectQuestion.question)).toBeDefined();
    });

    it('navigateQuestion does not go below 0', () => {
      const ref = createRef<QuestionPromptHandle>();
      render(
        <QuestionPrompt
          {...baseProps}
          questions={[singleSelectQuestion, multiSelectQuestion]}
          ref={ref}
        />
      );

      act(() => {
        ref.current!.navigateQuestion('prev');
      });
      expect(ref.current!.getActiveTab()).toBe('0');
    });

    it('submit calls transport.submitAnswers when all answered', async () => {
      const ref = createRef<QuestionPromptHandle>();
      render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} ref={ref} />);

      act(() => {
        ref.current!.toggleOption(0);
      }); // Select first option
      act(() => {
        ref.current!.submit();
      });

      await waitFor(() => {
        expect(mockSubmitAnswers).toHaveBeenCalledWith('session-1', 'tc-1', {
          '0': 'Reschedule the internal meeting',
        });
      });
    });

    it('submit does not call transport when incomplete', () => {
      const ref = createRef<QuestionPromptHandle>();
      render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} ref={ref} />);

      act(() => {
        ref.current!.submit();
      }); // No selection made
      expect(mockSubmitAnswers).not.toHaveBeenCalled();
    });
  });
});

describe('ARIA roles', () => {
  it('renders radiogroup role for single-select questions', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    expect(screen.getByRole('radiogroup')).toBeDefined();
  });
});
