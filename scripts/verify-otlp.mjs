#!/usr/bin/env node
/**
 * Dual-write verification harness.
 *
 * Stands up a fake OTLP collector, generates a synthetic MiniMax Code
 * transcript, then fires the sibling Langfuse plugin bundle and this Litefuse
 * plugin bundle at that one transcript. Asserts the facts the real backend
 * would enforce:
 *
 *   - request path  : <base>/api/public/otel/v1/traces
 *   - auth          : Basic base64(<public_key>:<secret_key>), per backend
 *   - SDK gate      : x-langfuse-sdk-name=javascript and version >= 5.0.0
 *   - span nesting  : agent -> generation -> tool
 *   - dual write    : two requests, two credential pairs, one shared transcript
 *   - de-duplication: a second run of each plugin is suppressed
 *   - isolation     : still two requests when BOTH share one PLUGIN_DATA dir
 *
 * Usage: node scripts/verify-otlp.mjs [--keep]
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LANGFUSE_BUNDLE =
  process.env.LANGFUSE_BUNDLE ??
  join(process.env.HOME, ".minimax/plugins/langfuse-observability/dist/index.mjs");
const LITEFUSE_BUNDLE =
  process.env.LITEFUSE_BUNDLE ?? join(ROOT, "dist/index.mjs");

const LANGFUSE_PK = "pk-lf-verify-00000000-0000-0000-0000-000000000000";
const LANGFUSE_SK = "sk-lf-verify-11111111-1111-1111-1111-111111111111";
const LITEFUSE_PK = "pk-lf-verify-22222222-2222-2222-2222-222222222222";
const LITEFUSE_SK = "sk-lf-verify-33333333-3333-3333-3333-333333333333";

const TRACES_PATH = "/api/public/otel/v1/traces";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---------------------------------------------------------------- fake OTLP

function startCollector() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
      let body = null;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        /* leave null */
      }
      requests.push({ method: req.method, url: req.url, headers, body, bytes: raw.length });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

// ------------------------------------------------------------- span helpers

function walk(resourceSpans, visit, parent) {
  for (const rs of resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) visit(span, parent ?? null, ss);
    }
  }
}
function allSpans(body) {
  const out = [];
  walk(body?.resourceSpans, (span, parent) => out.push({ span, parent }));
  return out;
}
function attrs(span) {
  const map = {};
  for (const a of span?.attributes ?? []) map[a.key] = a.value?.stringValue ?? a.value;
  return map;
}
function byId(body) {
  const map = new Map();
  for (const { span } of allSpans(body)) map.set(span.spanId, span);
  return map;
}
function parentOf(body, span) {
  const all = new Map(allSpans(body).map((x) => [x.span.spanId, x]));
  return all.get(span.parentSpanId)?.span ?? null;
}
function findSpan(body, pred) {
  return (
    allSpans(body)
      .map((x) => x.span)
      .find(pred) ?? null
  );
}

// -------------------------------------------------------------- transcript

async function writeTranscript(dir) {
  await mkdir(dir, { recursive: true });
  const rows = [
    {
      type: "session_meta",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { id: "verify-session" },
    },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "add dual write" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I will inspect the plugin." }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:00:03.000Z",
      payload: {
        type: "function_call",
        name: "shell",
        call_id: "c1",
        arguments: '{"command":"ls"}',
      },
    },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:00:04.000Z",
      payload: { type: "function_call_output", call_id: "c1", output: "README.md" },
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
  ];
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(join(dir, "session.compatible.jsonl"), "");
  await writeFile(join(dir, "session.codex.jsonl"), text);
  return join(dir, "session.compatible.jsonl");
}

// ------------------------------------------------------------------- runner

function runBundle(bundle, { hook, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(hook));
  });
}

