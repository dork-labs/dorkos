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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { ref: _ref, ...rest } = props as Record<string, unknown> & { ref?: unknown };
    return React.createElement(
      TabsContext.Provider,
      { value: { value: value || '', onValueChange: onValueChange || (() => {}) } },
      React.createElement('div', rest, children)
    );
  }
  function List({
    children,
    ...props
  }: Record<string, unknown> & { children?: React.ReactNode }) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { ref: _ref, ...rest } = props as Record<string, unknown> & { ref?: unknown };
    return React.createElement('div', { role: 'tablist', ...rest }, children);
  }
  function Trigger({
    children,
    value,
    ...props
  }: Record<string, unknown> & { children?: React.ReactNode; value?: string }) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  it('renders question text without header row', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Header row is removed in the redesign — question text is the primary element
    expect(screen.queryByText('Approach')).toBeNull();
    expect(screen.getByText('How should I handle the conflicting meeting times?')).toBeDefined();
  });

  it('renders radio buttons for single-select questions', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    const radios = screen.getAllByRole('radio');
    // 2 options + 1 "Other" = 3 radio buttons
    expect(radios.length).toBe(3);
    expect(screen.getByText('Reschedule the internal meeting')).toBeDefined();
    expect(screen.getByText('Decline the external meeting')).toBeDefined();
    expect(screen.getByText('Other')).toBeDefined();
  });

  it('renders checkboxes for multi-select questions', () => {
    render(<QuestionPrompt {...baseProps} questions={[multiSelectQuestion]} />);
    const checkboxes = screen.getAllByRole('checkbox');
    // 3 options + 1 "Other" = 4 checkboxes
    expect(checkboxes.length).toBe(4);
    expect(screen.getByText('Dark mode')).toBeDefined();
    expect(screen.getByText('Notifications')).toBeDefined();
    expect(screen.getByText('Search')).toBeDefined();
  });

  it('renders "Other" option with text input when selected (single-select)', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Text input should not be visible initially
    expect(screen.queryByPlaceholderText('Type your answer...')).toBeNull();

    // Select "Other"
    const otherRadio = screen.getAllByRole('radio')[2]; // Last radio is "Other"
    fireEvent.click(otherRadio);

    // Text input should now be visible
    expect(screen.getByPlaceholderText('Type your answer...')).toBeDefined();
  });

  it('submit button is disabled when no selection made', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    const submitButton = screen.getByRole('button', { name: /submit/i });
    expect(submitButton.hasAttribute('disabled')).toBe(true);
  });

  it('submit button is enabled when selection is made', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    const radio = screen.getAllByRole('radio')[0];
    fireEvent.click(radio);

    const submitButton = screen.getByRole('button', { name: /submit/i });
    expect(submitButton.hasAttribute('disabled')).toBe(false);
  });

  it('calls transport.submitAnswers() with correct answer format on submit (single-select)', async () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Select first option
    const radio = screen.getAllByRole('radio')[0];
    fireEvent.click(radio);

    // Submit
    const submitButton = screen.getByRole('button', { name: /submit/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockSubmitAnswers).toHaveBeenCalledWith('session-1', 'tc-1', {
        '0': 'Reschedule the internal meeting',
      });
    });
  });

  it('for multi-select, answer is JSON-stringified array', async () => {
    render(<QuestionPrompt {...baseProps} questions={[multiSelectQuestion]} />);
    // Select first two checkboxes
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // Dark mode
    fireEvent.click(checkboxes[1]); // Notifications

    const submitButton = screen.getByRole('button', { name: /submit/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockSubmitAnswers).toHaveBeenCalledWith('session-1', 'tc-1', {
        '0': JSON.stringify(['Dark mode', 'Notifications']),
      });
    });
  });

  it('for "Other" selection, answer is the user\'s typed text (single-select)', async () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Select "Other"
    const otherRadio = screen.getAllByRole('radio')[2];
    fireEvent.click(otherRadio);

    // Type custom text
    const textInput = screen.getByPlaceholderText('Type your answer...');
    fireEvent.change(textInput, { target: { value: 'My custom answer' } });

    const submitButton = screen.getByRole('button', { name: /submit/i });
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
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

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

  it('shows error text when submission fails', async () => {
    mockSubmitAnswers.mockRejectedValueOnce(new Error('Network error'));

    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Select and submit
    const radio = screen.getAllByRole('radio')[0];
    fireEvent.click(radio);
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeDefined();
    });

    // Form should still be visible (not collapsed)
    expect(screen.getAllByRole('radio').length).toBe(3);
  });

  it('shows "Submitting..." text during submission', async () => {
    // Make submitAnswers hang so we can observe the submitting state
    let resolveSubmit: (value: unknown) => void;
    mockSubmitAnswers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        })
    );

    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Select and submit
    const radio = screen.getAllByRole('radio')[0];
    fireEvent.click(radio);
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    // Should show "Submitting..." while waiting
    expect(screen.getByText('Submitting...')).toBeDefined();

    // Resolve the promise to clean up
    resolveSubmit!({ ok: true });
    await waitFor(() => {
      expect(screen.queryByText('Submitting...')).toBeNull();
    });
  });

  it('submit button stays disabled when "Other" is selected but no text entered', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Select "Other" without typing anything
    const otherRadio = screen.getAllByRole('radio')[2];
    fireEvent.click(otherRadio);

    const submitButton = screen.getByRole('button', { name: /submit/i });
    expect(submitButton.hasAttribute('disabled')).toBe(true);
  });

  it('renders option descriptions inline when provided', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    // Descriptions are rendered inline after label text with " — " separator
    expect(screen.getByText(/External meetings are harder to move\./)).toBeDefined();
  });
});

