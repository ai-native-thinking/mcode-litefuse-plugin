import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import type { Config } from "./config.js";

export function setupInstrumentation(config: Config): { shutdown: () => Promise<void> } {
  const processor = new LangfuseSpanProcessor({
    publicKey: config.public_key,
    secretKey: config.secret_key,
    baseUrl: config.base_url,
    environment: config.environment,
    exportMode: "batched",
    shouldExportSpan: () => true,
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register();
  return {
    shutdown: async () => {
      await processor.forceFlush();
      await provider.shutdown();
    },
  };
}
