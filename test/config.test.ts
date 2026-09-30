import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getConfig } from "../src/config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = join(tmpdir(), `litefuse-config-${Date.now()}-${Math.random()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

const emptyEnv = { PATH: "/usr/bin" };

describe("config resolution", () => {
  it("defaults to a self-hosted Litefuse address and stays disabled", async () => {
    const config = await getConfig({ home: await scratch(), cwd: await scratch(), env: emptyEnv });
    expect(config.base_url).toBe("http://localhost:3000");
    expect(config.enabled).toBe(false);
    expect(config.max_chars).toBe(20_000);
  });

  it("reads ~/.minimax-code/litefuse.json, not the Langfuse file", async () => {
    const home = await scratch();
    const cwd = await scratch();
    await mkdir(join(home, ".minimax-code"), { recursive: true });
    await writeFile(
      join(home, ".minimax-code", "litefuse.json"),
      JSON.stringify({ enabled: true, public_key: "pk-lf-lite", secret_key: "sk-lf-lite" }),
    );
    // A sibling file must never be picked up by this plugin.
    await writeFile(
      join(home, ".minimax-code", "langfuse.json"),
      JSON.stringify({ enabled: true, public_key: "pk-lf-lang", secret_key: "sk-lf-lang" }),
    );

    const config = await getConfig({ home, cwd, env: emptyEnv });
    expect(config.enabled).toBe(true);
    expect(config.public_key).toBe("pk-lf-lite");
    expect(config.secret_key).toBe("sk-lf-lite");
  });

  it("lets the project .minimax/litefuse.json override the global file", async () => {
    const home = await scratch();
    const cwd = await scratch();
    await mkdir(join(home, ".minimax-code"), { recursive: true });
    await mkdir(join(cwd, ".minimax"), { recursive: true });
    await writeFile(
      join(home, ".minimax-code", "litefuse.json"),
      JSON.stringify({ base_url: "http://global:3000" }),
    );
    await writeFile(
      join(cwd, ".minimax", "litefuse.json"),
      JSON.stringify({ base_url: "http://local:3000" }),
    );

    const config = await getConfig({ home, cwd, env: emptyEnv });
    expect(config.base_url).toBe("http://local:3000");
  });

  it("prefers LITEFUSE_MINIMAX_* over the generic LITEFUSE_* variables", async () => {
    const config = await getConfig({
      home: await scratch(),
      cwd: await scratch(),
      env: {
        PATH: "/usr/bin",
        TRACE_TO_LITEFUSE: "true",
        LITEFUSE_MINIMAX_BASE_URL: "http://specific:3000",
        LITEFUSE_BASE_URL: "http://generic:3000",
        LITEFUSE_MINIMAX_PUBLIC_KEY: "pk-specific",
        LITEFUSE_PUBLIC_KEY: "pk-generic",
      },
    });
    expect(config.enabled).toBe(true);
    expect(config.base_url).toBe("http://specific:3000");
    expect(config.public_key).toBe("pk-specific");
  });

  it("falls back to generic LITEFUSE_* variables", async () => {
    const config = await getConfig({
      home: await scratch(),
      cwd: await scratch(),
      env: {
        PATH: "/usr/bin",
        TRACE_TO_LITEFUSE: "1",
        LITEFUSE_BASE_URL: "http://generic:3000",
        LITEFUSE_SECRET_KEY: "sk-generic",
      },
    });
    expect(config.enabled).toBe(true);
    expect(config.base_url).toBe("http://generic:3000");
    expect(config.secret_key).toBe("sk-generic");
  });

  it("does not read Langfuse environment variables", async () => {
    const config = await getConfig({
      home: await scratch(),
      cwd: await scratch(),
      env: { PATH: "/usr/bin", TRACE_TO_LANGFUSE: "true", LANGFUSE_BASE_URL: "http://langfuse" },
    });
    expect(config.enabled).toBe(false);
    expect(config.base_url).toBe("http://localhost:3000");
  });

  it("accepts tags as a JSON array or a comma-separated string", async () => {
    const base = { home: await scratch(), cwd: await scratch(), env: emptyEnv };
    const asJson = await getConfig({
      ...base,
      env: { ...emptyEnv, LITEFUSE_MINIMAX_TAGS: '["mcode","dual-write"]' },
    });
    expect(asJson.tags).toEqual(["mcode", "dual-write"]);
    const asCsv = await getConfig({ ...base, env: { ...emptyEnv, LITEFUSE_MINIMAX_TAGS: "a, b" } });
    expect(asCsv.tags).toEqual(["a", "b"]);
  });

  it("keeps a path-prefixed base URL intact", async () => {
    const config = await getConfig({
      home: await scratch(),
      cwd: await scratch(),
      env: { PATH: "/usr/bin", LITEFUSE_MINIMAX_BASE_URL: "http://host/litefuse" },
    });
    expect(config.base_url).toBe("http://host/litefuse");
  });
});
