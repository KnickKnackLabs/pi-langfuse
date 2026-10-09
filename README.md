# Langfuse Observability Plugin for pi — KnickKnackLabs fork

[KnickKnackLabs/pi-langfuse](https://github.com/KnickKnackLabs/pi-langfuse) is a
source-only fork of the official
[langfuse/pi-observability-plugin](https://github.com/langfuse/pi-observability-plugin),
originally authored by Langfuse. The package is marked private to prevent npm
publication; its retained `@langfuse/pi-observability-plugin` name identifies the
upstream package, not a fork-owned npm release.

Concurrent embedded-session isolation is not fixed yet. The setup below describes
the inherited CLI behavior, not a supported concurrent embedding API.

This extension sends [pi coding agent](https://pi.dev) sessions to
[Langfuse](https://langfuse.com). It records the user prompts, the agent turns,
the model generations with their tokens and cost, and the tool calls.

The upstream setup guide is the
[Pi Agent integration page](https://langfuse.com/integrations/developer-tools/pi-agent),
which also covers troubleshooting. Its npm installation instructions install
upstream, not this fork.

> [!WARNING]
> This is an experimental release, so future versions can bring breaking changes.

## What can this integration trace?

The plugin listens to Pi's core lifecycle events and sends every user prompt to
Langfuse as its own trace:

- **Agent turns**: one trace per user prompt, with all turns of a Pi session
  grouped under one session ID. Turn numbering survives a Pi restart.
- **Model generations**: every model request with inputs, outputs, cost, time to
  first token, and token usage including cache-read and reasoning splits.
- **Conversation history**: each generation has all messages of that call.
- **Reasoning**: each thinking block is on the step that made it.
- **Tool calls**: each tool Pi invokes, with input, output, and an `ERROR` level
  when the call fails.
- **Images**: images you add to a prompt are uploaded as Langfuse media and
  render inside the trace.
- **Subagents**: Pi processes spawned by other extensions nest under the turn
  that started them.

## Prerequisites

Pi needs Node.js 22.0.0 or newer, and pi's package installer shells out to
`npm`, so npm has to be on your `PATH`.

## Install

Use a local checkout of this fork with dependencies installed (see
[Development](#development)):

```bash
pi install /absolute/path/to/pi-langfuse
```

To try that checkout for a single run, without installing:

```bash
pi -e /absolute/path/to/pi-langfuse/src/index.ts
```

## Add your Langfuse credentials

Create a credentials file at `~/.pi/agent/langfuse.json`:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://cloud.langfuse.com",
  "userId": "your-user-id",
  "environment": "development"
}
```

Only `publicKey` and `secretKey` are required. If `baseUrl` is omitted, the
plugin uses `https://cloud.langfuse.com` (EU region). `userId`, `environment`
and `release` are optional labels that let you segment traces by teammate, stage
or version. Keep the file private, because it holds a secret key.

Alternatively, set your credentials with environment variables:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"
export LANGFUSE_TRACING_ENVIRONMENT="development"
export LANGFUSE_USER_ID="your-user-id"
```

Environment variables take precedence over the config file, so you can override
a single value without editing the file.

## Environment variables

| Variable                       | Description                                                                                                                                       | Required            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `LANGFUSE_PUBLIC_KEY`          | Your Langfuse public key (`pk-lf-...`)                                                                                                            | Yes                 |
| `LANGFUSE_SECRET_KEY`          | Your Langfuse secret key (`sk-lf-...`)                                                                                                            | Yes                 |
| `LANGFUSE_BASE_URL`            | Langfuse host. EU: `https://cloud.langfuse.com`, US: `https://us.cloud.langfuse.com`, Japan: `https://jp.cloud.langfuse.com`, HIPAA: `https://hipaa.cloud.langfuse.com` | No (defaults to EU) |
| `LANGFUSE_TRACING_ENVIRONMENT` | Environment label for the traces (e.g. `production`)                                                                                              | No                  |
| `LANGFUSE_USER_ID`             | User ID attached to all traces                                                                                                                    | No                  |
| `OTEL_SERVICE_NAME`            | OpenTelemetry service name for the exported spans. Unset, OpenTelemetry's own default applies                                                     | No                  |
| `OTEL_RESOURCE_ATTRIBUTES`     | Extra OpenTelemetry resource attributes as a comma-separated `key=value` list (e.g. `service.namespace=engineering,team.name=platform`). Langfuse shows them under `resourceAttributes` in the trace and observation metadata | No                  |

## Enable and disable tracing

| Scope                   | How                                                         |
| ----------------------- | ----------------------------------------------------------- |
| One run                 | `LANGFUSE_TRACING_ENABLED=false pi`                         |
| The current shell       | `export LANGFUSE_TRACING_ENABLED=false` (undo with `unset`) |
| Global or project scope | `pi config`, then switch the extension off                  |
| Remove the plugin       | `pi remove /absolute/path/to/pi-langfuse`                  |

The kill switch has priority over environment keys and the config file. When
tracing is off, the status line shows `langfuse: off (no keys)` and nothing is
sent. This message reads the same whether the kill switch is set or the keys are
genuinely missing. To remove stored keys, delete `~/.pi/agent/langfuse.json`.

`pi remove` needs the same source you installed from. For a local checkout, see
[Development](#development).

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
```

The package ships raw TypeScript and pi reads `src/index.ts` directly, so there
is no build step. Therefore `files` in `package.json` holds only `src`,
`README.md` and `LICENSE`.

To run a local checkout against pi:

```bash
pi install /absolute/path/to/pi-langfuse
```

Remove it again with `pi remove /absolute/path/to/pi-langfuse`.

## Fork distribution

This fork is currently used from source. The inherited npm publishing workflow
has been removed, and `private: true` prevents npm publication of this checkout.
Any future fork-owned package name or release process needs a separate decision;
this repository does not publish the upstream Langfuse package.

## License

[MIT](./LICENSE)
