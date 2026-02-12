import { useState } from 'react';
import { Check, MessageSquare } from 'lucide-react';
import { useTransport } from '../../contexts/TransportContext';
import type { QuestionItem } from '@lifeos/shared/types';

interface QuestionPromptProps {
  sessionId: string;
  toolCallId: string;
  questions: QuestionItem[];
  /** Pre-submitted answers from history — renders collapsed immediately */
  answers?: Record<string, string>;
}

export function QuestionPrompt({ sessionId, toolCallId, questions, answers: preAnswers }: QuestionPromptProps) {
  const transport = useTransport();
  const [selections, setSelections] = useState<Record<string, string | string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(!!preAnswers);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSingleSelect(questionIdx: number, value: string) {
    setSelections(prev => ({ ...prev, [questionIdx]: value }));
  }

  function handleMultiSelect(questionIdx: number, value: string, checked: boolean) {
    setSelections(prev => {
      const current = (prev[questionIdx] as string[]) || [];
      if (checked) {
        return { ...prev, [questionIdx]: [...current, value] };
      }
      return { ...prev, [questionIdx]: current.filter(v => v !== value) };
    });
  }

  function handleOtherText(questionIdx: number, text: string) {
    setOtherText(prev => ({ ...prev, [questionIdx]: text }));
  }

  function isComplete(): boolean {
    return questions.every((q, idx) => {
      const sel = selections[idx];
      if (!sel) return false;
      if (q.multiSelect) {
        const arr = sel as string[];
        if (arr.length === 0) return false;
        if (arr.includes('__other__') && !otherText[idx]?.trim()) return false;
      } else {
        if (sel === '__other__' && !otherText[idx]?.trim()) return false;
      }
      return true;
    });
  }

  async function handleSubmit() {
    if (!isComplete() || submitting) return;
    setSubmitting(true);
    setError(null);

    // Build answers record: key is question index as string, value is selected label(s)
    const answers: Record<string, string> = {};
    questions.forEach((q, idx) => {
      const sel = selections[idx];
      if (q.multiSelect) {
        const arr = (sel as string[]).map(v =>
          v === '__other__' ? otherText[idx]?.trim() || '' : v
        );
        answers[String(idx)] = JSON.stringify(arr);
      } else {
        answers[String(idx)] = sel === '__other__' ? otherText[idx]?.trim() || '' : (sel as string);
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
  }

  // Collapsed submitted state
  if (submitted) {
    return (
      <div className="my-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm transition-colors duration-200">
        <div className="flex items-center gap-2">
          <Check className="h-4 w-4 text-emerald-500" />
          <div className="flex flex-wrap gap-2">
            {questions.map((q, idx) => {
              let displayValue: string;
              // Use preAnswers (from history) if available, otherwise use selections (from live interaction)
              if (preAnswers) {
                const raw = preAnswers[String(idx)] || '';
                // Multi-select answers are JSON-stringified arrays
                if (q.multiSelect) {
                  try {
                    displayValue = (JSON.parse(raw) as string[]).join(', ');
                  } catch {
                    displayValue = raw;
                  }
                } else {
                  displayValue = raw;
                }
              } else {
                const sel = selections[idx];
                if (q.multiSelect) {
                  const arr = (sel as string[]).map(v =>
                    v === '__other__' ? otherText[idx] : v
                  );
                  displayValue = arr.join(', ');
                } else {
                  displayValue = sel === '__other__' ? otherText[idx] : (sel as string);
                }
              }
              return (
                <span key={idx} className="inline-flex items-center gap-1">
                  <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                    {q.header}:
                  </span>
                  <span className="text-emerald-600 dark:text-emerald-400">{displayValue}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // Pending state: render full question form
  return (
    <div className="my-1 rounded border border-amber-500/20 bg-amber-500/10 p-3 text-sm transition-colors duration-200">
      <div className="space-y-4">
        {questions.map((q, qIdx) => (
          <div key={qIdx}>
            <div className="flex items-center gap-2 mb-1">
              <MessageSquare className="h-3.5 w-3.5 text-amber-500" />
              <span className="font-semibold text-sm">{q.header}</span>
            </div>
            <p className="mb-2 text-foreground">{q.question}</p>

            <div className="space-y-1.5 ml-1">
              {q.options.map((opt, oIdx) => {
                const isSelected = q.multiSelect
                  ? ((selections[qIdx] as string[]) || []).includes(opt.label)
                  : selections[qIdx] === opt.label;

                return (
                  <label
                    key={oIdx}
                    className={`flex items-start gap-2 rounded px-2 py-1.5 cursor-pointer transition-colors ${
                      isSelected ? 'bg-amber-500/15' : 'hover:bg-amber-500/5'
                    }`}
                  >
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`q-${qIdx}`}
                      checked={isSelected}
                      disabled={submitting}
                      onChange={(e) => {
                        if (q.multiSelect) {
                          handleMultiSelect(qIdx, opt.label, e.target.checked);
                        } else {
                          handleSingleSelect(qIdx, opt.label);
                        }
                      }}
                      className="mt-0.5 accent-amber-500"
                    />
                    <div>
                      <span className="font-medium">{opt.label}</span>
                      {opt.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                      )}
                    </div>
                  </label>
                );
              })}

              {/* "Other" free-text option */}
              <label
                className={`flex items-start gap-2 rounded px-2 py-1.5 cursor-pointer transition-colors ${
                  q.multiSelect
                    ? ((selections[qIdx] as string[]) || []).includes('__other__') ? 'bg-amber-500/15' : 'hover:bg-amber-500/5'
                    : selections[qIdx] === '__other__' ? 'bg-amber-500/15' : 'hover:bg-amber-500/5'
                }`}
              >
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={`q-${qIdx}`}
                  checked={
                    q.multiSelect
                      ? ((selections[qIdx] as string[]) || []).includes('__other__')
                      : selections[qIdx] === '__other__'
                  }
                  disabled={submitting}
                  onChange={(e) => {
                    if (q.multiSelect) {
                      handleMultiSelect(qIdx, '__other__', e.target.checked);
                    } else {
                      handleSingleSelect(qIdx, '__other__');
                    }
                  }}
                  className="mt-0.5 accent-amber-500"
                />
                <div className="flex-1">
                  <span className="font-medium">Other</span>
                  {(q.multiSelect
                    ? ((selections[qIdx] as string[]) || []).includes('__other__')
                    : selections[qIdx] === '__other__') && (
                    <textarea
                      placeholder="Type your answer..."
                      rows={2}
                      value={otherText[qIdx] || ''}
                      disabled={submitting}
                      onChange={(e) => handleOtherText(qIdx, e.target.value)}
                      className="mt-1 w-full rounded border border-amber-500/30 bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500/50 resize-y"
                      autoFocus
                    />
                  )}
                </div>
              </label>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-500">{error}</p>
      )}

      <button
        onClick={handleSubmit}
        disabled={!isComplete() || submitting}
        className="mt-3 flex items-center gap-1 rounded bg-amber-600 px-3 py-1.5 text-white text-xs hover:bg-amber-700 disabled:opacity-50 transition-colors"
      >
        {submitting ? (
          <>Submitting...</>
        ) : (
          <><Check className="h-3 w-3" /> Submit</>
        )}
      </button>
    </div>
  );
}
