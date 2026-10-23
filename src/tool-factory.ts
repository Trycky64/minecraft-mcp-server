import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodError, ZodRawShape, ZodType } from "zod";
import { BotConnection } from './bot-connection.js';
import { logEvent, sanitizePublicErrorText } from './logger.js';
import { BridgeAdapterError, bridgeErrorPolicy } from './bridge/bridge-adapter-contract.js';

type McpResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
};

export class ToolFactory {
  constructor(
    private server: McpServer,
    private connection: BotConnection
  ) {}

  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: (args: any) => Promise<McpResponse>,
    options: { requiresConnection?: boolean } = {},
  ): void {
    this.server.tool(name, description, schema, async (args: unknown): Promise<McpResponse> => {
      const startedAt = Date.now();
      if (options.requiresConnection !== false) {
        const connectionCheck = await this.connection.checkConnectionAndReconnect();

        if (!connectionCheck.connected) {
          const diagnostic = classifyToolError(connectionCheck.message ?? 'minecraft-session-disconnected');
          logEvent('warn', 'mcp-tool', name, { code: diagnostic.code, durationMs: Date.now() - startedAt, outcome: 'failure' });
          return {
            content: [{ type: "text", text: sanitizePublicErrorText(connectionCheck.message ?? 'minecraft-session-disconnected') }],
            isError: true,
            _meta: { diagnostic },
          };
        }
      }

      try {
        const parsedArgs = this.shouldValidateSchema(schema)
          ? this.parseArgs(schema as ZodRawShape, args)
          : args;
        return await executor(parsedArgs);
      } catch (error) {
        const diagnostic = classifyToolError(error instanceof Error ? error : String(error));
        logEvent(diagnostic.category === 'timeout' ? 'warn' : 'error', 'mcp-tool', name, {
          code: diagnostic.code, durationMs: Date.now() - startedAt, outcome: diagnostic.category === 'timeout' ? 'timeout' : 'failure',
        });
        return this.createErrorResponse(error as Error);
      }
    });
  }

  createResponse(text: string): McpResponse {
    return {
      content: [{ type: "text", text }]
    };
  }

  createErrorResponse(error: Error | string): McpResponse {
    const errorMessage = sanitizePublicErrorText(error instanceof BridgeAdapterError ? error.code : error instanceof Error ? error.message : error);
    return {
      content: [{ type: "text", text: `Failed: ${errorMessage}` }],
      isError: true,
      _meta: { diagnostic: classifyToolError(error) },
    };
  }

  private shouldValidateSchema(schema: Record<string, unknown>): boolean {
    const values = Object.values(schema);
    if (values.length === 0) {
      return true;
    }

    return values.every((value) => value instanceof ZodType);
  }

  private parseArgs(schema: ZodRawShape, args: unknown): unknown {
    try {
      return z.object(schema).passthrough().parse(args ?? {});
    } catch (error) {
      if (error instanceof ZodError) {
        throw new Error(this.formatZodError(error));
      }
      throw error;
    }
  }

  private formatZodError(error: ZodError): string {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('; ');

    return `Invalid tool arguments: ${details}`;
  }
}

function classifyToolError(error: Error | string): {
  code: string; category: string; retryable: boolean; temporary: boolean | null; sessionInvalidated: boolean | null;
} {
  if (error instanceof BridgeAdapterError) {
    const policy = bridgeErrorPolicy(error.code);
    return { code: error.code, category: policy.category, retryable: policy.retryable, temporary: policy.temporary, sessionInvalidated: policy.invalidatesSession };
  }
  const text = sanitizePublicErrorText(error instanceof Error ? error.message : error);
  if (/bot-required|capability.*unsupported|not supported/i.test(text)) return { code: 'capability-unsupported', category: 'capability-unsupported', retryable: false, temporary: false, sessionInvalidated: null };
  if (/not connected|disconnected|cannot connect|is connecting/i.test(text)) return { code: 'minecraft-session-unavailable', category: 'connection', retryable: true, temporary: true, sessionInvalidated: null };
  if (/^Invalid tool arguments:/i.test(text)) return { code: 'invalid-input', category: 'input-validation', retryable: false, temporary: false, sessionInvalidated: null };
  if (/timeout|timed out/i.test(text)) return { code: 'operation-timeout', category: 'timeout', retryable: false, temporary: true, sessionInvalidated: null };
  if (/chunk.*not loaded|(?:block|machine|resource).*not found/i.test(text)) return { code: 'resource-unavailable', category: 'resource-unavailable', retryable: false, temporary: false, sessionInvalidated: null };
  return { code: 'operation-failed', category: 'operation', retryable: false, temporary: null, sessionInvalidated: null };
}
