/** These shapes exchange data or inspect native run state; they cannot dispatch work. */
export function coordinationKind(toolName: string, input: Record<string, unknown>): "coordination" | "read-only" | undefined {
  const only = (...keys: string[]) => Object.keys(input).every(key => keys.includes(key));
  switch (toolName) {
    case "ask_user_question":
      return only("questions") && Array.isArray(input.questions) ? "coordination" : undefined;
    case "contact_supervisor":
      return only("reason", "message", "interview") &&
        ["need_decision", "interview_request", "progress_update"].includes(String(input.reason)) ? "coordination" : undefined;
    case "subagent_supervisor":
      return only("action", "to", "message", "replyTo") &&
        ["list", "pending", "status", "reply"].includes(String(input.action)) ? "coordination" : undefined;
    case "intercom":
      return only("action", "to", "message", "attachments", "replyTo", "supersedes", "retryOf", "cwd") &&
        ["list", "list-cwd", "pending", "status", "send", "ask", "reply"].includes(String(input.action)) ? "coordination" : undefined;
    case "subagent":
      if (input.action === "status" && only("action", "id", "runId", "view", "index", "lines")) return "read-only";
      if (input.action === "list" && only("action", "capabilities", "agentScope")) return "read-only";
      if (input.action === "guide" && only("action", "topic")) return "read-only";
      return undefined;
    case "bg_status":
      return only("taskId") ? "read-only" : undefined;
    case "bg_logs":
      return only("taskId", "maxBytes", "tail") ? "read-only" : undefined;
    default:
      return undefined;
  }
}
