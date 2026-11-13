/**
 * The MCP servers a person adds once for every agent (DOR-3213), as the app reads and writes them.
 *
 * @module entities/global-mcp
 */
export {
  GLOBAL_MCP_KEY,
  globalMcpSheetKey,
  useAddGlobalMcpServer,
  useCheckGlobalMcpArgs,
  useGlobalMcpServers,
  useGlobalMcpServerTools,
  useGlobalMcpStandingAllows,
  usePatchGlobalMcpServer,
  useRemoveGlobalMcpServer,
  useUndoGlobalMcpStandingAllow,
} from './model/use-global-mcp-servers';
