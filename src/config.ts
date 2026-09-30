import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { z } from "zod";

export const ConfigSchema = z.object({
  enabled: z.boolean(),
  public_key: z.string().optional(),
  secret_key: z.string().optional(),
  base_url: z.string(),
  environment: z.string().optional(),
  version: z.string().optional(),
  user_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  trace_seed: z.string().optional(),
  max_chars: z.number().int().positive(),
  debug: z.boolean(),
  fail_on_error: z.boolean(),
});

export type Config = z.infer<typeof ConfigSchema>;
const PartialConfigSchema = ConfigSchema.partial();

/**
 * Litefuse is normally self-hosted and its web app listens on port 3000, so the
 * default is a loopback address rather than a cloud URL. Override `base_url`
 * for Litefuse Cloud or any other deployment. Note that Litefuse is often
 * mounted under a path prefix (e.g. https://host/litefuse); the SDK appends
 * `/api/public/otel/v1/traces` verbatim, so the prefix is preserved as-is.
 */
const DEFAULTS: Pick<Config, "enabled" | "base_url" | "max_chars" | "debug" | "fail_on_error"> = {
  enabled: false,
  base_url: "http://localhost:3000",
  max_chars: 20_000,
  debug: false,
  fail_on_error: false,
};

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.trim().toLowerCase())) return false;
  return undefined;
}

function parseTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Fall through to comma-separated parsing.
    }
  }
  return text
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseMetadata(value: unknown): Record<string, string> | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [
      key,
      typeof item === "string" ? item : JSON.stringify(item),
    ]),
  );
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function readConfigFile(file: string): Promise<Partial<Config> | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    return PartialConfigSchema.parse(
      stripUndefined({
        ...raw,
        enabled: raw.enabled == null ? undefined : parseBoolean(raw.enabled),
        tags: raw.tags == null ? undefined : parseTags(raw.tags),
        metadata: raw.metadata == null ? undefined : parseMetadata(raw.metadata),
        max_chars: raw.max_chars == null ? undefined : parseInteger(raw.max_chars),
        debug: raw.debug == null ? undefined : parseBoolean(raw.debug),
        fail_on_error: raw.fail_on_error == null ? undefined : parseBoolean(raw.fail_on_error),
      }),
    );
  } catch {
    return undefined;
  }
}

/** Prefer the Litefuse-specific prefix, then fall back to the generic one. */
function getVar(suffix: string, env: Record<string, string | undefined>): string | undefined {
  return env[`LITEFUSE_MINIMAX_${suffix}`] ?? env[`LITEFUSE_${suffix}`];
}

function readEnvConfig(env: Record<string, string | undefined>): Partial<Config> {
  return PartialConfigSchema.parse(
    stripUndefined({
      enabled: parseBoolean(env.TRACE_TO_LITEFUSE),
      public_key: getVar("PUBLIC_KEY", env),
      secret_key: getVar("SECRET_KEY", env),
      base_url: getVar("BASE_URL", env),
      environment: env.LITEFUSE_MINIMAX_ENVIRONMENT ?? env.LITEFUSE_TRACING_ENVIRONMENT,
      version: env.LITEFUSE_MINIMAX_VERSION,
      user_id: env.LITEFUSE_MINIMAX_USER_ID,
      tags: parseTags(env.LITEFUSE_MINIMAX_TAGS),
      metadata: parseMetadata(env.LITEFUSE_MINIMAX_METADATA),
      trace_seed: env.LITEFUSE_MINIMAX_TRACE_SEED,
      max_chars: parseInteger(env.LITEFUSE_MINIMAX_MAX_CHARS),
      debug: parseBoolean(env.LITEFUSE_MINIMAX_DEBUG),
      fail_on_error: parseBoolean(env.LITEFUSE_MINIMAX_FAIL_ON_ERROR),
    }),
  );
}

/**
 * Resolve defaults -> ~/.minimax-code/litefuse.json -> <cwd>/.minimax/litefuse.json
 * -> environment. Every key here is deliberately distinct from the sibling
 * Langfuse plugin so the two can be enabled at the same time without one
 * silently shadowing the other's credentials.
 */
export async function getConfig(options?: {
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}): Promise<Config> {
  const home = options?.home ?? process.env.HOME ?? os.homedir();
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const [globalConfig, localConfig] = await Promise.all([
    readConfigFile(path.join(home, ".minimax-code", "litefuse.json")),
    readConfigFile(path.join(cwd, ".minimax", "litefuse.json")),
  ]);
  return ConfigSchema.parse({
    ...DEFAULTS,
    ...globalConfig,
    ...localConfig,
    ...readEnvConfig(env),
  });
}
