import { AsyncLocalStorage } from "node:async_hooks";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Duplex } from "node:stream";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";

const EXPORT_DEADLINE_MS = 3_000;
const SUCCESS = 0;
const FAILED = 1;

interface ExporterConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

type ExportCallback = Parameters<SpanExporter["export"]>[1];
type ExportAttempt = ReturnType<typeof createExportAttempt>;

// One batch owns one deadline, including retry waits and any retry connections.
function createExportAttempt(callback: ExportCallback, reportFailure: () => void) {
  const sockets = new Set<Duplex>();
  let expired = false;
  let completed = false;
  const deadline = setTimeout(expire, EXPORT_DEADLINE_MS);

  function finish(result: Parameters<ExportCallback>[0]) {
    if (completed) return;
    completed = true;
    clearTimeout(deadline);

    if (expired) {
      result = { code: FAILED, error: new Error("Langfuse export deadline exceeded") };
    }
    if (result.code !== SUCCESS) reportFailure();
    callback(result);
  }

  function expire() {
    expired = true;
    for (const socket of sockets) {
      socket.destroy(new Error("Langfuse export deadline exceeded"));
    }

    // A response error can be reported as success by the standard transport.
    finish({ code: FAILED, error: new Error("Langfuse export deadline exceeded") });
  }

  function trackSocket(socket: Duplex) {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));

    // Retry connections may arrive after the batch has already expired.
    if (expired) socket.destroy(new Error("Langfuse export deadline exceeded"));
  }

  return { finish, trackSocket };
}

function createExportAgent(baseUrl: string, attempts: AsyncLocalStorage<ExportAttempt>) {
  const agent = baseUrl.startsWith("https:")
    ? new HttpsAgent({ keepAlive: false })
    : new HttpAgent({ keepAlive: false });
  const connect = agent.createConnection.bind(agent);

  agent.createConnection = (options, callback) => {
    const attempt = attempts.getStore();
    const onConnect: typeof callback = callback && ((error, socket) => {
      if (socket) attempt?.trackSocket(socket);
      callback(error, socket);
    });

    // Node can supply the connection directly or through the callback.
    const socket = connect(options, onConnect);
    if (socket) attempt?.trackSocket(socket);
    return socket;
  };

  return agent;
}

// Keep the standard OTLP serializer/retry policy. Own only its connections and
// result boundary: the dependency timeout measures inactivity, not elapsed time.
export function createEmbeddedExporter(config: ExporterConfig, reportFailure: () => void): SpanExporter {
  const attempts = new AsyncLocalStorage<ExportAttempt>();
  const agent = createExportAgent(config.baseUrl, attempts);
  const credentials = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");
  const delegate = new OTLPTraceExporter({
    url: `${config.baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${credentials}`,
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

      const attempt = createExportAttempt(callback, reportFailure);
      attempts.run(attempt, () => {
        try {
          delegate.export(spans, attempt.finish);
        } catch {
          attempt.finish({ code: FAILED, error: new Error("Langfuse export failed") });
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
