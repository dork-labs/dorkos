import { useConnectorSpending, useSetSpendingPrice } from '@/layers/entities/connectors';
import { isPaidToolkit } from '../../lib/paid-actions';
import { priceHelpLine } from '../../lib/spending-lines';
import { SpendAmountField } from './SpendAmountField';

/**
 * An app's price per run (DOR-4204 spec §3): DorkOS can't see what a paid app
 * charges, so a person sets a best guess, and the limit counts each run at
 * it. Shown only for an app whose actions spend money.
 */
export function PricePerRun({ toolkit, appName }: { toolkit: string; appName: string }) {
  const paid = isPaidToolkit(toolkit);
  const spending = useConnectorSpending({ enabled: paid });
  const setPrice = useSetSpendingPrice();
  const summary = spending.data;
  if (!paid || summary === undefined) return null;
  return (
    <div data-testid="price-per-run">
      <SpendAmountField
        label="Price per run"
        placeholder="Unknown"
        savedMicro={summary.prices[toolkit] ?? null}
        maxMicro={summary.maxMicro}
        online={!spending.isError}
        onSave={(priceMicro) => setPrice.mutateAsync({ toolkit, priceMicro })}
        inputClassName="sm:w-28"
        help={<p>{priceHelpLine(appName, summary, toolkit)}</p>}
      />
    </div>
  );
}
