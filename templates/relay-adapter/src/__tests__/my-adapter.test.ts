/**
 * Compliance suite for MyAdapter.
 *
 * Tests that MyAdapter correctly implements the full RelayAdapter contract.
 * Replace 'MyAdapter' and the factory options with your adapter's values.
 */
import { runAdapterComplianceSuite } from '@dorkos/relay/testing';
import { MyAdapter } from '../my-adapter.js';

runAdapterComplianceSuite({
  name: 'MyAdapter',
  createAdapter: () => new MyAdapter('test-mine', {}),
  deliverSubject: 'relay.custom.mine.test',
});
