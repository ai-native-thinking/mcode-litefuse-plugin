import { getConfig } from "./config.js";
import { setupInstrumentation } from "./instrumentation.js";
import { parseLatestTurn, inferTurnId, sessionIdFromPath } from "./transcript.js";
import type { HookInput } from "./types.js";
import { emitTurn } from "./trace.js";
import { debugLog, readStdin, setDebug } from "./utils.js";
import { ensureTurnNumber, loadState, saveState } from "./state.js";

let failOnError = process.env.LITEFUSE_MINIMAX_FAIL_ON_ERROR === "true";

export async function runHook(): Promise<void> {
  let hook: HookInput;
  try {
    hook = await readStdin<HookInput>();
  } catch {
    return;
  }
  if (hook.hook_event_name && hook.hook_event_name !== "Stop") return;
  const config = await getConfig({ cwd: hook.cwd ?? process.cwd() });
  setDebug(config.debug);
  failOnError = config.fail_on_error;
  if (!config.enabled) {
    debugLog("tracing disabled; set TRACE_TO_LITEFUSE=true or enabled:true in litefuse.json");
    return;
  }
  if (!config.public_key || !config.secret_key) {
    debugLog("missing Litefuse credentials; skipping");
    return;
  }
  if (!hook.transcript_path || !hook.session_id) {
    debugLog("Stop Hook did not include session_id or transcript_path; skipping");
    return;
  }

  const sessionId = hook.session_id;
  let parsed: Awaited<ReturnType<typeof parseLatestTurn>>;
  try {
    parsed = await parseLatestTurn(hook.transcript_path, hook);
  } catch (error) {
    debugLog("failed to read MiniMax transcript:", error);
    if (failOnError) throw error;
    return;
  }
  const turnId = inferTurnId(hook, parsed);
  const dataDir = process.env.PLUGIN_DATA ?? process.env.MINIMAX_PLUGIN_DATA ?? ".plugin-data";
  const state = await loadState(dataDir, sessionId);
  if (state.uploadedTurnIds.includes(turnId)) {
    debugLog(`turn ${turnId} already uploaded`);
    return;
  }
  const turnNumber = ensureTurnNumber(state, turnId);
  const instrumentation = setupInstrumentation(config);
  let traceCreated = false;
  try {
    await emitTurn({
      config,
      hook,
      sessionId: sessionId || sessionIdFromPath(hook.transcript_path),
      turnId,
      turnNumber,
      parsed,
    });
    traceCreated = true;
  } catch (error) {
    debugLog("failed to upload MiniMax Code trace to Litefuse:", error);
    if (failOnError) throw error;
  } finally {
    let flushed = true;
    try {
      await instrumentation.shutdown();
    } catch (error) {
      flushed = false;
      debugLog("failed to flush Litefuse spans:", error);
      if (failOnError) throw error;
    }
    if (traceCreated && flushed) {
      try {
        state.uploadedTurnIds.push(turnId);
        await saveState(dataDir, state);
      } catch (error) {
        debugLog("failed to persist turn de-duplication state:", error);
        if (failOnError) throw error;
      }
    }
  }
}

runHook().catch((error) => {
  if (process.env.LITEFUSE_MINIMAX_DEBUG === "true")
    console.error("[litefuse-minimax] fatal:", error);
  if (failOnError) process.exitCode = 1;
});
