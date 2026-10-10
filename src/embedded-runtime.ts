import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  createObservationAttributes,
  LangfuseGeneration,
  LangfuseSpan,
  LangfuseTool,
  type LangfuseObservationAttributes,
  type StartObservationOptions,
} from "@langfuse/tracing";
import { ROOT_CONTEXT, trace, type Span } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOnSampler, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { createSecretRedactor } from "./payload-redaction.ts";
import { createEmbeddedExporter } from "./embedded-exporter.ts";

export type TraceAttributes = Record<string, string | string[]>;
export type ExportIssueCode = "export-failed" | "flush-failed" | "shutdown-failed";

export interface EmbeddedLangfuseOptions {
  endpoint: string;
  publicKey: string;
  secretKey: string;
  labels?: { userId?: string; environment?: string; release?: string };
  onExportIssue?: (issue: Readonly<{ code: ExportIssueCode }>) => void;
}

export interface EmbeddedConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  userId?: string;
  environment: string;
  release: string;
}

export function validateEmbeddedOptions(options: EmbeddedLangfuseOptions): EmbeddedConfig {
  const required = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
      throw new Error("Invalid explicit Langfuse configuration");
    }
    return value.trim();
  };

  const publicKey = required(options?.publicKey);
  const secretKey = required(options?.secretKey);

  let endpoint: URL;
  try {
    endpoint = new URL(required(options?.endpoint));
  } catch {
    throw new Error("Invalid explicit Langfuse endpoint");
  }

  const isHttpEndpoint = endpoint.protocol === "http:" || endpoint.protocol === "https:";
  const hasCredentials = Boolean(endpoint.username || endpoint.password);
  const hasQueryOrFragment = Boolean(endpoint.search || endpoint.hash);
  if (!isHttpEndpoint || hasCredentials || hasQueryOrFragment) {
    throw new Error("Invalid explicit Langfuse endpoint");
  }

  const label = (value: unknown): string => {
    if (value === undefined) return "";
    if (typeof value !== "string") throw new Error("Invalid explicit Langfuse label");
    return value;
  };

  if (options.onExportIssue !== undefined && typeof options.onExportIssue !== "function") {
    throw new Error("Invalid explicit Langfuse diagnostic callback");
  }

  return {
    publicKey,
    secretKey,
    baseUrl: endpoint.href.replace(/\/+$/, ""),
    userId: label(options.labels?.userId) || undefined,
    environment: label(options.labels?.environment),
    release: label(options.labels?.release),
  };
}

export type ObservationOptions = StartObservationOptions & { asType?: "span" | "generation" | "tool" };

export interface OwnedRuntime {
  processor: Pick<LangfuseSpanProcessor, "forceFlush">;
  shutdown: boolean;
  start(
    name: string,
    attributes: LangfuseObservationAttributes,
    options: ObservationOptions & { asType: "generation" },
    attribution: TraceAttributes,
  ): LangfuseGeneration;
  start(
    name: string,
    attributes: LangfuseObservationAttributes,
    options: ObservationOptions & { asType: "tool" },
    attribution: TraceAttributes,
  ): LangfuseTool;
  start(
    name: string,
    attributes: LangfuseObservationAttributes,
    options: ObservationOptions & { asType: "span" },
    attribution: TraceAttributes,
  ): LangfuseSpan;
  dispose(): Promise<void>;
}

function assertNoAmbientExporterHeaders(): void {
  // Locked OTLP exporter merges ambient headers with explicit headers at construction.
  if (process.env.OTEL_EXPORTER_OTLP_HEADERS || process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) {
    throw new Error("Clear OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_TRACES_HEADERS before creating an embedded Langfuse runtime");
  }
}

