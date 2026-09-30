import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inferTurnId, parseLatestTurn, sessionIdFromPath } from "../src/transcript.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = join(tmpdir(), `litefuse-minimax-${Date.now()}-${Math.random()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

describe("MiniMax Codex transcript projection", () => {
  it("converts the latest prompt, generation, tool call, and tool result", async () => {
    const root = await scratch();
    const compatible = join(root, "session.compatible.jsonl");
    const codex = join(root, "session.codex.jsonl");
    await writeFile(
      codex,
      [
        { type: "session_meta", timestamp: "2026-01-01T00:00:00.000Z", payload: { id: "s" } },
        {
          type: "response_item",
          timestamp: "2026-01-01T00:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "fix it" }],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-01-01T00:00:02.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I will inspect the file." }],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-01-01T00:00:03.000Z",
          payload: {
            type: "function_call",
            name: "shell",
            call_id: "c1",
            arguments: '{"command":"pwd"}',
          },
        },
        {
          type: "response_item",
          timestamp: "2026-01-01T00:00:04.000Z",
          payload: { type: "function_call_output", call_id: "c1", output: "/tmp" },
        },
        {
          type: "response_item",
          timestamp: "2026-01-01T00:00:05.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done." }],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    await writeFile(compatible, "");

    const parsed = await parseLatestTurn(compatible, {
      turn_id: "t1",
      last_assistant_message: "Done.",
    });
    expect(parsed.userInput).toBe("fix it");
    expect(parsed.finalOutput).toBe("Done.");
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]?.toolCalls[0]?.name).toBe("shell");
    expect(parsed.steps[0]?.toolCalls[0]?.output).toBe("/tmp");
    expect(inferTurnId({ turn_id: "t1" }, parsed)).toBe("t1");
  });

  it("only keeps events after the last user message", async () => {
    const root = await scratch();
    const codex = join(root, "session.codex.jsonl");
    await writeFile(
      codex,
      [
        {
          type: "response_item",
          timestamp: "2026-01-01T00:00:01.000Z",
          payload: { type: "message", role: "user", content: [{ text: "old question" }] },
        },
        {
          type: "response_item",
          timestamp: "2026-01-01T00:00:02.000Z",
          payload: { type: "message", role: "assistant", content: [{ text: "old answer" }] },
        },
        {
          type: "response_item",
          timestamp: "2026-01-01T00:00:03.000Z",
          payload: { type: "message", role: "user", content: [{ text: "new question" }] },
        },
        {
          type: "response_item",
          timestamp: "2026-01-01T00:00:04.000Z",
          payload: { type: "message", role: "assistant", content: [{ text: "new answer" }] },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );

    const parsed = await parseLatestTurn(codex, {});
    expect(parsed.userInput).toBe("new question");
    expect(parsed.finalOutput).toBe("new answer");
    expect(parsed.steps).toHaveLength(1);
  });

  it("derives a stable session id from either projection filename", () => {
    expect(sessionIdFromPath("/tmp/abc.compatible.jsonl")).toBe("abc");
    expect(sessionIdFromPath("/tmp/abc.codex.jsonl")).toBe("abc");
    // Only the two projection suffixes are stripped; this is a fallback for a
    // bare transcript and never runs when the hook supplies a session_id.
    expect(sessionIdFromPath("/tmp/abc.jsonl")).toBe("abc.jsonl");
  });

  it("falls back to the hook's last assistant message when there are no steps", async () => {
    const root = await scratch();
    const codex = join(root, "session.codex.jsonl");
    await writeFile(codex, "");
    const parsed = await parseLatestTurn(codex, { last_assistant_message: "hello from hook" });
    expect(parsed.finalOutput).toBe("hello from hook");
    expect(parsed.steps).toHaveLength(1);
  });
});
