/**
 * Side-effectful admission operations.
 *
 * Handles logging and other effects after the pure pipeline has made its decision.
 */

import type { AdmissionResult, AgentAction } from './guardian.js';
import type { AdmissionPipelineResult } from './workflows.js';
import type { Logger } from 'pino';

/**
 * Convert a pipeline result to an AdmissionResult,
 * logging denials as a side effect.
 */
export function handleAdmissionResult(
  result: AdmissionPipelineResult,
  action: AgentAction,
  logger?: Logger,
): AdmissionResult {
  if (!result.allowed && logger) {
    logger.warn({
      agentId: action.agentId,
      actionType: action.type,
      controller: result.controller,
      reason: result.reason,
    }, 'Guardian denied action');
  }

  return {
    allowed: result.allowed,
    controller: result.controller,
    reason: result.reason,
    mutatedAction: result.mutatedAction,
  };
}
