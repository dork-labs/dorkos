import { Bot } from 'lucide-react';
import type { ErrorCategory } from '@dorkos/shared/types';
import { Button } from '@/layers/shared/ui';

/**
 * Recovery actions for model selection and Codex version failures.
 *
 * @param props - The classified failure and the active session's model-menu opener.
 */
export function ModelErrorActions({
  category,
  onChooseModel,
}: {
  category: Extract<ErrorCategory, 'model_unavailable' | 'runtime_update_required'>;
  onChooseModel?: () => void;
}) {
  if (!onChooseModel) return null;
  return (
    <Button size="sm" onClick={onChooseModel} className="mt-3 gap-1.5">
      <Bot className="size-3" />
      {category === 'runtime_update_required' ? 'Choose another model' : 'Choose model'}
    </Button>
  );
}