describe('Multi-question Back/Next navigation', () => {
  // Verifies step indicator shows the current question header
  it('renders step indicator with question header for multiple questions', () => {
    render(
      <QuestionPrompt {...baseProps} questions={[singleSelectQuestion, multiSelectQuestion]} />
    );
    // Step indicator shows the header of the active question
    expect(screen.getByText('Approach')).toBeDefined();
  });

  // Verifies single question has no Back/Next overhead
  it('does not render Back/Next buttons for single question', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
  });

  // Verifies Back is disabled on first question
  it('Back button is disabled on the first question', () => {
    render(
      <QuestionPrompt {...baseProps} questions={[singleSelectQuestion, multiSelectQuestion]} />
    );
    const backBtn = screen.getByRole('button', { name: /back/i });
    expect(backBtn.hasAttribute('disabled')).toBe(true);
  });

  // Verifies Next appears on non-last questions, Submit on last
  it('renders Next button on non-last question and Submit on last', () => {
    const ref = createRef<QuestionPromptHandle>();
    render(
      <QuestionPrompt
        ref={ref}
        {...baseProps}
        questions={[singleSelectQuestion, multiSelectQuestion]}
        isActive
      />
    );
    // First question: Next visible, no Submit
    expect(screen.getByRole('button', { name: /next/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull();

    // Navigate to last question
    act(() => {
      ref.current!.navigateQuestion('next');
    });
    // Last question: Submit visible, no Next
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
    expect(screen.getByRole('button', { name: /submit/i })).toBeDefined();
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
    expect(screen.getByRole('button', { name: /submit/i }).hasAttribute('disabled')).toBe(true);
  });

  // Verifies step indicator updates on navigation
  it('step indicator updates to show current question header', () => {
    const ref = createRef<QuestionPromptHandle>();
    render(
      <QuestionPrompt
        ref={ref}
        {...baseProps}
        questions={[singleSelectQuestion, multiSelectQuestion]}
      />
    );
    expect(screen.getByText('Approach')).toBeDefined();

    act(() => {
      ref.current!.navigateQuestion('next');
    });
    expect(screen.getByText('Features')).toBeDefined();
  });
});

describe('Answer summary layout', () => {
  // Verifies compact single-row layout renders "header: value" on one line
  it('renders compact single-row summary after submission', async () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    await waitFor(() => {
      // Single-question: "header: value" on one line
      expect(screen.getByText('Approach: Reschedule the internal meeting')).toBeDefined();
    });
  });

  // Verifies multi-question pre-answered shows "N questions answered"
  it('renders compact summary for pre-answered questions (multi-question)', () => {
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
    // Multi-question: shows "N questions answered" (not individual answers)
    expect(screen.getByText('2 questions answered')).toBeDefined();
  });

  // Verifies single pre-answered question shows "header: value"
  it('renders compact summary for pre-answered single question', () => {
    render(
      <QuestionPrompt
        {...baseProps}
        questions={[singleSelectQuestion]}
        answers={{ '0': 'Reschedule the internal meeting' }}
      />
    );
    // Single-question: "header: value"
    expect(screen.getByText('Approach: Reschedule the internal meeting')).toBeDefined();
  });
});

describe('QuestionPrompt interactive UX (Phase 2)', () => {
  describe('isActive prop', () => {
    it('adds ring-2 class when isActive is true', () => {
      const { container } = render(
        <QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} isActive={true} />
      );
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('ring-2');
      expect(wrapper.className).toContain('ring-ring/30');
    });

    it('does not have ring-2 class when isActive is false', () => {
      const { container } = render(
        <QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} isActive={false} />
      );
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).not.toContain('ring-2');
    });
  });

  describe('Kbd number hints', () => {
    it('shows Kbd number hints on options when isActive is true', () => {
      render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} isActive={true} />);
      const kbds = document.querySelectorAll('kbd');
      // 2 regular options + 1 "Other" option + 1 submit button = 4 kbd elements
      // Options get "1", "2", Other gets "3", submit gets "Enter"
      expect(kbds.length).toBeGreaterThanOrEqual(3);
      expect(kbds[0].textContent).toBe('1');
      expect(kbds[1].textContent).toBe('2');
      expect(kbds[2].textContent).toBe('3'); // Other option
    });

    it('shows Kbd hints even when isActive is false (always visible for right-aligned hints)', () => {
      render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} isActive={false} />);
      const kbds = document.querySelectorAll('kbd');
      // Kbd number hints on options are always visible (no isActive conditional per Task 3.4)
      expect(kbds.length).toBeGreaterThanOrEqual(3);
    });

    it('shows Enter Kbd on submit button when isActive is true', () => {
      render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} isActive={true} />);
      const submitButton = screen.getByRole('button', { name: /submit/i });
      const kbd = submitButton.querySelector('kbd');
      expect(kbd).not.toBeNull();
      expect(kbd!.textContent).toBe('Enter');
    });
  });

  describe('focusedOptionIndex prop', () => {
    it('adds ring-1 to the focused option', () => {
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
      // Index 1 should have the ring-1 class
      expect(optionDivs[1].className).toContain('ring-1');
      expect(optionDivs[1].className).toContain('ring-status-info/50');
      // Index 0 should not
      expect(optionDivs[0].className).not.toContain('ring-1');
    });

    it('adds ring-1 to the "Other" option when focused', () => {
      render(
        <QuestionPrompt
          {...baseProps}
          questions={[singleSelectQuestion]}
          isActive={true}
          focusedOptionIndex={2}
        />
      );
      const optionDivs = document.querySelectorAll('[data-selected]');
      // "Other" is at index 2 (after 2 regular options)
      expect(optionDivs[2].className).toContain('ring-1');
    });

    it('does not add ring-1 when isActive is false', () => {
      render(
        <QuestionPrompt
          {...baseProps}
          questions={[singleSelectQuestion]}
          isActive={false}
          focusedOptionIndex={0}
        />
      );
      const optionDivs = document.querySelectorAll('[data-selected]');
      expect(optionDivs[0].className).not.toContain('ring-1');
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

    it('toggleOption selects "Other" when index equals options.length', () => {
      const ref = createRef<QuestionPromptHandle>();
      render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} ref={ref} />);

      // singleSelectQuestion has 2 options, so index 2 = "Other"
      act(() => {
        ref.current!.toggleOption(2);
      });

      const radios = screen.getAllByRole('radio');
      // "Other" radio is the last one
      expect(radios[2].getAttribute('aria-checked')).toBe('true');
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

    it('navigateQuestion does not go beyond last tab', () => {
      const ref = createRef<QuestionPromptHandle>();
      render(
        <QuestionPrompt
          {...baseProps}
          questions={[singleSelectQuestion, multiSelectQuestion]}
          ref={ref}
        />
      );

      act(() => {
        ref.current!.navigateQuestion('next');
      });
      act(() => {
        ref.current!.navigateQuestion('next');
      }); // Already at last, should stay
      expect(ref.current!.getActiveTab()).toBe('1');
    });

    it('navigateQuestion is no-op for single question', () => {
      const ref = createRef<QuestionPromptHandle>();
      render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} ref={ref} />);

      act(() => {
        ref.current!.navigateQuestion('next');
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

    it('getOptionCount includes the "Other" option', () => {
      const ref = createRef<QuestionPromptHandle>();
      render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} ref={ref} />);

      // 2 regular options + 1 "Other" = 3
      expect(ref.current!.getOptionCount()).toBe(3);
    });

    it('getOptionCount reflects active tab for multi-question', () => {
      const ref = createRef<QuestionPromptHandle>();
      render(
        <QuestionPrompt
          {...baseProps}
          questions={[singleSelectQuestion, multiSelectQuestion]}
          ref={ref}
        />
      );

      // First tab: 2 options + Other = 3
      expect(ref.current!.getOptionCount()).toBe(3);

      act(() => {
        ref.current!.navigateQuestion('next');
      });
      // Second tab: 3 options + Other = 4
      expect(ref.current!.getOptionCount()).toBe(4);
    });
  });

  describe('stale question opacity', () => {
    it('applies opacity-60 when isActive is false and not submitted', () => {
      const { container } = render(
        <QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} isActive={false} />
      );
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('opacity-60');
    });

    it('does not apply opacity-60 when isActive is true', () => {
      const { container } = render(
        <QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} isActive={true} />
      );
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).not.toContain('opacity-60');
    });

    it('uses border-status-info on pending container', () => {
      const { container } = render(
        <QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />
      );
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('border-status-info');
    });
  });
});

