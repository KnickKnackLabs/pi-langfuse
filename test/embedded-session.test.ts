import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createEmbeddedLangfuse } from "../src/embedded.ts";
import { createSandbox, startCaptureServer, startMockProvider } from "./helpers.ts";

it("traces serial SDK 1.1.0 prompts and keeps tracing available after session shutdown", async () => {
  const provider = await startMockProvider();
  const capture = await startCaptureServer();
  const sandbox = createSandbox(provider.port);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const tracing = createEmbeddedLangfuse({
    endpoint: `http://127.0.0.1:${capture.port}`,
    publicKey: "fake-session-public",
    secretKey: "fake-session-secret",
    labels: { userId: "neutral-user", environment: "test", release: "test" },
  });

  const resources = new DefaultResourceLoader({
    cwd: sandbox.workspace,
    agentDir: sandbox.agentDir,
    settingsManager: settings,
    extensionFactories: [tracing.extension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    const modelRuntime = await ModelRuntime.create({
      modelsPath: join(sandbox.agentDir, "models.json"),
      authPath: join(sandbox.agentDir, "auth.json"),
      modelsStorePath: join(sandbox.agentDir, "models-store.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const model = modelRuntime.getModel("mock", "mock-gpt-1");
    assert.ok(model);

    await resources.reload();
    assert.deepEqual(resources.getExtensions().errors, []);

    ({ session } = await createAgentSession({
      cwd: sandbox.workspace,
      agentDir: sandbox.agentDir,
      modelRuntime,
      model,
      thinkingLevel: "off",
      resourceLoader: resources,
      sessionManager: SessionManager.inMemory(sandbox.workspace),
      settingsManager: settings,
    }));

    await session.prompt("Inspect this neutral test workspace.");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

    await session.prompt("Inspect this neutral test workspace again.");
    await tracing.dispose();

    const exported = capture.spans();
    const sessionId = session.sessionManager.getSessionId();
    const roots = exported.filter((span) => span.name === "Conversational Turn");
    const generations = exported.filter(
      (span) => span.attrs["langfuse.observation.type"] === "generation",
    );
    const tools = exported.filter(
      (span) => span.attrs["langfuse.observation.type"] === "tool",
    );
    const expectedOutput = JSON.stringify({
      role: "assistant",
      content: "This is the test workspace. Done.",
    });

    assert.equal(roots.length, 2);
    assert.ok(generations.length >= 2);
    assert.ok(tools.length >= 2);

    for (const span of exported) {
      assert.equal(span.attrs["session.id"], sessionId);
      assert.equal(span.attrs["user.id"], "neutral-user");
    }
    for (const root of roots) {
      assert.equal(root.attrs["langfuse.observation.output"], expectedOutput);
    }

    const children = [...generations, ...tools];
    for (const child of children) {
      const parent = roots.find((root) => root.spanId === child.parentSpanId);
      assert.ok(parent);
      assert.equal(child.traceId, parent.traceId);
    }
  } finally {
    session?.dispose();
    await tracing.dispose();
    provider.close();
    capture.close();
    rmSync(sandbox.agentDir, { recursive: true, force: true });
    rmSync(sandbox.workspace, { recursive: true, force: true });
  }
});
