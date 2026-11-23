/**
 * A spending amount after "Confirm it's you" closed without confirming
 * (DOR-4909): the saved value comes back, and a calm line says nothing
 * changed, so the field never looks saved.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';
import { SpendAmountField } from '../ui/spending/SpendAmountField';

afterEach(() => {
  cleanup();
});

function renderField(onSave: (micro: string | null) => Promise<unknown>) {
  render(
    <SpendAmountField
      label="Monthly limit"
      placeholder="Ask every time"
      savedMicro={null}
      maxMicro="1000000000000"
      help="Made-up help."
      online
      onSave={onSave}
    />
  );
  return screen.getByLabelText('Monthly limit');
}

describe('SpendAmountField after a cancelled "Confirm it’s you"', () => {
  it('puts the saved value back and says nothing changed', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('held'), { code: STEP_UP_REQUIRED_CODE }));
    const field = renderField(onSave);
    await userEvent.type(field, '20');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Not confirmed. Nothing changed.');
    expect(field).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the line on the next save', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('held'), { code: STEP_UP_REQUIRED_CODE }))
      .mockResolvedValueOnce(undefined);
    const field = renderField(onSave);
    await userEvent.type(field, '20');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toBeInTheDocument();

    await userEvent.type(field, '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
