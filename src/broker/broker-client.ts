import type { ToolDefinition, ToolExecutionRequest, ToolRunResponse } from '../tools/types.js';
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './types.js';

export interface BrokerClientOptions {
  inputStream: NodeJS.ReadableStream;
  outputStream: NodeJS.WritableStream;
  capabilityToken: string;
  requestTimeoutMs?: number;
}

type NotificationHandler = (notification: JsonRpcNotification) => void;

export class BrokerClient {
  private readonly inputStream: NodeJS.ReadableStream;
  private readonly outputStream: NodeJS.WritableStream;
  private capabilityToken: string;
  private readonly requestTimeoutMs: number;
  private buffer = '';
  private nextId = 1;
  private notificationHandler?: NotificationHandler;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private alwaysLoadedTools: ToolDefinition[] = [];

  constructor(options: BrokerClientOptions) {
    this.inputStream = options.inputStream;
    this.outputStream = options.outputStream;
    this.capabilityToken = options.capabilityToken;
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 30_000);

    this.inputStream.setEncoding?.('utf8');
    this.inputStream.on('data', (chunk: string | Buffer) => {
      this.handleData(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
  }

  setAlwaysLoadedTools(tools: ToolDefinition[]): void {
    this.alwaysLoadedTools = [...tools];
  }

  getAlwaysLoadedTools(): ToolDefinition[] {
    return [...this.alwaysLoadedTools];
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  sendNotification(method: string, params: Record<string, unknown>): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.outputStream.write(`${JSON.stringify(notification)}\n`);
  }

  async listLoadedTools(): Promise<ToolDefinition[]> {
    const result = await this.sendRequest<{ tools: ToolDefinition[] }>('tool.listLoaded', {});
    this.alwaysLoadedTools = Array.isArray(result.tools) ? [...result.tools] : [];
    return this.getAlwaysLoadedTools();
  }

  async searchTools(query: string): Promise<ToolDefinition[]> {
    const result = await this.sendRequest<{ tools: ToolDefinition[] }>('tool.search', { query });
    return Array.isArray(result.tools) ? result.tools : [];
  }

  async callTool(request: ToolExecutionRequest): Promise<ToolRunResponse & { approvalSummary?: { toolName: string; argsPreview: string } }> {
    const result = await this.sendRequest<ToolRunResponse & { approvalSummary?: { toolName: string; argsPreview: string } }>('tool.call', {
      toolName: request.toolName,
      args: request.args,
      requestId: request.requestId,
      agentId: request.agentId,
    });
    return result;
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    actor: string,
    reason?: string,
  ): Promise<{ success: boolean; message: string; status?: string; jobId?: string }> {
    return this.sendRequest('approval.decide', { approvalId, decision, actor, reason });
  }

  async getApprovalResult(approvalId: string): Promise<{
    found: boolean;
    status: 'pending' | 'approved' | 'denied' | 'not_found';
    decidedBy?: string;
    jobId?: string;
    toolName?: string;
    message?: string;
    success?: boolean;
  }> {
    return this.sendRequest('approval.result', { approvalId });
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
        const message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
        if ('id' in message) {
          this.handleResponse(message);
        } else if ('method' in message) {
          this.handleNotification(message);
        }
      } catch (error) {
        console.error('BrokerClient: failed to parse message', error instanceof Error ? error.message : String(error));
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(String(response.id));
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(String(response.id));

    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === 'capability.refreshed') {
      this.capabilityToken = String(notification.params.capabilityToken ?? this.capabilityToken);
    }

    this.notificationHandler?.(notification);
  }

  private sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = String(this.nextId++);
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Broker request '${method}' timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          capabilityToken: this.capabilityToken,
        },
      };
      this.outputStream.write(`${JSON.stringify(request)}\n`);
    });
  }
}
