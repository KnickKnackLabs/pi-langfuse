import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { type Socket } from "node:net";
import { describe, it } from "node:test";
import {
  createOwnedRuntime,
  validateEmbeddedOptions,
  type ExportIssueCode,
} from "../src/embedded-runtime.ts";

async function startEndpoint(reply: (response: ServerResponse, attempt: number) => void) {
  const requests: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(Buffer.concat(chunks));
    reply(response, requests.length);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    async assertDisconnected() {
      // Observe the client's abort before fixture cleanup can close connections.
      for (const socket of sockets) await once(socket, "close");
      assert.equal(sockets.size, 0, "export must close its connections before fixture cleanup");
    },
    async close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

function sendUnfinishedResponse(response: ServerResponse) {
  response.writeHead(200);
  response.write(" ");

  const trickle = setInterval(() => response.write(" "), 100);
  response.once("close", () => clearInterval(trickle));
}

function runtimeFor(endpoint: string, reports: ExportIssueCode[], onReport?: () => void) {
  const config = validateEmbeddedOptions({
    endpoint,
    publicKey: "fake-export-public",
    secretKey: "fake-export-secret",
  });
  return createOwnedRuntime(config, ({ code }) => {
    reports.push(code);
    onReport?.();
  });
}

function finishRoot(runtime: ReturnType<typeof runtimeFor>, name: string) {
  const root = runtime.start(name, { input: "fictional input" }, { asType: "span" }, {});
  root.end();
}

describe("embedded export failure boundaries", () => {
  it("reports rejected shutdown once, closes open observations and stays disposed", async () => {
    const endpoint = await startEndpoint((response) => {
      response.writeHead(400);
      response.end("SYNTHETIC_PRIVATE_ERROR_BODY");
    });
    const reports: ExportIssueCode[] = [];
    const runtime = runtimeFor(endpoint.endpoint, reports);

    try {
      const root = runtime.start("open-root", {}, { asType: "span" }, {});
      const disposal = runtime.dispose();
      assert.equal(runtime.dispose(), disposal);
      await disposal;

      assert.equal(root.otelSpan.isRecording(), false);
      assert.equal(endpoint.requests.length, 1);
      assert.deepEqual(reports, ["export-failed", "shutdown-failed"]);
      assert.throws(() => finishRoot(runtime, "late-root"), /disposed/);
      await runtime.dispose();
      assert.deepEqual(reports, ["export-failed", "shutdown-failed"]);
    } finally {
      await runtime.dispose();
      await endpoint.close();
    }
  });

  it("retries a temporary rejection with the same batch and reports no failure after success", async () => {
    const endpoint = await startEndpoint((response, attempt) => {
      response.writeHead(attempt === 1 ? 503 : 200, { "retry-after": "1" });
      response.end("{}");
    });
    const reports: ExportIssueCode[] = [];
    const runtime = runtimeFor(endpoint.endpoint, reports);

    try {
      finishRoot(runtime, "retry-root");
      await runtime.processor.forceFlush();
      await runtime.dispose();

      assert.equal(endpoint.requests.length, 2);
      assert.deepEqual(endpoint.requests[0], endpoint.requests[1]);
      assert.deepEqual(reports, []);
    } finally {
      await runtime.dispose();
      await endpoint.close();
    }
  });

  it("fails a stalled shutdown within the export deadline and aborts the request", { timeout: 15_000 }, async () => {
    const endpoint = await startEndpoint(() => {
      // Read the request, but send no response at all.
    });
    const reports: ExportIssueCode[] = [];
    const runtime = runtimeFor(endpoint.endpoint, reports);

    try {
      finishRoot(runtime, "stalled-root");
      const started = performance.now();
      await runtime.dispose();
      const elapsed = performance.now() - started;

      // Allow scheduling overhead, without accepting the processor's 30s fallback.
      assert.ok(elapsed < 8_000, `shutdown took ${elapsed.toFixed(0)}ms`);
      assert.deepEqual(reports, ["export-failed", "shutdown-failed"]);
      assert.equal(endpoint.requests.length, 1);

      await endpoint.assertDisconnected();
    } finally {
      await runtime.dispose();
      await endpoint.close();
    }
  });

  it("aborts an unfinished trickling response at the absolute export deadline", { timeout: 15_000 }, async () => {
    const endpoint = await startEndpoint(sendUnfinishedResponse);
    const reports: ExportIssueCode[] = [];
    const runtime = runtimeFor(endpoint.endpoint, reports);

    try {
      finishRoot(runtime, "trickling-root");
      const started = performance.now();
      await runtime.dispose();
      assert.ok(performance.now() - started < 8_000, "trickling response bypassed deadline");
      assert.deepEqual(reports, ["export-failed", "shutdown-failed"]);
      assert.equal(endpoint.requests.length, 1);
      await endpoint.assertDisconnected();
    } finally {
      await runtime.dispose();
      await endpoint.close();
    }
  });

  it("shares one deadline across retries without aborting another runtime", { timeout: 15_000 }, async () => {
    const failing = await startEndpoint((response, attempt) => {
      if (attempt === 1) {
        response.writeHead(503, { "retry-after": "1" });
        response.end("{}");
        return;
      }
      sendUnfinishedResponse(response);
    });
    const healthy = await startEndpoint((response) => response.end("{}"));
    const failedReports: ExportIssueCode[] = [];
    const healthyReports: ExportIssueCode[] = [];
    const failedRuntime = runtimeFor(failing.endpoint, failedReports);
    const healthyRuntime = runtimeFor(healthy.endpoint, healthyReports);

    try {
      finishRoot(failedRuntime, "retried-trickle");
      finishRoot(healthyRuntime, "independent-root");
      const started = performance.now();
      await Promise.all([failedRuntime.dispose(), healthyRuntime.processor.forceFlush()]);
      assert.ok(performance.now() - started < 3_800, "retry reset the absolute deadline");
      assert.equal(failing.requests.length, 2);
      assert.deepEqual(failedReports, ["export-failed", "shutdown-failed"]);
      await failing.assertDisconnected();

      finishRoot(healthyRuntime, "still-usable-root");
      await healthyRuntime.dispose();
      assert.equal(healthy.requests.length, 2);
      assert.deepEqual(healthyReports, []);
    } finally {
      await Promise.all([failedRuntime.dispose(), healthyRuntime.dispose()]);
      await Promise.all([failing.close(), healthy.close()]);
    }
  });

  it("reports an automatic batch rejection without a caller flush", { timeout: 10_000 }, async () => {
    const endpoint = await startEndpoint((response) => {
      response.writeHead(400);
      response.end("SYNTHETIC_PRIVATE_ERROR_BODY");
    });
    const reports: ExportIssueCode[] = [];
    let notifyFailure!: () => void;
    const failure = new Promise<void>((resolve) => {
      notifyFailure = resolve;
    });
    const runtime = runtimeFor(endpoint.endpoint, reports, notifyFailure);

    try {
      for (let index = 0; index < 64; index++) finishRoot(runtime, `background-${index}`);
      await failure;
      assert.deepEqual(reports, ["export-failed"]);
      await runtime.dispose();
      assert.deepEqual(reports, ["export-failed"]);
      await endpoint.assertDisconnected();
    } finally {
      await runtime.dispose();
      await endpoint.close();
    }
  });

  it("does not follow an export redirect to a second endpoint", async () => {
    const target = await startEndpoint((response) => response.end("{}"));
    const redirect = await startEndpoint((response) => {
      response.writeHead(307, { location: `${target.endpoint}/redirect-target` });
      response.end();
    });
    const reports: ExportIssueCode[] = [];
    const runtime = runtimeFor(redirect.endpoint, reports);

    try {
      finishRoot(runtime, "redirect-root");
      await runtime.processor.forceFlush();
      await runtime.dispose();

      assert.equal(redirect.requests.length, 1);
      assert.equal(target.requests.length, 0);
      assert.deepEqual(reports, ["export-failed", "flush-failed"]);
    } finally {
      await runtime.dispose();
      await Promise.all([redirect.close(), target.close()]);
    }
  });
});
