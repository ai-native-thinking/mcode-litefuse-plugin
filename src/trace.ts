import {
  createTraceId,
  propagateAttributes,
  startObservation,
  type LangfuseGenerationAttributes,
  type LangfuseObservation,
} from "@langfuse/tracing";
import { TraceFlags, type SpanContext } from "@opentelemetry/api";

import type { Config } from "./config.js";
import type { HookInput, ModelStep, ParsedTurn, ToolCall } from "./types.js";
import { toText, truncate } from "./utils.js";

const SEEDED_PARENT_SPAN_ID = "0123456789abcdef";

function clip(value: unknown, max: number): unknown {
  return typeof value === "string" ? truncate(value, max) : value;
}

function outputForStep(step: ModelStep, maxChars: number): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  if (step.text) output.content = clip(step.text, maxChars);
  if (step.toolCalls.length) {
    output.tool_calls = step.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.args,
    }));
  }
  return Object.keys(output).length ? output : undefined;
}

function usageDetails(): LangfuseGenerationAttributes["usageDetails"] {
  // MiniMax's Hook transcript intentionally contains no provider token usage.
  // Returning undefined is preferable to manufacturing counts.
  return undefined;
}

async function seededParent(
  config: Config,
  sessionId: string,
  turnId: string,
): Promise<SpanContext | undefined> {
  if (!config.trace_seed) return undefined;
  try {
    return {
      traceId: await createTraceId(`${config.trace_seed}:${sessionId}:${turnId}`),
      spanId: SEEDED_PARENT_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
  } catch {
    return undefined;
  }
}

function toolName(call: ToolCall): string {
  return call.name || "tool";
}

function emitTool(
  call: ToolCall,
  parent: LangfuseObservation,
  config: Config,
  fallbackEnd: number,
): void {
  const observation = startObservation(
    toolName(call),
    {
      input: call.args,
      output: call.output === undefined ? undefined : clip(toText(call.output), config.max_chars),
      level: call.error ? "ERROR" : undefined,
      statusMessage: call.error ? "MiniMax Code tool returned an error" : undefined,
      metadata: { "minimax.tool_call_id": call.id },
    },
    {
      asType: "tool",
      startTime: new Date(call.startTime),
      parentSpanContext: parent.otelSpan.spanContext(),
    },
  );
  observation.end(new Date(Math.max(call.endTime, fallbackEnd)));
}

export async function emitTurn(input: {
  config: Config;
  hook: HookInput;
  sessionId: string;
  turnId: string;
  turnNumber: number;
  parsed: ParsedTurn;
}): Promise<void> {
  const { config, hook, sessionId, turnId, turnNumber, parsed } = input;
  const parent = await seededParent(config, sessionId, turnId);
  await propagateAttributes(
    {
      sessionId,
      traceName: "MiniMax Code Turn",
      // `version` (not `release`) is the field the Langfuse JS SDK accepts here;
      // an unknown key is silently dropped, so this is the only spelling that works.
      ...(config.version ? { version: config.version } : {}),
      ...(config.user_id ? { userId: config.user_id } : {}),
      ...(config.tags ? { tags: config.tags } : {}),
      ...(config.metadata ? { metadata: config.metadata } : {}),
    },
    async () => {
      const root = startObservation(
        "MiniMax Code Turn",
        {
          input: parsed.userInput ? clip(parsed.userInput, config.max_chars) : undefined,
          output: parsed.finalOutput ? clip(parsed.finalOutput, config.max_chars) : undefined,
          level: hook.stop_hook_active ? "WARNING" : undefined,
          statusMessage: hook.stop_hook_active ? "Stop hook continuation is active" : undefined,
          metadata: {
            "minimax.session_id": sessionId,
            "minimax.turn_id": turnId,
            "minimax.turn_number": turnNumber,
            "minimax.model": hook.model,
            "minimax.cwd": hook.cwd,
            "minimax.agent_id": hook.agent_id,
            "minimax.agent_type": hook.agent_type,
            "minimax.message_count": parsed.messageCount,
            "minimax.tool_call_count": parsed.steps.reduce(
              (sum, step) => sum + step.toolCalls.length,
              0,
            ),
          },
        },
        { asType: "agent", startTime: new Date(parsed.startTime), parentSpanContext: parent },
      );

      let previousToolResults: unknown;
      for (let index = 0; index < parsed.steps.length; index += 1) {
        const step = parsed.steps[index];
        if (!step) continue;
        const generation = startObservation(
          "LLM",
          {
            input: index === 0 ? parsed.userInput : previousToolResults,
            output: outputForStep(step, config.max_chars),
            model: hook.model,
            usageDetails: usageDetails(),
            metadata: { "minimax.step_index": index },
          },
          {
            asType: "generation",
            startTime: new Date(step.startTime),
            parentSpanContext: root.otelSpan.spanContext(),
          },
        );
        for (const call of step.toolCalls) emitTool(call, generation, config, step.endTime);
        generation.end(new Date(step.endTime));
        previousToolResults = step.toolCalls.length
          ? step.toolCalls.map((call) => ({
              name: call.name,
              output: clip(toText(call.output), config.max_chars),
              error: call.error,
            }))
          : undefined;
      }
      root.end(new Date(parsed.endTime));
    },
  );
}
