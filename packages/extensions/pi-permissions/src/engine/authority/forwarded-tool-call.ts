/** Original call data, never instructions or an approval, carried across processes. */
export interface ForwardedToolCall {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export function asForwardedToolCall(value: unknown): ForwardedToolCall | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const call = value as Record<string, unknown>;
  if (typeof call.toolName !== "string" || !call.toolName || typeof call.toolCallId !== "string" ||
      !call.input || typeof call.input !== "object" || Array.isArray(call.input)) return undefined;
  return { toolName: call.toolName, toolCallId: call.toolCallId, input: call.input as Record<string, unknown> };
}
