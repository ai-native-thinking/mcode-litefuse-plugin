export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  model?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
  [key: string]: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  args?: unknown;
  output?: unknown;
  error?: boolean;
  startTime: number;
  endTime: number;
}

export interface ModelStep {
  startTime: number;
  endTime: number;
  text?: string;
  toolCalls: ToolCall[];
}

export interface ParsedTurn {
  userInput?: string;
  finalOutput?: string;
  startTime: number;
  endTime: number;
  steps: ModelStep[];
  messageCount: number;
}

export interface SessionState {
  sessionId: string;
  uploadedTurnIds: string[];
  turnNumbers: Record<string, number>;
}
