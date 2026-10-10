import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const entries = inspectPackedPackage(resolve(process.argv[2]));
const createEmbeddedLangfuse = await loadEmbeddedFactory(entries.embedded);

await verifyConsumerLifecycle(entries.cli, createEmbeddedLangfuse);
console.log("Packed CLI and embedded entries loaded through SDK 1.1.0; caller disposal passed.");

function inspectPackedPackage(consumerDirectory) {
  const consumer = createRequire(join(consumerDirectory, "package.json"));
  const cli = consumer.resolve("@langfuse/pi-observability-plugin");
  const embedded = consumer.resolve("@langfuse/pi-observability-plugin/embedded");
  const packageRoot = dirname(dirname(cli));

  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);

  const documentation = ["README.md", "LICENSE", "docs/cli.md", "docs/library.md"];
  for (const file of documentation) {
    assert.ok(existsSync(join(packageRoot, file)), `Missing packed documentation: ${file}`);
  }

  return { cli, embedded };
}

async function loadEmbeddedFactory(embeddedEntry) {
  // Pi supplies the SDK peer and TypeScript loader; the plugin comes from the consumer.
  const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const sdkRequire = createRequire(sdkEntry);
  const sdkRoot = dirname(dirname(sdkEntry));
  const manifestPath = join(sdkRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.version, "1.1.0");

  const { createJiti } = await import(sdkRequire.resolve("jiti"));
  const loader = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { "@earendil-works/pi-coding-agent": sdkEntry },
  });
  const { createEmbeddedLangfuse } = await loader.import(embeddedEntry);

  assert.equal(typeof createEmbeddedLangfuse, "function");
  assert.throws(() => createEmbeddedLangfuse({}), /configuration/);

  return createEmbeddedLangfuse;
}

async function verifyConsumerLifecycle(cliEntry, createEmbeddedLangfuse) {
  const tracing = createEmbeddedLangfuse({
    endpoint: "http://127.0.0.1:1",
    publicKey: "neutral-packed-public",
    secretKey: "neutral-packed-secret",
  });
  const directory = mkdtempSync(join(tmpdir(), "pi-langfuse-packed-consumer-"));
  const resources = {
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  };

  try {
    const cli = new DefaultResourceLoader({
      ...resources,
      additionalExtensionPaths: [cliEntry],
    });
    await cli.reload();

    const loadedCli = cli.getExtensions();
    assert.deepEqual(loadedCli.errors, []);
    assert.equal(loadedCli.extensions.length, 1);

    const embedded = new DefaultResourceLoader({
      ...resources,
      extensionFactories: [tracing.extension],
    });
    await embedded.reload();

    const loadedEmbedded = embedded.getExtensions();
    assert.deepEqual(loadedEmbedded.errors, []);

    const extension = loadedEmbedded.extensions[0];
    assert.ok(extension);

    const expectedEvents = ["before_agent_start", "tool_execution_start", "session_shutdown"];
    for (const event of expectedEvents) {
      assert.ok(extension.handlers.has(event), `Missing packed handler: ${event}`);
    }

    const disposal = tracing.dispose();
    assert.equal(tracing.dispose(), disposal);
    await disposal;

    await embedded.reload();
    const reloadErrors = embedded.getExtensions().errors;
    const disposedError = reloadErrors.find(({ error }) => error === "Langfuse runtime is disposed");
    assert.ok(disposedError);
  } finally {
    await tracing.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}
