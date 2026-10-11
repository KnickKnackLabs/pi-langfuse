# Pi tracing for Langfuse

Send Pi prompts, model calls and tool calls to [Langfuse](https://langfuse.com),
with conversation history, reasoning, token usage and cost. Each prompt becomes
a trace; prompts from the same session share a session ID.

This is [KnickKnackLabs' source-only fork](https://github.com/KnickKnackLabs/pi-langfuse)
of the official [Langfuse plugin](https://github.com/langfuse/pi-observability-plugin).
It is experimental and private: install this checkout, not the upstream npm package.

## CLI setup

Use Node.js 22+ and npm on your `PATH`. Install the checkout's dependencies,
then add it to Pi:

```bash
cd /path/to/pi-langfuse
pnpm install
pi install /path/to/pi-langfuse
```

Create `~/.pi/agent/langfuse.json` and keep it private:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "http://localhost:3000"
}
```

Run Pi normally. To disable tracing for one run:

```bash
LANGFUSE_TRACING_ENABLED=false pi
```

See [CLI configuration](docs/cli.md) for environment overrides, images,
child-process tracing and removal.

## Using Pi as a library

With `@earendil-works/pi-coding-agent` **1.1.0**, give the factory your
application's Langfuse configuration and load its extension through Pi:

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createEmbeddedLangfuse } from "./pi-langfuse/src/embedded.ts";

const tracing = createEmbeddedLangfuse({
  endpoint: config.langfuseUrl,
  publicKey: config.langfusePublicKey,
  secretKey: config.langfuseSecretKey,
});

try {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [tracing.extension],
    noExtensions: true,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
  });
  try {
    await session.prompt("What files are in this project?");
  } finally {
    session.dispose();
  }
} finally {
  await tracing.dispose();
}
```

Sessions can overlap through one shared loader and tracing handle. Give each
session its own `SessionManager`; prompts within one session remain sequential.
Use a loader without the tracing extension for sessions you don't want traced.
The application disposes the handle after its sessions finish.

Before creating the handle, clear `OTEL_EXPORTER_OTLP_HEADERS` and
`OTEL_EXPORTER_OTLP_TRACES_HEADERS` in your deployment; nonempty values are
refused. Keep dependency DEBUG logging off in production: it can print
conversation contents and configuration.

See [library configuration and lifecycle](docs/library.md) for labels,
error reporting and transport limits. Library tracing disables image uploads
and child-process parent propagation.

## Development

```bash
pnpm run typecheck
pnpm test
```

Pi loads the TypeScript source directly; there is no build step. The tarball
also contains source, so library consumers need a TypeScript-capable loader
for its `@langfuse/pi-observability-plugin/embedded` entry.

The embedded tests use SDK 1.1.0, including three traced and three untraced
overlapping sessions. CI's `PI_BIN` matrix varies the CLI subprocess only;
it does not establish embedded compatibility with those other versions.
The package check loads both fork entries from an installed tarball and checks
caller disposal. It does not send model requests or live Langfuse traffic.

[MIT license](LICENSE). For upstream troubleshooting, see
[Langfuse's Pi integration guide](https://langfuse.com/integrations/developer-tools/pi-agent).