describe('ARIA roles', () => {
  it('renders radiogroup role for single-select questions', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    expect(screen.getByRole('radiogroup')).toBeDefined();
  });

  it('renders group role for multi-select questions', () => {
    render(<QuestionPrompt {...baseProps} questions={[multiSelectQuestion]} />);
    expect(screen.getByRole('group')).toBeDefined();
  });

  it('sets aria-label on options container to the question text', () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    const radiogroup = screen.getByRole('radiogroup');
    expect(radiogroup.getAttribute('aria-label')).toBe(
      'How should I handle the conflicting meeting times?'
    );
  });
});

describe('submitted state tokens', () => {
  it('uses neutral bg-muted/50 with shadow-msg-tool in submitted state', async () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    await waitFor(() => {
      const container = screen.getByTestId('question-prompt-submitted');
      expect(container.className).toContain('bg-muted/50');
      expect(container.className).toContain('shadow-msg-tool');
      expect(container.className).toContain('py-1');
    });
  });

  it('renders status-success check icon in submitted state', async () => {
    render(<QuestionPrompt {...baseProps} questions={[singleSelectQuestion]} />);
    fireEvent.click(screen.getAllByRole('radio')[0]);
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    await waitFor(() => {
      const container = screen.getByTestId('question-prompt-submitted');
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.classList.toString()).toContain('text-status-success');
    });
  });
});
