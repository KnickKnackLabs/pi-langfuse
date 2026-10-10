import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createEmbeddedLangfuse } from "../src/embedded.ts";

it("loads the embedding factory through SDK 1.1.0 without ambient resources or export", async () => {
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
    for (const event of ["before_agent_start", "before_provider_request", "tool_execution_start", "session_shutdown"]) {
      assert.ok(extension.handlers.has(event));
    }
    const disposal = tracing.dispose();
    assert.equal(tracing.dispose(), disposal);
    await disposal;
    await loader.reload();
    assert.ok(loader.getExtensions().errors.some((error) => error.error === "Langfuse runtime is disposed"));
  } finally {
    await tracing.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