export function createOwnedRuntime(
  config: EmbeddedConfig,
  onExportIssue?: EmbeddedLangfuseOptions["onExportIssue"],
): OwnedRuntime {
  const reportedIssues = new Set<ExportIssueCode>();
  const reportIssue = (code: ExportIssueCode) => {
    if (reportedIssues.has(code)) return;
    reportedIssues.add(code);

    try {
      if (onExportIssue) onExportIssue(Object.freeze({ code }));
      else console.error("[pi-langfuse]", code);
    } catch {
      // Caller diagnostics cannot break tracing or expose arbitrary exceptions.
    }
  };

  const redactSecrets = createSecretRedactor(config.publicKey, config.secretKey);
  assertNoAmbientExporterHeaders();
  const exporter = createEmbeddedExporter(config, () => reportIssue("export-failed"));
  const processor = new LangfuseSpanProcessor({
    exporter,
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    release: config.release,
    mediaUploadEnabled: false,
    flushAt: 64,
    flushInterval: 5,
    timeout: 3,
    mask: ({ data }) => redactSecrets(data),
    shouldExportSpan: ({ otelSpan }) => typeof otelSpan.attributes["langfuse.observation.type"] === "string",
  });

  const openSpans = new Map<string, Span>();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "pi-langfuse-embedded" }),
    sampler: new AlwaysOnSampler(),
    spanLimits: { attributeValueLengthLimit: Infinity, attributeCountLimit: Infinity },
    spanProcessors: [{
      onStart(span, parentContext) {
        openSpans.set(span.spanContext().spanId, span);
        processor.onStart(span, parentContext);
      },
      onEnd(span) {
        openSpans.delete(span.spanContext().spanId);
        processor.onEnd(span);
      },
      forceFlush: () => processor.forceFlush(),
      shutdown: () => processor.shutdown(),
    }],
  });

  const tracer = provider.getTracer("langfuse-sdk", "5.10.1");
  let disposePromise: Promise<void> | undefined;

  function start(
    name: string,
    attributes: LangfuseObservationAttributes,
    options: ObservationOptions & { asType: "generation" },
    attribution: TraceAttributes,
  ): LangfuseGeneration;
  function start(
    name: string,
    attributes: LangfuseObservationAttributes,
    options: ObservationOptions & { asType: "tool" },
    attribution: TraceAttributes,
  ): LangfuseTool;
  function start(
    name: string,
    attributes: LangfuseObservationAttributes,
    options: ObservationOptions & { asType: "span" },
    attribution: TraceAttributes,
  ): LangfuseSpan;
  function start(
    name: string,
    attributes: LangfuseObservationAttributes,
    options: ObservationOptions,
    attribution: TraceAttributes,
  ) {
    if (runtime.shutdown) throw new Error("Langfuse runtime is disposed");

    const kind = options.asType ?? "span";
    const parentContext = options.parentSpanContext
      ? trace.setSpanContext(ROOT_CONTEXT, options.parentSpanContext)
      : ROOT_CONTEXT;
    const initialAttributes = {
      ...createObservationAttributes(kind, attributes),
      ...structuredClone(attribution),
    };
    const otelSpan = tracer.startSpan(
      name,
      { attributes: initialAttributes, startTime: options.startTime },
      parentContext,
    );

    // Construct wrappers directly: their child convenience methods use a global provider.
    if (kind === "generation") return new LangfuseGeneration({ otelSpan });
    if (kind === "tool") return new LangfuseTool({ otelSpan });
    return new LangfuseSpan({ otelSpan });
  }

  const runtime: OwnedRuntime = {
    shutdown: false,
    start,
    processor: {
      async forceFlush() {
        try {
          await processor.forceFlush();
        } catch {
          reportIssue("flush-failed");
        }
      },
    },
    dispose() {
      if (disposePromise) return disposePromise;

      runtime.shutdown = true;
      for (const span of openSpans.values()) span.end();

      disposePromise = (async () => {
        try {
          await provider.shutdown();
        } catch {
          reportIssue("shutdown-failed");
        } finally {
          // BatchSpanProcessor skips exporter shutdown when its final flush rejects.
          try {
            await exporter.shutdown();
          } catch {
            reportIssue("shutdown-failed");
          }
        }
      })();
      return disposePromise;
    },
  };

  return runtime;
}
