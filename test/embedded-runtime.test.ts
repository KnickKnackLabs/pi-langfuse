import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import { context, diag, trace } from "@opentelemetry/api";
import { createOwnedRuntime, validateEmbeddedOptions, type ExportIssueCode } from "../src/embedded-runtime.ts";

interface ExportedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Array<{ key: string; value: { stringValue?: string; arrayValue?: { values: Array<{ stringValue: string }> } } }>;
}
interface ExportBody {
  resourceSpans: Array<{ resource: { attributes: ExportedSpan["attributes"] }; scopeSpans: Array<{ spans: ExportedSpan[] }> }>;
}

async function startCollector(publicKey: string, secretKey: string, status = 200) {
  const bodies: ExportBody[] = [];
  const failures: unknown[] = [];
  const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/api/public/otel/v1/traces");
      assert.equal(request.headers.authorization, authorization);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      assert.equal(request.headers["x-synthetic-private"], undefined);
    } catch (error) {
      failures.push(error);
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(status === 200 ? "{}" : "SYNTHETIC_PRIVATE_ERROR_BODY");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, bodies, failures, endpoint: `http://127.0.0.1:${address.port}` };
}

const closeServer = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});
const spans = (bodies: ExportBody[]) => bodies.flatMap((body) => body.resourceSpans.flatMap(
  (resource) => resource.scopeSpans.flatMap((scope) => scope.spans),
));
const attribute = (span: ExportedSpan, key: string) => span.attributes.find((item) => item.key === key)?.value.stringValue;

function globals() {
  return {
    provider: trace.getTracerProvider(),
    activeContext: context.active(),
    diagError: diag.error,
    langfuse: { ...Reflect.get(globalThis, Symbol.for("langfuse")) },
    registry: { ...Reflect.get(globalThis, Symbol.for("opentelemetry.js.api.1")) },
  };
}

