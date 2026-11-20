import { spendLimitMoney, spendMoney } from '@dorkos/shared/connector-spending';
import type { ApprovalSpend } from '@dorkos/shared/approval-schemas';
import { appRoutes } from '@/layers/shared/lib';
import { useSafeNavigate } from '@/layers/shared/model';

/** The receipt when the limit was reached between the card and the tap (spec §4.4). */
export const SPEND_LIMIT_RECEIPT = 'The monthly limit was reached. Nothing was spent.';

/** The code the grant route answers when the limit stops an Allow once. */
export const SPEND_LIMIT_CODE = 'SPEND_LIMIT';

/** One run's price as the card says it: reported, a person's estimate, or unknown. */
function priceText(spend: ApprovalSpend): string {
  if (spend.priceMicro === null) return 'Price unknown';
  const price = spendMoney(spend.priceMicro);
  return spend.priceSource === 'person' ? `About ${price}` : price;
}

/**
 * The paid-run card's receipt after an answer (spec §4.4).
 *
 * @param decision - The answer.
 * @param spend - What the card said about money.
 */
export function spendReceipt(
  decision: 'granted' | 'denied' | 'spend-refused',
  spend: ApprovalSpend
): string {
  if (decision === 'spend-refused') return SPEND_LIMIT_RECEIPT;
  if (decision === 'denied') return 'Not allowed. Nothing was spent.';
  return spend.priceMicro === null
    ? 'Allowed once · price unknown'
    : `Allowed once · ${spendMoney(spend.priceMicro)}`;
}

/**
 * The paid-run card's money line (DOR-4204 spec §4.2): what one run costs and
 * what is left this month, or that no limit is set, with Set a limit. Read
 * before Allow once by a screen reader, through its id.
 */
export function ApprovalSpendLine({ spend, id }: { spend: ApprovalSpend; id: string }) {
  const navigate = useSafeNavigate();
  const left =
    spend.limitMicro === null
      ? 'No monthly limit'
      : `${spendLimitMoney(spend.leftMicro ?? '0')} left this month`;
  return (
    <p
      id={id}
      data-slot="approval-spend"
      className="text-foreground mt-1 flex flex-wrap items-center gap-x-1 text-xs tabular-nums"
    >
      <span>{priceText(spend)}</span>
      <span className="max-sm:basis-full">
        <span className="max-sm:hidden" aria-hidden>
          ·{' '}
        </span>
        {left}
      </span>
      {spend.limitMicro === null && navigate && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            data-slot="approval-set-limit"
            className="focus-ring text-primary -my-3 inline-flex min-h-11 items-center rounded-sm underline-offset-2 hover:underline md:my-0 md:min-h-0"
            onClick={() =>
              void navigate({ ...appRoutes.connections(), search: { section: 'spending-limit' } })
            }
          >
            Set a limit
          </button>
        </>
      )}
    </p>
  );
}
