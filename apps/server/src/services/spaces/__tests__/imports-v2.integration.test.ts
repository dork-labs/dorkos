/**
 * The import suite on a format 2 archive: what releases before DOR-2876 part 3 wrote, and what a
 * job queued before format 3 existed still writes. See `imports-data-files.suite.ts`.
 */
import { importSuite } from './imports-data-files.suite.js';

importSuite(2);