describe("explicit owned runtime", () => {
  it("rejects incomplete and unsafe config without exposing input values", () => {
    const complete = { endpoint: "http://127.0.0.1:9999", publicKey: "fake-public", secretKey: "fake-secret" };
    for (const invalid of [
      { ...complete, endpoint: "" },
      { ...complete, secretKey: "" },
      { ...complete, publicKey: undefined },
      { ...complete, endpoint: "file:///SYNTHETIC_PRIVATE_PATH" },
      { ...complete, endpoint: "https://fake-user:fake-password@example.test" },
      { ...complete, endpoint: "https://example.test?SYNTHETIC_PRIVATE_QUERY" },
    ]) {
      assert.throws(() => validateEmbeddedOptions(invalid as typeof complete), (error: Error) => {
        assert.match(error.message, /^Invalid explicit Langfuse/);
        assert.doesNotMatch(error.message, /fake-secret|fake-password|SYNTHETIC_PRIVATE/);
        return true;
      });
    }
    assert.deepEqual(validateEmbeddedOptions({ ...complete, endpoint: "https://example.test/prefix/" }), {
      publicKey: "fake-public", secretKey: "fake-secret", baseUrl: "https://example.test/prefix",
      userId: undefined, environment: "", release: "",
    });
  });

  it("refuses either nonempty ambient header variable at runtime construction without exposing values", () => {
    const headerKeys = ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"] as const;
    const saved = Object.fromEntries(headerKeys.map((key) => [key, process.env[key]]));
    const options = { endpoint: "http://127.0.0.1:9999", publicKey: "fake-public", secretKey: "fake-secret" };
    const expectedMessage = "Clear OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_TRACES_HEADERS before creating an embedded Langfuse runtime";

    try {
      for (const key of headerKeys) {
        for (const headerKey of headerKeys) delete process.env[headerKey];
        process.env[key] = "x-synthetic-private=SYNTHETIC_AMBIENT_CREDENTIAL";
        const beforeEnvironment = { ...process.env };
        const config = validateEmbeddedOptions(options);
        assert.throws(() => createOwnedRuntime(config), (error: Error) => {
          assert.equal(error.message, expectedMessage);
          assert.doesNotMatch(error.message, /fake-secret|SYNTHETIC_AMBIENT_CREDENTIAL|x-synthetic-private/);
          return true;
        });
        assert.deepEqual({ ...process.env }, beforeEnvironment);
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("accepts unset or empty ambient header variables without changing the environment", async () => {
    const headerKeys = ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"] as const;
    const saved = Object.fromEntries(headerKeys.map((key) => [key, process.env[key]]));
    const config = validateEmbeddedOptions({ endpoint: "http://127.0.0.1:9999", publicKey: "fake-public", secretKey: "fake-secret" });

    try {
      for (const value of [undefined, ""]) {
        for (const key of headerKeys) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        const beforeEnvironment = { ...process.env };
        const runtime = createOwnedRuntime(config);
        await runtime.dispose();
        assert.deepEqual({ ...process.env }, beforeEnvironment);
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("routes concurrent owned observations independently and ignores later ambient header changes", async () => {
    const collectorA = await startCollector("fake-public-A", "fake-secret-A");
    const collectorB = await startCollector("fake-public-B", "fake-secret-B");
    const ambient = {
      LANGFUSE_PUBLIC_KEY: "ambient-public", LANGFUSE_SECRET_KEY: "ambient-secret",
      LANGFUSE_BASE_URL: "https://do-not-call.invalid", LANGFUSE_TRACING_ENVIRONMENT: "ambient-environment",
      LANGFUSE_RELEASE: "ambient-release", LANGFUSE_MEDIA_UPLOAD_ENABLED: "true",
      OTEL_SERVICE_NAME: "ambient-service", OTEL_RESOURCE_ATTRIBUTES: "private=ambient-resource",
      OTEL_EXPORTER_OTLP_HEADERS: "", OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
      LANGFUSE_PI_PARENT_TRACE_ID: "12345678901234567890123456789012",
      LANGFUSE_PI_PARENT_SPAN_ID: "1234567890123456",
    };
    const saved = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
    Object.assign(process.env, ambient);
    const beforeGlobals = globals();
    const runtimeA = createOwnedRuntime(validateEmbeddedOptions({ endpoint: collectorA.endpoint, publicKey: "fake-public-A", secretKey: "fake-secret-A" }));
    const runtimeB = createOwnedRuntime(validateEmbeddedOptions({ endpoint: collectorB.endpoint, publicKey: "fake-public-B", secretKey: "fake-secret-B" }));
    // The locked exporter captures headers at construction, not on later exports.
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-synthetic-private=SYNTHETIC_AMBIENT_CREDENTIAL";
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = "x-synthetic-private=SYNTHETIC_AMBIENT_CREDENTIAL";
    const beforeEnvironment = { ...process.env };

    try {
      const attributionA = { "session.id": "opaque-A", "langfuse.trace.tags": ["original"] };
      const attributionB = { "session.id": "opaque-B" };
      const [rootA, rootB] = await Promise.all([
        Promise.resolve().then(() => runtimeA.start("root-A", { input: "11+12", output: "23" }, { asType: "span" }, attributionA)),
        Promise.resolve().then(() => runtimeB.start("root-B", { input: "101+102", output: "203" }, { asType: "span" }, attributionB)),
      ]);
      attributionA["session.id"] = "mutated-session";
      attributionA["langfuse.trace.tags"].push("mutated-tag");
      const childA = runtimeA.start("generation-A", { input: "11+12", output: "23" }, {
        asType: "generation", parentSpanContext: rootA.otelSpan.spanContext(),
      }, { "session.id": "opaque-A" });
      const childB = runtimeB.start("tool-B", { input: { a: 101, b: 102 }, output: 203 }, {
        asType: "tool", parentSpanContext: rootB.otelSpan.spanContext(),
      }, attributionB);
      childA.end();
      rootA.end();
      await runtimeA.dispose();
      assert.equal(runtimeA.dispose(), runtimeA.dispose());
      assert.throws(() => runtimeA.start("late-A", {}, { asType: "span" }, {}), /disposed/);

      childB.end();
      const lateB = runtimeB.start("generation-B", { input: "201+202", output: "403" }, {
        asType: "generation", parentSpanContext: rootB.otelSpan.spanContext(),
      }, attributionB);
      lateB.end();
      rootB.end();
      await runtimeB.processor.forceFlush();
      await runtimeB.dispose();

      const exportedA = spans(collectorA.bodies);
      const exportedB = spans(collectorB.bodies);
      assert.equal(exportedA.length, 2);
      assert.equal(exportedB.length, 3);
      for (const [exported, sessionId, foreignOperand] of [[exportedA, "opaque-A", "101+102"], [exportedB, "opaque-B", "11+12"]] as const) {
        assert.ok(exported.every((span) => attribute(span, "session.id") === sessionId));
        assert.ok(exported.every((span) => attribute(span, "langfuse.environment") === ""));
        assert.ok(exported.every((span) => attribute(span, "langfuse.release") === ""));
        assert.ok(!JSON.stringify(exported).includes(foreignOperand));
      }
      const exportedRootA = exportedA.find((span) => span.spanId === rootA.otelSpan.spanContext().spanId)!;
      const exportedRootB = exportedB.find((span) => span.spanId === rootB.otelSpan.spanContext().spanId)!;
      assert.equal(exportedRootA.parentSpanId, undefined);
      assert.equal(exportedRootB.parentSpanId, undefined);
      assert.notEqual(exportedRootA.traceId, exportedRootB.traceId);
      assert.equal(attribute(exportedRootA, "langfuse.observation.output"), "23");
      assert.equal(attribute(exportedRootB, "langfuse.observation.output"), "203");
      assert.ok(!JSON.stringify(exportedRootA).includes("mutated"));
      assert.ok(exportedA.filter((span) => span !== exportedRootA).every((span) => span.parentSpanId === exportedRootA.spanId && span.traceId === exportedRootA.traceId));
      assert.ok(exportedB.filter((span) => span !== exportedRootB).every((span) => span.parentSpanId === exportedRootB.spanId && span.traceId === exportedRootB.traceId));
      assert.ok(!JSON.stringify([...collectorA.bodies, ...collectorB.bodies]).includes("ambient-"));
      assert.deepEqual(collectorA.failures, []);
      assert.deepEqual(collectorB.failures, []);
      assert.deepEqual(globals(), beforeGlobals);
      assert.deepEqual({ ...process.env }, beforeEnvironment);
    } finally {
      await Promise.all([runtimeA.dispose(), runtimeB.dispose()]);
      await Promise.all([closeServer(collectorA.server), closeServer(collectorB.server)]);
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reports only bounded issue codes and contains callback failures", async () => {
    const collector = await startCollector("fake-public", "fake-secret", 400);
    const reports: Array<{ code: ExportIssueCode }> = [];
    const runtime = createOwnedRuntime(validateEmbeddedOptions({ endpoint: collector.endpoint, publicKey: "fake-public", secretKey: "fake-secret" }), (issue) => {
      reports.push(issue);
      throw new Error("SYNTHETIC_PRIVATE_CALLBACK_ERROR");
    });
    try {
      runtime.start("root", { input: "SYNTHETIC_PRIVATE_PROMPT" }, { asType: "span" }, {}).end();
      await runtime.processor.forceFlush();
      runtime.start("second-root", {}, { asType: "span" }, {}).end();
      await runtime.processor.forceFlush();
      assert.deepEqual(reports, [{ code: "flush-failed" }]);
      assert.ok(Object.isFrozen(reports[0]));
    } finally {
      await runtime.dispose();
      await closeServer(collector.server);
    }
  });
});
