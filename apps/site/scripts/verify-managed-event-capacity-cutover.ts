/** Refuse managed-event readiness until every quiesced tenant ledger matches its inbox. */
import { getTransactionDb } from '../src/db/transaction-client';
import { verifyManagedEventCapacityCutover } from '../src/lib/connectors/managed/event-capacity-service';

if (process.env.DORKOS_MANAGED_CONNECTOR_EVENTS_LIVE_READY === '1') {
  throw new Error('Turn managed event readiness off before capacity cutover verification.');
}

const result = await verifyManagedEventCapacityCutover(getTransactionDb());
console.log(
  `Managed event capacity verified for ${result.tenantsVerified} tenant ledger${result.tenantsVerified === 1 ? '' : 's'}.`
);
