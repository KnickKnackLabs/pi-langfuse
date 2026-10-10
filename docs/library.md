# Library configuration and lifecycle

Import `createEmbeddedLangfuse` from this checkout's `src/embedded.ts`
(package entry `./embedded`). The upstream npm release does not contain this
fork's library entry. The supported SDK is
`@earendil-works/pi-coding-agent` 1.1.0; older versions are not validated.

## Configuration

The endpoint and both keys are required. The factory reads only the supplied
configuration, without CLI-file, environment-key or cloud fallback.
Use an HTTP(S) base URL, including any deployment path prefix, without URL
credentials, query strings or fragments.

```typescript
const tracing = createEmbeddedLangfuse({
  endpoint: config.langfuseUrl,
  publicKey: config.langfusePublicKey,
  secretKey: config.langfuseSecretKey,
  labels: { userId: "developer", environment: "development", release: "local" },
  onExportIssue: ({ code }) => console.error("Tracing:", code),
});
```

Labels are optional. Absent `userId` stays absent; absent environment and release
are empty strings. Partial or invalid configuration throws a fixed error message.

## Ownership

One handle owns one local provider. Pass its extension to a resource loader and
share that loader among the sessions you want traced. Each session's prompt,
generation, tools, history and summary timing are keyed by its Pi session ID.
Give every independent session its own `SessionManager`. Sessions can overlap;
prompts within one session remain sequential, as required by Pi.

To trace three of six sessions, create two loaders: one with
`extensionFactories: [tracing.extension]`, the other without that extension.
Load each once, then pass the appropriate loader to each `createAgentSession`.
Stateless tools and model configuration can be shared by all six sessions.

Session shutdown finalizes and drops only that session's tracing state, leaving
the provider and other sessions available. After the sessions finish,
call `await tracing.dispose()`. Disposal closes outstanding observations and
attempts exporter shutdown. It is idempotent and permanent; subsequent loading
or work through the handle fails.

The provider does not install a process-global provider or context manager.
Library tracing disables media uploads and CLI child-process parent propagation.

## Export and diagnostics

Flush or disposal completion does not confirm storage in Langfuse. Export
failures reaching the flush/shutdown boundary report `flush-failed` or
`shutdown-failed`, once per code per handle. The optional callback receives only
`{ code }`; without a callback, the code is printed to stderr. Callback exceptions
are contained.

Keep dependency DEBUG logging off in production. Langfuse's `LANGFUSE_DEBUG` /
`LANGFUSE_LOG_LEVEL` and OpenTelemetry diagnostic logging can print configuration
and conversation/tool contents. The plugin's own diagnostics are metadata-only;
it does not sanitize dependency logs or change host logging settings.

## Ambient transport settings

Clear `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS` in your
deployment before construction. Nonempty values cause the factory to fail because
the locked exporter merges them into explicit request headers. The exporter
captures headers at construction; later environment changes do not alter that
handle. The plugin does not clear the variables itself.

The exporter still reads ambient TLS certificate settings. Redirects, response
handling and cancellation follow the dependency's behavior. This entry does not
provide stricter transport or ingestion guarantees.
