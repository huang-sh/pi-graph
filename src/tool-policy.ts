export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export const DEFAULT_AGENT_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

export const READ_ONLY_TOOL_SET: ReadonlySet<string> = new Set(READ_ONLY_TOOL_NAMES);
