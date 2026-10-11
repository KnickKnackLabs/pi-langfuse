import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { context, diag, trace } from "@opentelemetry/api";
import {
  createOwnedRuntime,
  validateEmbeddedOptions,
  type ExportIssueCode,
} from "../src/embedded-runtime.ts";

interface ExportedAttribute {
  key: string;
  value: {
    stringValue?: string;
    arrayValue?: { values: Array<{ stringValue: string }> };
  };
}

interface ExportedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: ExportedAttribute[];
}

interface ExportedResource {
  resource: { attributes: ExportedAttribute[] };
  scopeSpans: Array<{ spans: ExportedSpan[] }>;
}

interface ExportBody {
  resourceSpans: ExportedResource[];
}

const HEADER_KEYS = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
] as const;

const FAKE_OPTIONS = {
  endpoint: "http://127.0.0.1:9999",
  publicKey: "fake-public",
  secretKey: "fake-secret",
};

function setEnvironment(values: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function startCollector(publicKey: string, secretKey: string, status = 200) {
  const bodies: ExportBody[] = [];
  const failures: unknown[] = [];
  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const expectedAuthorization = `Basic ${credentials}`;

  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/api/public/otel/v1/traces");
      assert.equal(request.headers.authorization, expectedAuthorization);
      assert.equal(request.headers["x-synthetic-private"], undefined);

      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requestBody = Buffer.concat(chunks).toString("utf8");
      bodies.push(JSON.parse(requestBody));
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

  return {
    bodies,
    failures,
    endpoint: `http://127.0.0.1:${address.port}`,
    spans(): ExportedSpan[] {
      const exported: ExportedSpan[] = [];
      for (const body of bodies) {
        for (const resource of body.resourceSpans) {
          for (const scope of resource.scopeSpans) exported.push(...scope.spans);
        }
      }
      return exported;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function attribute(span: ExportedSpan, key: string): string | undefined {
  const matchingAttribute = span.attributes.find((item) => item.key === key);
  return matchingAttribute?.value.stringValue;
}

function observationFields(span: ExportedSpan) {
  return {
    sessionId: attribute(span, "session.id"),
    traceId: span.traceId,
    parentSpanId: span.parentSpanId,
    input: attribute(span, "langfuse.observation.input"),
    output: attribute(span, "langfuse.observation.output"),
  };
}

function processTracingGlobals() {
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
    const invalidOptions = [
      { ...FAKE_OPTIONS, endpoint: "" },
      { ...FAKE_OPTIONS, secretKey: "" },
      { ...FAKE_OPTIONS, publicKey: undefined },
      { ...FAKE_OPTIONS, endpoint: "file:///SYNTHETIC_PRIVATE_PATH" },
      { ...FAKE_OPTIONS, endpoint: "https://fake-user:fake-password@example.test" },
      { ...FAKE_OPTIONS, endpoint: "https://example.test?SYNTHETIC_PRIVATE_QUERY" },
    ];

    for (const invalid of invalidOptions) {
      assert.throws(() => validateEmbeddedOptions(invalid as typeof FAKE_OPTIONS), (error: Error) => {
        assert.match(error.message, /^Invalid explicit Langfuse/);
        assert.doesNotMatch(error.message, /fake-secret|fake-password|SYNTHETIC_PRIVATE/);
        return true;
      });
    }

    const config = validateEmbeddedOptions({
      ...FAKE_OPTIONS,
      endpoint: "https://example.test/prefix/",
    });

    assert.deepEqual(config, {
      publicKey: "fake-public",
      secretKey: "fake-secret",
      baseUrl: "https://example.test/prefix",
      userId: undefined,
      environment: "",
      release: "",
    });
  });

  for (const headerKey of HEADER_KEYS) {
    it(`refuses nonempty ${headerKey} without exposing its value or changing the environment`, (t) => {
      const restoreEnvironment = setEnvironment({
        OTEL_EXPORTER_OTLP_HEADERS: undefined,
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: undefined,
        [headerKey]: "x-synthetic-private=SYNTHETIC_AMBIENT_CREDENTIAL",
      });
      t.after(restoreEnvironment);
      const beforeEnvironment = { ...process.env };
      const config = validateEmbeddedOptions(FAKE_OPTIONS);
      const expectedMessage = "Clear OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_TRACES_HEADERS before creating an embedded Langfuse runtime";

      assert.throws(() => createOwnedRuntime(config), (error: Error) => {
        assert.equal(error.message, expectedMessage);
        assert.doesNotMatch(error.message, /fake-secret|SYNTHETIC_AMBIENT_CREDENTIAL|x-synthetic-private/);
        return true;
      });
      assert.deepEqual({ ...process.env }, beforeEnvironment);
    });
  }

  for (const headerValue of [undefined, ""]) {
    const scenario = headerValue === undefined ? "unset" : "empty";

    it(`accepts ${scenario} ambient header variables without changing the environment`, async (t) => {
      const restoreEnvironment = setEnvironment({
        OTEL_EXPORTER_OTLP_HEADERS: headerValue,
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: headerValue,
      });
      t.after(restoreEnvironment);
      const beforeEnvironment = { ...process.env };
      const config = validateEmbeddedOptions(FAKE_OPTIONS);

      const runtime = createOwnedRuntime(config);
      await runtime.dispose();

      assert.deepEqual({ ...process.env }, beforeEnvironment);
    });
  }

  it("captures clean headers for two runtimes even when both ambient header variables change later", async (t) => {
    const restoreEnvironment = setEnvironment({
      OTEL_EXPORTER_OTLP_HEADERS: "",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
    });
    t.after(restoreEnvironment);
    const collector = await startCollector("fake-public", "fake-secret");
    const config = validateEmbeddedOptions({ ...FAKE_OPTIONS, endpoint: collector.endpoint });
    const runtimeA = createOwnedRuntime(config);
    const runtimeB = createOwnedRuntime(config);

    try {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-synthetic-private=SYNTHETIC_GENERIC_CREDENTIAL";
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = "x-synthetic-private=SYNTHETIC_TRACE_CREDENTIAL";
      const beforeEnvironment = { ...process.env };

      const rootA = runtimeA.start("root-A", { input: "11+12", output: "23" }, { asType: "span" }, {});
      const rootB = runtimeB.start("root-B", { input: "101+102", output: "203" }, { asType: "span" }, {});
      rootA.end();
      rootB.end();
      await Promise.all([runtimeA.dispose(), runtimeB.dispose()]);

      assert.equal(collector.spans().length, 2);
      assert.deepEqual(collector.failures, []);
      assert.deepEqual({ ...process.env }, beforeEnvironment);
    } finally {
      await Promise.all([runtimeA.dispose(), runtimeB.dispose()]);
      await collector.close();
    }
  });

  it("copies attribution when an observation starts", async (t) => {
    t.after(setEnvironment({
      OTEL_EXPORTER_OTLP_HEADERS: undefined,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: undefined,
    }));
    const collector = await startCollector("fake-public", "fake-secret");
    const config = validateEmbeddedOptions({ ...FAKE_OPTIONS, endpoint: collector.endpoint });
    const runtime = createOwnedRuntime(config);
    const attribution = { "session.id": "original-session", "langfuse.trace.tags": ["original-tag"] };

    try {
      const root = runtime.start("root", {}, { asType: "span" }, attribution);
      attribution["session.id"] = "mutated-session";
      attribution["langfuse.trace.tags"].push("mutated-tag");
      root.end();
      await runtime.dispose();

      const exported = collector.spans();
      assert.equal(exported.length, 1);
      const exportedRoot = exported[0];
      assert.ok(exportedRoot);
      assert.equal(attribute(exportedRoot, "session.id"), "original-session");
      const tags = exportedRoot.attributes.find((item) => item.key === "langfuse.trace.tags");
      assert.deepEqual(tags?.value.arrayValue?.values, [{ stringValue: "original-tag" }]);
      assert.ok(!JSON.stringify(exported).includes("mutated"));
      assert.deepEqual(collector.failures, []);
    } finally {
      await runtime.dispose();
      await collector.close();
    }
  });

  it("uses explicit configuration instead of ambient keys, labels, resources and parent context", async (t) => {
    const restoreEnvironment = setEnvironment({
      LANGFUSE_PUBLIC_KEY: "ambient-public",
      LANGFUSE_SECRET_KEY: "ambient-secret",
      LANGFUSE_BASE_URL: "https://do-not-call.invalid",
      LANGFUSE_TRACING_ENVIRONMENT: "ambient-environment",
      LANGFUSE_RELEASE: "ambient-release",
      LANGFUSE_MEDIA_UPLOAD_ENABLED: "true",
      OTEL_SERVICE_NAME: "ambient-service",
      OTEL_RESOURCE_ATTRIBUTES: "private=ambient-resource",
      OTEL_EXPORTER_OTLP_HEADERS: "",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
      LANGFUSE_PI_PARENT_TRACE_ID: "12345678901234567890123456789012",
      LANGFUSE_PI_PARENT_SPAN_ID: "1234567890123456",
    });
    t.after(restoreEnvironment);
    const beforeEnvironment = { ...process.env };
    const collector = await startCollector("fake-public", "fake-secret");
    const config = validateEmbeddedOptions({ ...FAKE_OPTIONS, endpoint: collector.endpoint });
    const runtime = createOwnedRuntime(config);

    try {
      const root = runtime.start("root", {}, { asType: "span" }, { "session.id": "explicit-session" });
      root.end();
      await runtime.dispose();

      const exported = collector.spans();
      assert.equal(exported.length, 1);
      const exportedRoot = exported[0];
      assert.ok(exportedRoot);
      assert.equal(exportedRoot.parentSpanId, undefined);
      assert.equal(attribute(exportedRoot, "session.id"), "explicit-session");
      assert.equal(attribute(exportedRoot, "langfuse.environment"), "");
      assert.equal(attribute(exportedRoot, "langfuse.release"), "");
      assert.ok(!JSON.stringify(collector.bodies).includes("ambient-"));
      assert.deepEqual(collector.failures, []);
      assert.deepEqual({ ...process.env }, beforeEnvironment);
    } finally {
      await runtime.dispose();
      await collector.close();
    }
  });

  it("keeps concurrent runtimes isolated and lets B continue after A is disposed", async (t) => {
    t.after(setEnvironment({
      OTEL_EXPORTER_OTLP_HEADERS: undefined,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: undefined,
    }));
    const beforeEnvironment = { ...process.env };
    const beforeGlobals = processTracingGlobals();
    const collectorA = await startCollector("fake-public-A", "fake-secret-A");
    const collectorB = await startCollector("fake-public-B", "fake-secret-B");
    const configA = validateEmbeddedOptions({
      endpoint: collectorA.endpoint,
      publicKey: "fake-public-A",
      secretKey: "fake-secret-A",
    });
    const configB = validateEmbeddedOptions({
      endpoint: collectorB.endpoint,
      publicKey: "fake-public-B",
      secretKey: "fake-secret-B",
    });
    const runtimeA = createOwnedRuntime(configA);
    const runtimeB = createOwnedRuntime(configB);

    try {
      const attributionA = { "session.id": "opaque-A" };
      const attributionB = { "session.id": "opaque-B" };
      const [rootA, rootB] = await Promise.all([
        Promise.resolve().then(() => runtimeA.start(
          "root-A",
          { input: "11+12", output: "23" },
          { asType: "span" },
          attributionA,
        )),
        Promise.resolve().then(() => runtimeB.start(
          "root-B",
          { input: "101+102", output: "203" },
          { asType: "span" },
          attributionB,
        )),
      ]);

      const childA = runtimeA.start(
        "generation-A",
        { input: "11+12", output: "23" },
        { asType: "generation", parentSpanContext: rootA.otelSpan.spanContext() },
        attributionA,
      );
      const childB = runtimeB.start(
        "tool-B",
        { input: { a: 101, b: 102 }, output: 203 },
        { asType: "tool", parentSpanContext: rootB.otelSpan.spanContext() },
        attributionB,
      );

      childA.end();
      rootA.end();
      const disposalA = runtimeA.dispose();
      assert.equal(runtimeA.dispose(), disposalA);
      await disposalA;
      assert.throws(() => runtimeA.start("late-A", {}, { asType: "span" }, {}), /disposed/);

      childB.end();
      const lateB = runtimeB.start(
        "generation-B",
        { input: "201+202", output: "403" },
        { asType: "generation", parentSpanContext: rootB.otelSpan.spanContext() },
        attributionB,
      );
      lateB.end();
      rootB.end();
      await runtimeB.processor.forceFlush();
      await runtimeB.dispose();

      const exportedA = collectorA.spans();
      const exportedB = collectorB.spans();
      assert.equal(exportedA.length, 2);
      assert.equal(exportedB.length, 3);

      for (const span of exportedA) {
        assert.equal(attribute(span, "session.id"), "opaque-A");
        assert.equal(attribute(span, "langfuse.environment"), "");
        assert.equal(attribute(span, "langfuse.release"), "");
      }
      for (const span of exportedB) {
        assert.equal(attribute(span, "session.id"), "opaque-B");
        assert.equal(attribute(span, "langfuse.environment"), "");
        assert.equal(attribute(span, "langfuse.release"), "");
      }
      assert.ok(!JSON.stringify(exportedA).includes("101+102"));
      assert.ok(!JSON.stringify(exportedB).includes("11+12"));

      const rootIdA = rootA.otelSpan.spanContext().spanId;
      const rootIdB = rootB.otelSpan.spanContext().spanId;
      const exportedRootA = exportedA.find((span) => span.spanId === rootIdA);
      const exportedRootB = exportedB.find((span) => span.spanId === rootIdB);
      assert.ok(exportedRootA);
      assert.ok(exportedRootB);
      assert.equal(exportedRootA.parentSpanId, undefined);
      assert.equal(exportedRootB.parentSpanId, undefined);
      assert.notEqual(exportedRootA.traceId, exportedRootB.traceId);
      assert.equal(attribute(exportedRootA, "langfuse.observation.output"), "23");
      assert.equal(attribute(exportedRootB, "langfuse.observation.output"), "203");

      const generationA = exportedA.find((span) => span.spanId === childA.otelSpan.spanContext().spanId);
      const toolB = exportedB.find((span) => span.spanId === childB.otelSpan.spanContext().spanId);
      const generationB = exportedB.find((span) => span.spanId === lateB.otelSpan.spanContext().spanId);
      assert.ok(generationA);
      assert.ok(toolB);
      assert.ok(generationB);
      assert.deepEqual(observationFields(generationA), {
        sessionId: "opaque-A",
        traceId: exportedRootA.traceId,
        parentSpanId: rootIdA,
        input: "11+12",
        output: "23",
      });
      assert.deepEqual(observationFields(toolB), {
        sessionId: "opaque-B",
        traceId: exportedRootB.traceId,
        parentSpanId: rootIdB,
        input: '{"a":101,"b":102}',
        output: "203",
      });
      assert.deepEqual(observationFields(generationB), {
        sessionId: "opaque-B",
        traceId: exportedRootB.traceId,
        parentSpanId: rootIdB,
        input: "201+202",
        output: "403",
      });

      assert.deepEqual(collectorA.failures, []);
      assert.deepEqual(collectorB.failures, []);
      assert.deepEqual(processTracingGlobals(), beforeGlobals);
      assert.deepEqual({ ...process.env }, beforeEnvironment);
    } finally {
      await Promise.all([runtimeA.dispose(), runtimeB.dispose()]);
      await Promise.all([collectorA.close(), collectorB.close()]);
    }
  });

  it("reports repeated flush failures once and contains diagnostic callback failures", async (t) => {
    const restoreEnvironment = setEnvironment({
      OTEL_EXPORTER_OTLP_HEADERS: undefined,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: undefined,
    });
    t.after(restoreEnvironment);
    const collector = await startCollector("fake-public", "fake-secret", 400);
    const reports: Array<{ code: ExportIssueCode }> = [];
    const config = validateEmbeddedOptions({ ...FAKE_OPTIONS, endpoint: collector.endpoint });
    const runtime = createOwnedRuntime(config, (issue) => {
      reports.push(issue);
      throw new Error("SYNTHETIC_PRIVATE_CALLBACK_ERROR");
    });

    try {
      const firstRoot = runtime.start("root", { input: "SYNTHETIC_PRIVATE_PROMPT" }, { asType: "span" }, {});
      firstRoot.end();
      await runtime.processor.forceFlush();

      const secondRoot = runtime.start("second-root", {}, { asType: "span" }, {});
      secondRoot.end();
      await runtime.processor.forceFlush();

      assert.deepEqual(reports, [
        { code: "export-failed", failure: { reason: "http", httpStatus: 400 } },
        { code: "flush-failed" },
      ]);
      assert.ok(reports.every(Object.isFrozen));
      assert.deepEqual(collector.failures, []);
    } finally {
      await runtime.dispose();
      await collector.close();
    }
  });
});
