import { useState, useImperativeHandle, useCallback, forwardRef } from 'react';
import { Check } from 'lucide-react';
import { useTransport } from '@/layers/shared/model';
import {
  Tabs,
  TabsContent,
  Kbd,
  Button,
  RadioGroup,
  RadioGroupItem,
  Checkbox,
} from '@/layers/shared/ui';
import { OptionRow, CompactResultRow, InteractiveCard } from './primitives';
import type { QuestionItem } from '@dorkos/shared/types';

// TabsList and TabsTrigger are not used — Back/Next buttons replace the tab strip.

interface QuestionPromptProps {
  sessionId: string;
  toolCallId: string;
  questions: QuestionItem[];
  /** Pre-submitted answers from history — renders collapsed immediately */
  answers?: Record<string, string>;
  /** Whether this is the active shortcut target */
  isActive?: boolean;
  /** Which option is focused via keyboard */
  focusedOptionIndex?: number;
}

export interface QuestionPromptHandle {
  toggleOption: (index: number) => void;
  navigateOption: (direction: 'up' | 'down') => void;
  navigateQuestion: (direction: 'prev' | 'next') => void;
  submit: () => void;
  getOptionCount: () => number;
  getActiveTab: () => string;
}

export const QuestionPrompt = forwardRef<QuestionPromptHandle, QuestionPromptProps>(
  function QuestionPrompt(
    {
      sessionId,
      toolCallId,
      questions,
      answers: preAnswers,
      isActive = false,
      focusedOptionIndex = -1,
    },
    ref
  ) {
    const transport = useTransport();
    const [selections, setSelections] = useState<Record<string, string | string[]>>({});
    const [otherText, setOtherText] = useState<Record<string, string>>({});
    const [submitted, setSubmitted] = useState(!!preAnswers);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState('0');

    const activeQuestion = questions[Number(activeTab)] || questions[0];
    const activeQIdx = Number(activeTab);
    // Include the "Other" option in the count
    const currentOptionCount = activeQuestion ? activeQuestion.options.length + 1 : 0;

    function handleSingleSelect(questionIdx: number, value: string) {
      setSelections((prev) => ({ ...prev, [questionIdx]: value }));
    }

    function handleMultiSelect(questionIdx: number, value: string, checked: boolean) {
      setSelections((prev) => {
        const current = (prev[questionIdx] as string[]) || [];
        if (checked) {
          return { ...prev, [questionIdx]: [...current, value] };
        }
        return { ...prev, [questionIdx]: current.filter((v) => v !== value) };
      });
    }

    function handleOtherText(questionIdx: number, text: string) {
      setOtherText((prev) => ({ ...prev, [questionIdx]: text }));
    }

    function hasAnswer(idx: number): boolean {
      const sel = selections[idx];
      if (!sel) return false;
      if (questions[idx].multiSelect) {
        const arr = sel as string[];
        return arr.length > 0 && (!arr.includes('__other__') || !!otherText[idx]?.trim());
      }
      return sel !== '__other__' || !!otherText[idx]?.trim();
    }

    function isComplete(): boolean {
      return questions.every((_q, idx) => hasAnswer(idx));
    }

    function getDisplayValue(q: QuestionItem, idx: number): string | null {
      if (preAnswers && preAnswers[String(idx)]) {
        const raw = preAnswers[String(idx)];
        if (q.multiSelect) {
          try {
            return (JSON.parse(raw) as string[]).join(', ');
          } catch {
            return raw;
          }
        }
        return raw;
      }
      if (!preAnswers) {
        const sel = selections[idx];
        if (!sel) return null;
        if (q.multiSelect) {
          return (sel as string[]).map((v) => (v === '__other__' ? otherText[idx] : v)).join(', ');
        }
        return sel === '__other__' ? otherText[idx] : (sel as string);
      }
      return null;
    }

    const handleSubmit = useCallback(async () => {
      if (!isComplete() || submitting) return;
      setSubmitting(true);
      setError(null);

      // Build answers record: key is question index as string, value is selected label(s)
      const answers: Record<string, string> = {};
      questions.forEach((q, idx) => {
        const sel = selections[idx];
        if (q.multiSelect) {
          const arr = (sel as string[]).map((v) =>
            v === '__other__' ? otherText[idx]?.trim() || '' : v
          );
          answers[String(idx)] = JSON.stringify(arr);
        } else {
          answers[String(idx)] =
            sel === '__other__' ? otherText[idx]?.trim() || '' : (sel as string);
        }
      });

      try {
        await transport.submitAnswers(sessionId, toolCallId, answers);
        setSubmitted(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to submit answers');
      } finally {
        setSubmitting(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentional: isComplete is a local function
    }, [selections, otherText, submitting, transport, sessionId, toolCallId, questions]);

    useImperativeHandle(
      ref,
      () => ({
        toggleOption(index: number) {
          if (!activeQuestion || submitted || submitting) return;
          // If index is the last (Other option), toggle __other__
          if (index === activeQuestion.options.length) {
            if (activeQuestion.multiSelect) {
              const current = (selections[activeQIdx] as string[]) || [];
              if (current.includes('__other__')) {
                handleMultiSelect(activeQIdx, '__other__', false);
              } else {
                handleMultiSelect(activeQIdx, '__other__', true);
              }
            } else {
              handleSingleSelect(activeQIdx, '__other__');
            }
            return;
          }
          const opt = activeQuestion.options[index];
          if (!opt) return;
          if (activeQuestion.multiSelect) {
            const current = (selections[activeQIdx] as string[]) || [];
            if (current.includes(opt.label)) {
              handleMultiSelect(activeQIdx, opt.label, false);
            } else {
              handleMultiSelect(activeQIdx, opt.label, true);
            }
          } else {
            handleSingleSelect(activeQIdx, opt.label);
          }
        },
        navigateOption(_direction: 'up' | 'down') {
          // Handled externally via focusedOptionIndex prop
        },
        navigateQuestion(direction: 'prev' | 'next') {
          if (questions.length <= 1) return;
          const current = Number(activeTab);
          if (direction === 'next' && current < questions.length - 1) {
            setActiveTab(String(current + 1));
          } else if (direction === 'prev' && current > 0) {
            setActiveTab(String(current - 1));
          }
        },
        submit() {
          const currentIdx = Number(activeTab);
          if (currentIdx < questions.length - 1) {
            // Advance to next question — actual submission only on the last
            setActiveTab(String(currentIdx + 1));
            return;
          }
          handleSubmit();
        },
        getOptionCount() {
          return currentOptionCount;
        },
        getActiveTab() {
          return activeTab;
        },
      }),
      [
        activeQuestion,
        activeQIdx,
        activeTab,
        selections,
        submitted,
        submitting,
        currentOptionCount,
        handleSubmit,
        questions.length,
      ]
    );

    // Navigate to a specific question index by direction
    function navigateToQuestion(direction: 'prev' | 'next') {
      const current = Number(activeTab);
      if (direction === 'next' && current < questions.length - 1) {
        setActiveTab(String(current + 1));
      } else if (direction === 'prev' && current > 0) {
        setActiveTab(String(current - 1));
      }
    }

    // Render the "Other" free-text option using the appropriate primitive
    function renderOtherOption(q: QuestionItem, qIdx: number) {
      const isOtherSelected = q.multiSelect
        ? ((selections[qIdx] as string[]) || []).includes('__other__')
        : selections[qIdx] === '__other__';
      const optionId = `q-${qIdx}-other`;
      const oIdx = q.options.length;

      return (
        <OptionRow
          isSelected={isOtherSelected}
          isFocused={isActive && focusedOptionIndex === oIdx}
          data-selected={isOtherSelected}
          control={
            q.multiSelect ? (
              <Checkbox
                checked={isOtherSelected}
                id={optionId}
                disabled={submitting}
                onCheckedChange={(checked) => handleMultiSelect(qIdx, '__other__', !!checked)}
              />
            ) : (
              <RadioGroupItem value="__other__" id={optionId} disabled={submitting} />
            )
          }
        >
          <div className="flex-1">
            <label htmlFor={optionId} className="flex cursor-pointer items-center">
              <span className="text-sm font-medium">Other</span>
              {oIdx < 9 && (
                <Kbd className="ml-auto shrink-0 text-2xs text-muted-foreground">{oIdx + 1}</Kbd>
              )}
            </label>
            {isOtherSelected && (
              <textarea
                placeholder="Type your answer..."
                rows={2}
                value={otherText[qIdx] || ''}
                disabled={submitting}
                onChange={(e) => handleOtherText(qIdx, e.target.value)}
                className="bg-background mt-1 w-full resize-y rounded border border-border px-2 py-1 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
                // eslint-disable-next-line jsx-a11y/no-autofocus -- Intentional: focus the answer input when "Other" is selected
                autoFocus
              />
            )}
          </div>
        </OptionRow>
      );
    }

    // Render a single question's form content
    function renderQuestionContent(q: QuestionItem, qIdx: number) {
      return (
        <div>
          <p className="text-foreground mb-1.5">{q.question}</p>

          {!q.multiSelect ? (
            <RadioGroup
              value={(selections[qIdx] as string) ?? ''}
              onValueChange={(value) => handleSingleSelect(qIdx, value)}
              aria-label={q.question}
              className="ml-1 space-y-1"
            >
              {q.options.map((opt, oIdx) => {
                const isSelected = selections[qIdx] === opt.label;
                const optionId = `q-${qIdx}-opt-${oIdx}`;
                return (
                  <OptionRow
                    key={oIdx}
                    isSelected={isSelected}
                    isFocused={isActive && focusedOptionIndex === oIdx}
                    data-selected={isSelected}
                    control={<RadioGroupItem value={opt.label} id={optionId} disabled={submitting} />}
                  >
                    <label htmlFor={optionId} className="flex flex-1 cursor-pointer items-center">
                      <span className="text-sm font-medium">{opt.label}</span>
                      {opt.description && (
                        <span className="text-muted-foreground ml-1.5 text-xs">
                          {' '}
                          — {opt.description}
                        </span>
                      )}
                      {oIdx < 9 && (
                        <Kbd className="ml-auto shrink-0 text-2xs text-muted-foreground">{oIdx + 1}</Kbd>
                      )}
                    </label>
                  </OptionRow>
                );
              })}

              {/* "Other" free-text option */}
              {renderOtherOption(q, qIdx)}
            </RadioGroup>
          ) : (
            <div role="group" aria-label={q.question} className="ml-1 space-y-1">
              {q.options.map((opt, oIdx) => {
                const isSelected = ((selections[qIdx] as string[]) || []).includes(opt.label);
                const optionId = `q-${qIdx}-opt-${oIdx}`;
                return (
                  <OptionRow
                    key={oIdx}
                    isSelected={isSelected}
                    isFocused={isActive && focusedOptionIndex === oIdx}
                    data-selected={isSelected}
                    control={
                      <Checkbox
                        checked={isSelected}
                        id={optionId}
                        disabled={submitting}
                        onCheckedChange={(checked) =>
                          handleMultiSelect(qIdx, opt.label, !!checked)
                        }
                      />
                    }
                  >
                    <label htmlFor={optionId} className="flex flex-1 cursor-pointer items-center">
                      <span className="text-sm font-medium">{opt.label}</span>
                      {opt.description && (
                        <span className="text-muted-foreground ml-1.5 text-xs">
                          {' '}
                          — {opt.description}
                        </span>
                      )}
                      {oIdx < 9 && (
                        <Kbd className="ml-auto shrink-0 text-2xs text-muted-foreground">{oIdx + 1}</Kbd>
                      )}
                    </label>
                  </OptionRow>
                );
              })}

              {/* "Other" free-text option */}
              {renderOtherOption(q, qIdx)}
            </div>
          )}
        </div>
      );
    }

    // Collapsed submitted state — compact single-row matching ToolCallCard pattern
    if (submitted) {
      const hasSpecificAnswers = preAnswers
        ? Object.values(preAnswers).some((v) => v !== '')
        : Object.keys(selections).length > 0;

      // Build a compact summary string
      const summaryParts: string[] = [];
      if (hasSpecificAnswers) {
        if (questions.length === 1) {
          // Single question: show "header: value"
          const displayValue = getDisplayValue(questions[0], 0);
          if (displayValue) {
            summaryParts.push(`${questions[0].header}: ${displayValue}`);
          }
        } else {
          // Multi-question: show "N questions answered"
          summaryParts.push(`${questions.length} questions answered`);
        }
      } else {
        summaryParts.push('Questions answered');
      }

      return (
        <CompactResultRow
          data-testid="question-prompt-submitted"
          icon={<Check className="size-(--size-icon-sm) shrink-0 text-status-success" />}
          label={<span className="truncate">{summaryParts[0]}</span>}
        />
      );
    }

    // Pending state: render full question form
    return (
      <InteractiveCard isActive={isActive} isResolved={submitted}>
        {questions.length === 1 ? (
          // Single question — render directly without navigation
          renderQuestionContent(questions[0], 0)
        ) : (
          // Multiple questions — sequential Back/Next navigation
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            {/* Step indicator + Back/Next buttons (replaces tab strip) */}
            <div className="mb-2 flex items-center justify-between">
              <span className="text-muted-foreground text-xs">
                {questions[Number(activeTab)].header ?? `Question ${Number(activeTab) + 1} of ${questions.length}`}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigateToQuestion('prev')}
                  disabled={Number(activeTab) === 0}
                  className="h-7 px-2 text-xs"
                >
                  Back {isActive && <Kbd className="ml-1">&larr;</Kbd>}
                </Button>
                {Number(activeTab) < questions.length - 1 ? (
                  <Button
                    size="sm"
                    onClick={() => navigateToQuestion('next')}
                    className="h-7 px-2 text-xs"
                  >
                    Next {isActive && <Kbd className="ml-1">&rarr;</Kbd>}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={handleSubmit}
                    disabled={!isComplete() || submitting}
                    className="h-7 px-2 text-xs"
                  >
                    <Check className="size-(--size-icon-xs)" />
                    {submitting ? 'Submitting...' : 'Submit'}
                    {isActive && <Kbd className="ml-1">Enter</Kbd>}
                  </Button>
                )}
              </div>
            </div>

            {questions.map((q, idx) => (
              <TabsContent key={idx} value={String(idx)} className="mt-0">
                {renderQuestionContent(q, idx)}
              </TabsContent>
            ))}
          </Tabs>
        )}

        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

        {/* Submit button for single-question flows */}
        {questions.length === 1 && (
          <Button size="sm" onClick={handleSubmit} disabled={!isComplete() || submitting} className="mt-2">
            {submitting ? (
              'Submitting...'
            ) : (
              <>
                <Check className="size-(--size-icon-xs)" /> Submit
                {isActive && <Kbd className="ml-1.5">Enter</Kbd>}
              </>
            )}
          </Button>
        )}
      </InteractiveCard>
    );
  }
);
