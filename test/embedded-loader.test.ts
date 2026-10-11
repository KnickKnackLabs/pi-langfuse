import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  type ExtensionContext,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createEmbeddedLangfuse } from "../src/embedded.ts";
import { startCaptureServer } from "./helpers.ts";

it("loads the library factory through SDK 1.1.0 and rejects reloading a disposed handle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-langfuse-embedded-loader-"));
  const tracing = createEmbeddedLangfuse({
    endpoint: "http://127.0.0.1:1",
    publicKey: "fake-loader-public",
    secretKey: "fake-loader-secret",
  });

  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [tracing.extension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  try {
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);

    const extension = loaded.extensions.find((entry) => entry.path === "<inline:1>");
    assert.ok(extension);
    const expectedEvents = [
      "before_agent_start",
      "before_provider_request",
      "tool_execution_start",
      "session_shutdown",
    ];
    for (const event of expectedEvents) assert.ok(extension.handlers.has(event));

    const disposal = tracing.dispose();
    assert.equal(tracing.dispose(), disposal);
    await disposal;

    await loader.reload();
    const reloadErrors = loader.getExtensions().errors;
    const disposedError = reloadErrors.find((error) => error.error === "Langfuse runtime is disposed");
    assert.ok(disposedError);
  } finally {
    await tracing.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps fallback turn counters session-local and disposes every outstanding prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-langfuse-session-lifecycle-"));
  const capture = await startCaptureServer();
  const tracing = createEmbeddedLangfuse({
    endpoint: `http://127.0.0.1:${capture.port}`,
    publicKey: "neutral-lifecycle-public",
    secretKey: "neutral-lifecycle-secret",
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [tracing.extension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  // Drive loaded handlers directly: this tests tracing cleanup, not Pi's emission policy.
  const contextFor = (id: string) => ({
    cwd: directory,
    sessionManager: {
      getSessionId: () => id,
      getEntries: () => { throw new Error("Neutral unavailable history"); },
    },
  }) as unknown as ExtensionContext;

  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const extension = loader.getExtensions().extensions[0];
    assert.ok(extension);
    const start = extension.handlers.get("before_agent_start")?.[0];
    const shutdown = extension.handlers.get("session_shutdown")?.[0];
    assert.ok(start && shutdown);
    const contextA = contextFor("session-A");
    const contextB = contextFor("session-B");

    await start({ prompt: "A's first prompt" }, contextA);
    await start({ prompt: "B's first prompt" }, contextB);
    await start({ prompt: "A's second prompt" }, contextA);
    await shutdown({ reason: "quit" }, contextA);
    await tracing.dispose();

    const roots = capture.spans().filter((span) => span.name === "Conversational Turn");
    assert.equal(roots.length, 3);
    assert.deepEqual(roots.map((root) => ({
      session: root.attrs["session.id"],
      turn: Number(root.attrs["langfuse.observation.metadata.turn_number"]),
      cancelled: root.attrs["langfuse.observation.metadata.cancelled"],
    })), [
      { session: "session-A", turn: 1, cancelled: "true" },
      { session: "session-A", turn: 2, cancelled: "true" },
      { session: "session-B", turn: 1, cancelled: "true" },
    ]);
    assert.throws(() => start({ prompt: "Too late" }, contextB), /disposed/);
  } finally {
    await tracing.dispose();
    capture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
