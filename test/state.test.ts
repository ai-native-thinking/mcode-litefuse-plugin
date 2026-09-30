import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureTurnNumber, loadState, saveState } from "../src/state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = join(tmpdir(), `litefuse-state-${Date.now()}-${Math.random()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

describe("turn de-duplication state", () => {
  it("assigns monotonically increasing turn numbers per session", async () => {
    const state = await loadState(await scratch(), "s1");
    expect(ensureTurnNumber(state, "t1")).toBe(1);
    expect(ensureTurnNumber(state, "t2")).toBe(2);
    expect(ensureTurnNumber(state, "t1")).toBe(1);
  });

  it("persists uploaded turn ids and reloads them", async () => {
    const dir = await scratch();
    const state = await loadState(dir, "s1");
    state.uploadedTurnIds.push("t1");
    await saveState(dir, state);

    const reloaded = await loadState(dir, "s1");
    expect(reloaded.uploadedTurnIds).toContain("t1");
    expect(reloaded.sessionId).toBe("s1");
  });

  it("returns empty state for an unknown session instead of throwing", async () => {
    const state = await loadState(await scratch(), "never-seen");
    expect(state.uploadedTurnIds).toEqual([]);
    expect(state.turnNumbers).toEqual({});
  });

  /**
   * The dual-write hazard this plugin has to defend against: a sibling
   * Langfuse plugin records the same turn id in a sibling state file. If both
   * plugins shared one file name, whichever ran first would mark the turn
   * uploaded and the second backend would silently drop the whole trace.
   */
  it("keeps its state file disjoint from a sibling plugin sharing one data dir", async () => {
    const dir = await scratch();

    // Simulate the sibling plugin's state file, which uses a bare "<hash>.json".
    const createHash = (await import("node:crypto")).createHash;
    const key = createHash("sha256").update("shared-session").digest("hex").slice(0, 32);
    await writeFile(join(dir, `${key}.json`), JSON.stringify({ sibling: true }));

    await saveState(dir, {
      sessionId: "shared-session",
      uploadedTurnIds: ["turn-1"],
      turnNumbers: { "turn-1": 1 },
    });

    const files = await readdir(dir);
    expect(files).toContain(`${key}.json`);
    expect(files).toContain(`${key}.litefuse.json`);

    // Reading our state must not see the sibling's turn ids, and vice versa.
    const ours = await loadState(dir, "shared-session");
    expect(ours.uploadedTurnIds).toEqual(["turn-1"]);
  });
});
