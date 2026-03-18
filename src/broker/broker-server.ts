import { createLogger } from '../util/logging.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { Runtime } from '../runtime/runtime.js';
import type { CapabilityTokenManager } from './capability-token.js';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './types.js';
import { assignProvenance } from './provenance.js';
import type { ToolExecutionRequest } from '../tools/types.js';
import type { ChatMessage, ChatOptions } from '../llm/types.js';

const log = createLogger('broker-server');

export interface BrokerServerOptions {
  tools: ToolExecutor;
  runtime: Runtime;
  tokenManager: CapabilityTokenManager;
  inputStream: NodeJS.ReadableStream;
  outputStream: NodeJS.WritableStream;
  workerId: string;
  onNotification?: (notification: JsonRpcNotification) => void;
}

export class BrokerServer {
  private readonly tools: ToolExecutor;
  private readonly runtime: Runtime;
  private readonly tokenManager: CapabilityTokenManager;
  private readonly inputStream: NodeJS.ReadableStream;
  private readonly outputStream: NodeJS.WritableStream;
  private readonly workerId: string;
  private readonly onNotification?: (notification: JsonRpcNotification) => void;
  private buffer = '';

  constructor(options: BrokerServerOptions) {
    this.tools = options.tools;
    this.runtime = options.runtime;
    this.tokenManager = options.tokenManager;
    this.inputStream = options.inputStream;
    this.outputStream = options.outputStream;
    this.workerId = options.workerId;
    this.onNotification = options.onNotification;

    this.inputStream.setEncoding?.('utf8');
    this.inputStream.on('data', (chunk: string | Buffer) => {
      this.handleData(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
  }

  sendNotification(method: string, params: Record<string, unknown>): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.outputStream.write(`${JSON.stringify(notification)}\n`);
  }

  private handleData(data: string): void {
    this.buffer += data;
    while (this.buffer.length > 0) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;

      try {
        const message = JSON.parse(line) as JsonRpcRequest | JsonRpcNotification;
        if ('id' in message) {
          void this.handleRequest(message);
        } else if ('method' in message) {
          this.handleNotification(message);
        }
      } catch (error) {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, 'Failed to parse broker message');
      }
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const capabilityToken = request.params?.capabilityToken as string | undefined;
    let tokenError: string | null = 'Missing capability token';
    let token = undefined;

    if (capabilityToken) {
      tokenError = this.tokenManager.validateAndUse(capabilityToken, this.workerId);
      token = this.tokenManager.get(capabilityToken);
    }

    if (tokenError || !token) {
      this.sendResponse({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: tokenError ?? 'Invalid capability token' },
      });
      return;
    }

    try {
      let result: unknown;

      switch (request.method) {
        case 'tool.search': {
          result = { tools: this.tools.searchTools(String(request.params.query ?? '')) };
          break;
        }

        case 'tool.listLoaded': {
          result = { tools: this.tools.listAlwaysLoadedDefinitions() };
          break;
        }

        case 'tool.call': {
          const toolName = String(request.params.toolName ?? '');
          const args = isRecord(request.params.args) ? request.params.args : {};
          const requestId = typeof request.params.requestId === 'string' ? request.params.requestId : undefined;

          // memory_save supervisor safety net: deny unless explicitly allowed by the worker
          if (toolName === 'memory_save' && request.params.allowImplicitMemorySave !== true) {
            result = {
              success: false,
              status: 'denied',
              message: 'memory_save is reserved for explicit remember/save requests.',
            };
            break;
          }

          const executionRequest: ToolExecutionRequest = {
            origin: 'assistant',
            toolName,
            args,
            agentId: token.agentId,
            userId: typeof request.params.userId === 'string' ? request.params.userId : token.authorizedBy,
            principalId: typeof request.params.principalId === 'string' ? request.params.principalId : token.authorizedBy,
            principalRole: request.params.principalRole === 'approver'
              ? 'approver'
              : request.params.principalRole === 'viewer'
                ? 'viewer'
                : request.params.principalRole === 'operator'
                  ? 'operator'
                  : 'owner',
            channel: 'broker',
            requestId,
            contentTrustLevel: request.params.contentTrustLevel === 'quarantined'
              ? 'quarantined'
              : request.params.contentTrustLevel === 'low_trust'
                ? 'low_trust'
                : 'trusted',
            taintReasons: Array.isArray(request.params.taintReasons)
              ? request.params.taintReasons.filter((value): value is string => typeof value === 'string')
              : undefined,
            derivedFromTaintedContent: request.params.derivedFromTaintedContent === true,
            scheduleId: typeof request.params.scheduleId === 'string' ? request.params.scheduleId : undefined,
            ...(request.params.codeContext && typeof request.params.codeContext === 'object'
              ? { codeContext: request.params.codeContext as { workspaceRoot: string; sessionId?: string } }
              : {}),
          };

          const toolDefinition = this.tools.getToolDefinition(toolName);
          const runResponse = await this.tools.runTool(executionRequest);
          const provenance = assignProvenance(toolName, toolDefinition?.category);
          const providerKind = provenance.source === 'remote' ? 'external' : 'local';
          const scannedOutput = this.runtime.outputGuardian.scanToolResult(toolName, runResponse, { providerKind });
          const approvalSummary = runResponse.approvalId
            ? this.tools.getApprovalSummaries([runResponse.approvalId]).get(runResponse.approvalId)
            : undefined;

          this.runtime.auditLog.record({
            type: 'broker_action',
            severity: 'info',
            agentId: token.agentId,
            userId: token.authorizedBy,
            details: {
              method: 'tool.call',
              toolName,
              capabilityTokenId: token.id,
              workerId: token.workerId,
              sessionId: token.sessionId,
              provenance,
            },
          });

          result = {
            ...runResponse,
            output: scannedOutput.allowPlannerRawContent
              ? scannedOutput.sanitized
              : {
                quarantined: true,
                trustLevel: scannedOutput.trustLevel,
                taintReasons: scannedOutput.taintReasons,
                preview: typeof (runResponse.output as Record<string, unknown> | undefined)?.message === 'string'
                  ? String((runResponse.output as Record<string, unknown>).message)
                  : undefined,
              },
            provenance,
            approvalSummary,
            trustLevel: scannedOutput.trustLevel,
            taintReasons: scannedOutput.taintReasons,
          };
          break;
        }

        case 'approval.decide': {
          const approvalId = String(request.params.approvalId ?? '');
          const decision = request.params.decision === 'denied' ? 'denied' : 'approved';
          const actor = String(request.params.actor ?? token.authorizedBy);
          const actorRole = request.params.actorRole === 'approver'
            ? 'approver'
            : request.params.actorRole === 'viewer'
              ? 'viewer'
              : request.params.actorRole === 'operator'
                ? 'operator'
                : 'owner';
          const reason = typeof request.params.reason === 'string' ? request.params.reason : undefined;
          const decided = await this.tools.decideApproval(approvalId, decision, actor, actorRole, reason);
          result = {
            success: decided.success,
            message: decided.message,
            status: decided.result?.status ?? decided.job?.status,
            jobId: decided.job?.id ?? decided.result?.jobId,
          };
          break;
        }

        case 'approval.result': {
          const approvalId = String(request.params.approvalId ?? '');
          const approvals = this.tools.listApprovals(500);
          const approval = approvals.find((entry) => entry.id === approvalId);
          const job = this.tools.listJobs(500).find((entry) => entry.approvalId === approvalId);
          result = {
            found: !!approval,
            status: approval?.status ?? 'not_found',
            decidedBy: approval?.decidedBy,
            jobId: job?.id,
            toolName: job?.toolName,
            message: job?.status === 'succeeded'
              ? (job.resultPreview || 'Executed successfully.')
              : job?.error,
            success: job?.status === 'succeeded',
          };
          break;
        }

        case 'approval.status': {
          const approvalId = String(request.params.approvalId ?? '');
          const approvals = this.tools.listApprovals(500);
          const approval = approvals.find((entry) => entry.id === approvalId);
          result = {
            status: approval?.status ?? 'not_found',
            decidedBy: approval?.decidedBy,
          };
          break;
        }

        case 'llm.chat': {
          // Proxy LLM calls through the supervisor so the worker stays network-disabled.
          const chatMessages = Array.isArray(request.params.messages)
            ? request.params.messages as ChatMessage[]
            : [];
          const chatOptions = isRecord(request.params.options)
            ? request.params.options as unknown as ChatOptions
            : undefined;
          const useFallback = request.params.useFallback === true;

          const instance = this.runtime.registry.get(token.agentId);
          const primaryName = instance?.definition.providerName ?? this.runtime.defaultProviderName;
          let provider = this.runtime.getProvider(primaryName);

          if (useFallback) {
            // Find any provider different from the primary for quality-based retry
            for (const name of this.runtime.getProviderNames()) {
              if (name !== primaryName) {
                const p = this.runtime.getProvider(name);
                if (p) { provider = p; break; }
              }
            }
          }

          if (!provider) {
            this.sendResponse({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32002, message: 'No LLM provider available for this agent' },
            });
            return;
          }

          const chatResponse = await provider.chat(chatMessages, chatOptions);
          result = chatResponse;
          break;
        }

        case 'job.list': {
          const userId = typeof request.params.userId === 'string' ? request.params.userId : undefined;
          const channel = typeof request.params.channel === 'string' ? request.params.channel : undefined;
          const limit = typeof request.params.limit === 'number' ? request.params.limit : 50;
          const jobs = this.tools.listJobs(limit)
            .filter(job => (!userId || job.userId === userId) && (!channel || job.channel === channel));
          result = {
            jobs: jobs.map(j => ({
              toolName: j.toolName,
              status: j.status,
              argsRedacted: j.argsRedacted,
              completedAt: j.completedAt,
              createdAt: j.createdAt,
            })),
          };
          break;
        }

        default:
          this.sendResponse({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: `Method '${request.method}' not found` },
          });
          return;
      }

      this.sendResponse({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      this.sendResponse({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32001,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === 'worker.heartbeat') {
      log.debug({ workerId: this.workerId }, 'Worker heartbeat');
    }
    this.onNotification?.(notification);
  }

  private sendResponse(response: JsonRpcResponse): void {
    this.outputStream.write(`${JSON.stringify(response)}\n`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
