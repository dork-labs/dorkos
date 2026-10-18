/**
 * Doc entity: the docs in one space, read over the Transport (DOR-2982).
 * Wiki links resolve against this index; the rules that match a typed target
 * to a doc live in `@dorkos/shared/doc-links`, shared with the server.
 *
 * @module entities/doc
 */
export { docKeys } from './api/query-keys';
export { useDocIndex, useInvalidateDocIndex } from './model/use-doc-index';