async function waitFor(pred, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = pred();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// --------------------------------------------------------------------- main

async function main() {
  for (const [label, bundle] of [
    ["langfuse", LANGFUSE_BUNDLE],
    ["litefuse", LITEFUSE_BUNDLE],
  ]) {
    if (!existsSync(bundle)) {
      console.error(`missing ${label} bundle: ${bundle}`);
      process.exit(2);
    }
  }

  const base = await mkdtemp(join(tmpdir(), "mcode-dualwrite-"));
  const keep = process.argv.includes("--keep");
  const { server, requests, port } = await startCollector();
  const baseUrl = `http://127.0.0.1:${port}`;

  const transcriptPath = await writeTranscript(join(base, "transcript"));
  const home = join(base, "home");
  await mkdir(join(home, ".minimax-code"), { recursive: true });
  await writeFile(
    join(home, ".minimax-code", "langfuse.json"),
    JSON.stringify({
      enabled: true,
      public_key: LANGFUSE_PK,
      secret_key: LANGFUSE_SK,
      base_url: baseUrl,
      tags: ["mcode-langfuse"],
    }),
  );
  await writeFile(
    join(home, ".minimax-code", "litefuse.json"),
    JSON.stringify({
      enabled: true,
      public_key: LITEFUSE_PK,
      secret_key: LITEFUSE_SK,
      // Exercise a path-prefixed self-hosted deployment, like the real instance.
      base_url: `${baseUrl}/litefuse`,
      tags: ["mcode-litefuse"],
    }),
  );

  const hook = {
    hook_event_name: "Stop",
    session_id: "verify-session",
    turn_id: "verify-turn-1",
    transcript_path: transcriptPath,
    cwd: base,
    model: "minimax-m2",
  };

  // --- Scenario A: separate data dirs (how the host actually runs them) -----
  console.log("\nScenario A — separate PLUGIN_DATA per plugin (real host behaviour)");
  const lfData = join(base, "data-langfuse");
  const litefuseData = join(base, "data-litefuse");
  await runBundle(LANGFUSE_BUNDLE, {
    hook,
    env: { HOME: home, PLUGIN_DATA: lfData },
  });
  await runBundle(LITEFUSE_BUNDLE, {
    hook,
    env: { HOME: home, PLUGIN_DATA: litefuseData },
  });

  const found = await waitFor(() => (requests.length >= 2 ? requests : null));
  check("both backends received a request", Boolean(found), `${requests.length} request(s)`);

  const lfReq = requests.find((r) => r.headers["x-langfuse-public-key"] === LANGFUSE_PK);
  const liteReq = requests.find((r) => r.headers["x-langfuse-public-key"] === LITEFUSE_PK);

  check("one request per backend, with distinct credentials", Boolean(lfReq && liteReq));
  check("langfuse request hit /api/public/otel/v1/traces", lfReq?.url === TRACES_PATH, lfReq?.url);
  check(
    "litefuse request hit /litefuse/api/public/otel/v1/traces",
    liteReq?.url === `/litefuse${TRACES_PATH}`,
    liteReq?.url,
  );

  const basic = (s) => `Basic ${Buffer.from(s).toString("base64")}`;
  check(
    "langfuse used Basic auth with its own key pair",
    lfReq?.headers.authorization === basic(`${LANGFUSE_PK}:${LANGFUSE_SK}`),
  );
  check(
    "litefuse used Basic auth with its own key pair",
    liteReq?.headers.authorization === basic(`${LITEFUSE_PK}:${LITEFUSE_SK}`),
  );

  for (const [label, req] of [
    ["langfuse", lfReq],
    ["litefuse", liteReq],
  ]) {
    const name = req?.headers["x-langfuse-sdk-name"];
    const ver = req?.headers["x-langfuse-sdk-version"];
    const [maj, min] = String(ver ?? "0.0.0")
      .split(".")
      .map(Number);
    check(
      `${label} declares javascript SDK >= 5.0.0 (Litefuse ingestion gate)`,
      (name === "javascript" && maj > 5) || (name === "javascript" && maj === 5 && min >= 0),
      `${name}@${ver}`,
    );
  }

  // --- span shape -----------------------------------------------------------
  console.log("\nSpan shape (identical across backends)");
  for (const [label, req] of [
    ["langfuse", lfReq],
    ["litefuse", liteReq],
  ]) {
    const body = req?.body;
    const spans = allSpans(body).map((x) => x.span);
    const root = findSpan(body, (s) => !s.parentSpanId);
    const gen = findSpan(
      body,
      (s) => (attrs(s)["langfuse.observation.type"] ?? "") === "generation",
    );
    const tool = findSpan(body, (s) => (attrs(s)["langfuse.observation.type"] ?? "") === "tool");
    const toolParent = tool ? parentOf(body, tool) : null;

    check(`${label}: agent -> generation -> tool span chain`, Boolean(root && gen && tool));
    check(
      `${label}: tool is a child of the generation`,
      gen && toolParent && toolParent.spanId === gen.spanId,
    );
    check(
      `${label}: session id reaches every span`,
      Boolean(root && attrs(root)["session.id"] === "verify-session") &&
        spans.every((s) => attrs(s)["session.id"] === "verify-session"),
    );
    check(
      `${label}: trace name and tags applied`,
      attrs(root ?? {})["langfuse.trace.name"] === "MiniMax Code Turn" &&
        JSON.stringify(attrs(root ?? {})["langfuse.trace.tags"]).includes("mcode-"),
    );
    check(
      `${label}: turn id and number recorded in metadata`,
      attrs(root ?? {})["langfuse.observation.metadata.minimax.turn_id"] === "verify-turn-1" &&
        attrs(root ?? {})["langfuse.observation.metadata.minimax.turn_number"] !== undefined,
    );
    check(
      `${label}: user prompt and final answer are present`,
      Boolean(
        findSpan(body, (s) =>
          JSON.stringify(attrs(s)["langfuse.observation.input"] ?? "").includes("add dual write"),
        ) &&
        findSpan(body, (s) =>
          JSON.stringify(attrs(s)["langfuse.observation.output"] ?? "").includes("Done."),
        ),
      ),
    );
  }

  // --- de-duplication --------------------------------------------------------
  console.log("\nDe-duplication — second run of each plugin is suppressed");
  const before = requests.length;
  await runBundle(LANGFUSE_BUNDLE, { hook, env: { HOME: home, PLUGIN_DATA: lfData } });
  await runBundle(LITEFUSE_BUNDLE, { hook, env: { HOME: home, PLUGIN_DATA: litefuseData } });
  await new Promise((r) => setTimeout(r, 2500));
  check(
    "no additional requests on replay",
    requests.length === before,
    `${before} -> ${requests.length}`,
  );

  // --- Scenario B: shared data dir -----------------------------------------
  console.log("\nScenario B — both plugins forced to share ONE PLUGIN_DATA dir");
  const shared = join(base, "data-shared");
  const beforeB = requests.length;
  await runBundle(LANGFUSE_BUNDLE, {
    hook: { ...hook, turn_id: "verify-turn-2" },
    env: { HOME: home, PLUGIN_DATA: shared },
  });
  await runBundle(LITEFUSE_BUNDLE, {
    hook: { ...hook, turn_id: "verify-turn-2" },
    env: { HOME: home, PLUGIN_DATA: shared },
  });
  const gotB = await waitFor(() => (requests.length >= beforeB + 2 ? requests : null), 9000);
  const newReqs = requests.slice(beforeB);
  check(
    "both backends still uploaded despite the shared data dir",
    Boolean(gotB) &&
      newReqs.some((r) => r.headers["x-langfuse-public-key"] === LANGFUSE_PK) &&
      newReqs.some((r) => r.headers["x-langfuse-public-key"] === LITEFUSE_PK),
    `${newReqs.length} request(s)`,
  );

  const files = existsSync(shared) ? await readdir(shared) : [];
  check(
    "state files are distinct (de-dup state did not collide)",
    files.some((f) => f.endsWith(".litefuse.json")) &&
      files.some((f) => f.endsWith(".json") && !f.endsWith(".litefuse.json")),
    files.join(", "),
  );

  // --- report ---------------------------------------------------------------
  server.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (!keep) await rm(base, { recursive: true, force: true });
  else console.log(`\nkept workspace: ${base}`);

  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    process.exit(1);
  }
  console.log("\nBundle paths verified:");
  console.log(`  langfuse: ${LANGFUSE_BUNDLE}`);
  console.log(`  litefuse: ${LITEFUSE_BUNDLE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
