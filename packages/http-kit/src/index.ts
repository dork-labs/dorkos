/**
 * The HTTP pieces every DorkOS server chain shares: the transport facts a
 * policy reads off a request, the bounded body and JSON reader, and the one
 * error shape.
 *
 * Server-only: it imports Hono and Node. A client that reads a problem
 * document imports the shape from `@dorkos/shared/problem` instead.
 *
 * @module http-kit
 */
export {
  forwardedClientAddress,
  nodeTransportFacts,
  type TransportFacts,
} from './request-facts.js';
export {
  jsonBodyParser,
  parseRequestBody,
  readJsonBody,
  underMount,
  type BodyRule,
  type NodeBodyParser,
  type ParseRequestBodyOptions,
  type ReadJsonBodyOptions,
  type RefusedBodyAnswer,
  type RefusedBodyRequest,
  type RequestBodyEnv,
} from './request-body.js';
export {
  problem,
  problemBody,
  validationProblem,
  type ProblemOptions,
  type ProblemStatus,
} from './problem.js';
