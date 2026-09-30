import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { HookInput, ModelStep, ParsedTurn, ToolCall } from "./types.js";
import { toText } from "./utils.js";

type Row = {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
  message?: Record<string, unknown>;
};

export function codexProjectionPath(transcriptPath: string): string {
  return transcriptPath.endsWith(".compatible.jsonl")
    ? transcriptPath.slice(0, -".compatible.jsonl".length) + ".codex.jsonl"
    : transcriptPath;
}

async function readRows(file: string): Promise<Row[]> {
  const text = await fs.readFile(file, "utf8");
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as Row;
      return [value];
    } catch {
      return [];
    }
  });
}

function timestamp(row: Row, fallback: number): number {
  const parsed = row.timestamp ? Date.parse(row.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textFromParts(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as Record<string, unknown>;
      return typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function responsePayload(row: Row): Record<string, unknown> | undefined {
  return row.type === "response_item" && row.payload && typeof row.payload === "object"
    ? row.payload
    : undefined;
}

function compatiblePayload(row: Row): Record<string, unknown> | undefined {
  if (row.type !== "assistant" && row.type !== "user") return undefined;
  const message = row.message;
  return message && typeof message === "object" ? message : undefined;
}

/** Parse the latest user turn from MiniMax's temporary Codex projection. */
export async function parseLatestTurn(
  transcriptPath: string,
  hook: HookInput,
): Promise<ParsedTurn> {
  let rows: Row[];
  try {
    rows = await readRows(codexProjectionPath(transcriptPath));
  } catch {
    rows = await readRows(transcriptPath);
  }
  const responseRows = rows.flatMap((row, index) => {
    const payload = responsePayload(row);
    if (payload) return [{ row, payload, time: timestamp(row, index) }];
    const message = compatiblePayload(row);
    if (!message) return [];
    return [{ row, payload: message, time: timestamp(row, index) }];
  });
  let lastUser = -1;
  for (let i = 0; i < responseRows.length; i += 1) {
    const role = responseRows[i]?.payload.role;
    if (role === "user") lastUser = i;
  }
  const selected = responseRows.slice(Math.max(0, lastUser));
  const firstTime = selected[0]?.time ?? Date.now();
  const steps: ModelStep[] = [];
  const calls = new Map<string, ToolCall>();
  let current: ModelStep | undefined;
  let userInput: string | undefined;
  let finalOutput: string | undefined;
  let lastTime = firstTime;

  for (const item of selected) {
    lastTime = Math.max(lastTime, item.time);
    const payload = item.payload;
    const type = typeof payload.type === "string" ? payload.type : "message";
    if (type === "message") {
      const role = payload.role;
      const text = textFromParts(payload.content);
      if (role === "user") {
        if (!userInput && text) userInput = text;
        continue;
      }
      if (role === "assistant") {
        current = { startTime: item.time, endTime: item.time, toolCalls: [] };
        if (text) current.text = text;
        steps.push(current);
        finalOutput = text || finalOutput;
      }
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const id =
        typeof payload.call_id === "string" ? payload.call_id : `call_${item.time}_${calls.size}`;
      const call: ToolCall = {
        id,
        name: typeof payload.name === "string" ? payload.name : "tool",
        args: parseArgs(payload.arguments ?? payload.input),
        startTime: item.time,
        endTime: item.time,
      };
      (current ??= { startTime: item.time, endTime: item.time, toolCalls: [] }).toolCalls.push(
        call,
      );
      calls.set(id, call);
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const id = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const call = id ? calls.get(id) : undefined;
      if (call) {
        call.output = payload.output;
        call.endTime = item.time;
        call.error = Boolean(payload.is_error);
        if (current) current.endTime = Math.max(current.endTime, item.time);
      }
    }
  }
  if (steps.length === 0 && hook.last_assistant_message) {
    steps.push({
      startTime: firstTime,
      endTime: lastTime,
      text: hook.last_assistant_message,
      toolCalls: [],
    });
    finalOutput = hook.last_assistant_message;
  }
  if (hook.last_assistant_message && !finalOutput) finalOutput = hook.last_assistant_message;
  return {
    userInput,
    finalOutput,
    startTime: firstTime,
    endTime: Math.max(lastTime, firstTime),
    steps,
    messageCount: selected.length,
  };
}

export function inferTurnId(hook: HookInput, parsed: ParsedTurn): string {
  return hook.turn_id?.trim() || `turn-${parsed.startTime}`;
}

export function sessionIdFromPath(transcriptPath: string): string {
  return path.basename(transcriptPath).replace(/\.(?:compatible|codex)\.jsonl$/u, "");
}
