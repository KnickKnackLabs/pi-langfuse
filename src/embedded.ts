import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerTracing } from "./index.ts";
import {
  createOwnedRuntime,
  validateEmbeddedOptions,
  type EmbeddedLangfuseOptions,
} from "./embedded-runtime.ts";

export type { EmbeddedLangfuseOptions, ExportIssueCode, ExportIssue } from "./embedded-runtime.ts";
export type { ExportFailure } from "./export-failure.ts";

export interface EmbeddedLangfuse {
  extension: ExtensionFactory;
  dispose(): Promise<void>;
}

export function createEmbeddedLangfuse(options: EmbeddedLangfuseOptions): EmbeddedLangfuse {
  const config = validateEmbeddedOptions(options);
  const runtime = createOwnedRuntime(config, options.onExportIssue);
  const finalizePrompts = new Set<() => void>();
  let disposePromise: Promise<void> | undefined;

  return {
    extension(pi) {
      if (runtime.shutdown) throw new Error("Langfuse runtime is disposed");
      finalizePrompts.add(registerTracing(pi, config, runtime));
    },
    dispose() {
      if (disposePromise) return disposePromise;

      for (const finalizePrompt of finalizePrompts) finalizePrompt();
      finalizePrompts.clear();

      disposePromise = runtime.dispose();
      return disposePromise;
    },
  };
}
