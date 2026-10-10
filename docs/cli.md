# CLI configuration

The CLI entry is `src/index.ts`. Its configuration and child-process tracing
retain upstream behavior. Overlapping CLI tracing is not claimed safe.

## Credentials and labels

Create a private `~/.pi/agent/langfuse.json`:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://cloud.langfuse.com",
  "userId": "your-user-id",
  "environment": "development",
  "release": "local"
}
```

Only the keys are required. The default endpoint is Langfuse's EU cloud.
`userId`, `environment` and `release` are optional labels.
Environment variables override the corresponding file values:

| Variable | Purpose |
| --- | --- |
| `LANGFUSE_PUBLIC_KEY` | Public key |
| `LANGFUSE_SECRET_KEY` | Secret key |
| `LANGFUSE_BASE_URL` | Endpoint; defaults to `https://cloud.langfuse.com` |
| `LANGFUSE_HOST` | Endpoint alias, used when `LANGFUSE_BASE_URL` is absent |
| `LANGFUSE_USER_ID` | User label |
| `LANGFUSE_TRACING_ENVIRONMENT` | Environment label |
| `LANGFUSE_RELEASE` | Release label |
| `OTEL_SERVICE_NAME` | Exported service name; otherwise OTel's default |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra comma-separated `key=value` resource attributes |

Other cloud regions include `https://us.cloud.langfuse.com`,
`https://jp.cloud.langfuse.com` and `https://hipaa.cloud.langfuse.com`.

## What the CLI records

Each user prompt becomes a trace, grouped by session ID. Turn numbering survives
Pi restarts. Model generations include conversation history, thinking blocks,
model parameters, time to first token, token usage and cost. Tool calls record
inputs, outputs and errors. Images are uploaded as Langfuse media. Child Pi
processes spawned by extensions nest under the turn that started them.

## Disable or remove

```bash
# Disable tracing for this run.
LANGFUSE_TRACING_ENABLED=false pi

# Remove the same checkout you installed.
pi remove /absolute/path/to/pi-langfuse
```

For the current shell, export `LANGFUSE_TRACING_ENABLED=false`; undo with
`unset LANGFUSE_TRACING_ENABLED`. To disable the extension in global or project
configuration, use `pi config`.

The kill switch wins over keys in the environment or credentials file.
The status reads `langfuse: off (no keys)` both when disabled and when keys are
missing. Removing the extension does not remove stored keys; delete the
credentials file separately if needed.

## Try the source without installing

After installing the checkout's dependencies:

```bash
pi -e /absolute/path/to/pi-langfuse/src/index.ts
```

This fork ships raw TypeScript and is private to prevent npm publication.
The inherited npm release workflow is removed on this branch; any future
fork-owned release process requires a separate decision.
