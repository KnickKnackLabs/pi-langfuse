import { AsyncLocalStorage } from "node:async_hooks";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Duplex } from "node:stream";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { EmbeddedConfig } from "./embedded-runtime.ts";

const EXPORT_DEADLINE_MS = 3_000;
const SUCCESS = 0;
const FAILED = 1;

type ExportCallback = Parameters<SpanExporter["export"]>[1];
interface ExportAttempt {
  expired: boolean;
  sockets: Set<Duplex>;
}

// Keep the standard OTLP serializer/retry policy. Own only its connections and
// result boundary: the dependency timeout measures inactivity, not elapsed time.
export function createEmbeddedExporter(config: EmbeddedConfig, reportFailure: () => void): SpanExporter {
  const attempts = new AsyncLocalStorage<ExportAttempt>();
  const agent = config.baseUrl.startsWith("https:")
    ? new HttpsAgent({ keepAlive: false })
    : new HttpAgent({ keepAlive: false });
  const connect = agent.createConnection.bind(agent);

  agent.createConnection = (options, callback) => {
    const attempt = attempts.getStore();
    const track = (socket: Duplex) => {
      if (!attempt || attempt.sockets.has(socket)) return;
      attempt.sockets.add(socket);
      socket.once("close", () => attempt.sockets.delete(socket));
      if (attempt.expired) socket.destroy(new Error("Langfuse export deadline exceeded"));
    };
    const socket = connect(options, callback && ((error, stream) => {
      if (stream) track(stream);
      callback(error, stream);
    }));
    if (socket) track(socket);
    return socket;
  };

  const delegate = new OTLPTraceExporter({
    url: `${config.baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
      "x-langfuse-sdk-name": "javascript",
      "x-langfuse-sdk-version": "5.10.1",
      "x-langfuse-public-key": config.publicKey,
    },
    timeoutMillis: EXPORT_DEADLINE_MS,
    httpAgentOptions: () => agent,
  });
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  return {
    export(spans, callback) {
      if (closed) {
        callback({ code: FAILED, error: new Error("Langfuse exporter is disposed") });
        return;
      }
      const attempt: ExportAttempt = { expired: false, sockets: new Set() };
      let completed = false;
      const finish: ExportCallback = (result) => {
        if (completed) return;
        completed = true;
        clearTimeout(deadline);
        if (attempt.expired) {
          result = { code: FAILED, error: new Error("Langfuse export deadline exceeded") };
        }
        if (result.code !== SUCCESS) reportFailure();
        callback(result);
      };
      const deadline = setTimeout(() => {
        attempt.expired = true;
        for (const socket of attempt.sockets) {
          socket.destroy(new Error("Langfuse export deadline exceeded"));
        }
        // A response error can be reported as success by the standard transport.
        finish({ code: FAILED, error: new Error("Langfuse export deadline exceeded") });
      }, EXPORT_DEADLINE_MS);

      attempts.run(attempt, () => {
        try {
          delegate.export(spans, finish);
        } catch {
          finish({ code: FAILED, error: new Error("Langfuse export failed") });
        }
      });
    },
    forceFlush: () => delegate.forceFlush(),
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      shutdownPromise = delegate.shutdown().finally(() => agent.destroy());
      return shutdownPromise;
    },
  };
}
