import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["index.ts"],
  outDir: "../dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/^@langfuse\//, /^@opentelemetry\//, /^zod(?:\/|$)/],
  dts: false,
  clean: true,
  minify: false,
  outputOptions: { inlineDynamicImports: true },
});
