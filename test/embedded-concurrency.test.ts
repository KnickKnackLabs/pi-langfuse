import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { it } from "node:test";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createEmbeddedLangfuse } from "../src/embedded.ts";
import { type CapturedSpan, createSandbox, startCaptureServer } from "./helpers.ts";

// Use the schema library belonging to the SDK under test, not a second version.
const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { Type } = await import(sdkRequire.resolve("typebox"));
const addition = defineTool({
  name: "add_numbers",
  label: "Add numbers",
  description: "Add two numbers.",
  parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
  async execute(_id, params) {
    assert.ok(params && typeof params === "object" && "a" in params && "b" in params);
    const { a, b } = params;
    assert.ok(typeof a === "number" && typeof b === "number");
    return { content: [{ type: "text", text: String(a + b) }], details: {} };
  },
});

interface AdditionRequest {
  a: number;
  b: number;
  response: http.ServerResponse;
  isFinal: boolean;
  toolOutput?: unknown;
}

/** Each first request waits until all sessions have an open generation. */
async function startAdditionProvider(groupSize: number) {
  const waiting: AdditionRequest[] = [];
  let heldFinal: AdditionRequest | undefined;
  let signalHeld!: () => void;
  const finalHeld = new Promise<void>((resolve) => { signalHeld = resolve; });
  const requests: AdditionRequest[] = [];

  function reply(request: AdditionRequest) {
    const { response, a, b, isFinal } = request;
    const base = { id: "neutral-addition", object: "chat.completion.chunk", created: 1, model: "mock-gpt-1" };
    const send = (choices: unknown[], usage?: unknown) => {
      response.write(`data: ${JSON.stringify({ ...base, choices, ...(usage ? { usage } : {}) })}\n\n`);
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    send([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
    const delta = isFinal
      ? { content: `Sum ${a}+${b}=${a + b}` }
      : { tool_calls: [{
          index: 0,
          id: "shared-call-id",
          type: "function",
          function: { name: "add_numbers", arguments: JSON.stringify({ a, b }) },
        }] };
    send([{ index: 0, delta, finish_reason: null }]);
    send([{ index: 0, delta: {}, finish_reason: isFinal ? "stop" : "tool_calls" }]);
    send([], { prompt_tokens: a, completion_tokens: b, total_tokens: a + b });
    response.end("data: [DONE]\n\n");
  }

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      const messages = payload.messages as Array<{ role: string; content: unknown }>;
      const userIndex = messages.map((message) => message.role).lastIndexOf("user");
      const prompt = JSON.stringify(messages[userIndex]?.content);
      const numbers = /Add (\d+) and (\d+)/.exec(prompt);
      if (!numbers) {
        res.writeHead(400);
        res.end("Unexpected neutral prompt");
        return;
      }
      const request: AdditionRequest = {
        a: Number(numbers[1]),
        b: Number(numbers[2]),
        response: res,
        isFinal: messages.slice(userIndex + 1).some((message) => message.role === "tool"),
        toolOutput: messages.filter((message) => message.role === "tool").at(-1)?.content,
      };
      requests.push(request);
      if (request.isFinal && request.a === 101) {
        heldFinal = request;
        signalHeld();
      } else if (request.isFinal) {
        reply(request);
      } else {
        waiting.push(request);
        if (waiting.length === groupSize) {
          for (const pending of waiting.splice(0)) reply(pending);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as { port: number }).port,
    requests,
    finalHeld,
    releaseFinal() {
      assert.ok(heldFinal);
      reply(heldFinal);
      heldFinal = undefined;
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

function observation(span: CapturedSpan) {
  const parse = (key: string) => {
    const value = span.attrs[`langfuse.observation.${key}`];
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  };
  return { input: parse("input"), output: parse("output") };
}

function assertTracedTurns(owned: CapturedSpan[], index: number) {
  const roots = owned.filter((span) => span.name === "Conversational Turn");
  assert.equal(roots.length, 2);
  assert.equal(new Set(roots.map((root) => root.traceId)).size, 2);

  for (const [turn, root] of roots.entries()) {
    const a = index * 100 + (turn === 0 ? 1 : 11);
    const b = a + 1;
    assert.deepEqual(observation(root), {
      input: { role: "user", content: `Add ${a} and ${b}.` },
      output: { role: "assistant", content: `Sum ${a}+${b}=${a + b}` },
    });
    assert.equal(Number(root.attrs["langfuse.observation.metadata.turn_number"]), turn + 1);
    assert.equal(root.attrs["langfuse.observation.metadata.cancelled"], undefined);
    assert.notEqual(root.attrs["langfuse.observation.level"], "ERROR");

    const children = owned.filter((span) => span.parentSpanId === root.spanId);
    assert.equal(children.length, 3);
    for (const child of children) assert.equal(child.traceId, root.traceId);
    const tool = children.find((span) => span.name === "Tool: add_numbers");
    assert.ok(tool);
    assert.deepEqual(observation(tool), { input: { a, b }, output: a + b });

    const generations = children.filter((span) => span.name === "LLM Call");
    assert.equal(generations.length, 2);
    for (const generation of generations) {
      const input = observation(generation).input as Array<{ role: string; content?: string }>;
      assert.ok(input.some((message) => message.role === "user" && message.content === `Add ${a} and ${b}.`));
      const ownPrompts = [
        `Add ${index * 100 + 1} and ${index * 100 + 2}.`,
        `Add ${index * 100 + 11} and ${index * 100 + 12}.`,
      ];
      for (const message of input.filter((message) => message.role === "user")) {
        assert.ok(ownPrompts.includes(String(message.content)), "history must contain only this session's prompts");
      }

      const usage = JSON.parse(String(generation.attrs["langfuse.observation.usage_details"]));
      assert.equal(usage.input, a);
      assert.equal(usage.output, b);
      assert.notEqual(generation.attrs["langfuse.observation.level"], "WARNING");
      const output = observation(generation).output;
      if (output.tool_calls) {
        assert.equal(output.tool_calls[0].function.name, "add_numbers");
      } else {
        assert.deepEqual(output, { role: "assistant", content: `Sum ${a}+${b}=${a + b}` });
      }
    }
  }
}

it("isolates overlapping SDK sessions in one plugin and traces only the selected three of six", { timeout: 20000 }, async () => {
  const provider = await startAdditionProvider(6);
  const capture = await startCaptureServer();
  const sandbox = createSandbox(provider.port);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const tracing = createEmbeddedLangfuse({
    endpoint: `http://127.0.0.1:${capture.port}`,
    publicKey: "neutral-concurrency-public",
    secretKey: "neutral-concurrency-secret",
  });
  const sessions: AgentSession[] = [];
  const runs: Promise<void>[] = [];
  let registrations = 0;

  const resources = (traced: boolean) => new DefaultResourceLoader({
    cwd: sandbox.workspace,
    agentDir: sandbox.agentDir,
    settingsManager: settings,
    extensionFactories: traced ? [(pi) => {
      registrations += 1;
      tracing.extension(pi);
    }] : [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

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
    const tracedLoader = resources(true);
    const untracedLoader = resources(false);
    await tracedLoader.reload();
    await untracedLoader.reload();
    assert.deepEqual(tracedLoader.getExtensions().errors, []);
    assert.deepEqual(untracedLoader.getExtensions().errors, []);

    for (let index = 0; index < 6; index += 1) {
      const { session } = await createAgentSession({
        cwd: sandbox.workspace,
        agentDir: sandbox.agentDir,
        modelRuntime,
        model,
        thinkingLevel: "off",
        resourceLoader: index < 3 ? tracedLoader : untracedLoader,
        sessionManager: SessionManager.inMemory(sandbox.workspace),
        settingsManager: settings,
        tools: ["add_numbers"],
        customTools: [addition],
      });
      sessions.push(session);
    }
    assert.equal(registrations, 1, "all three traced sessions share one registration");
    assert.equal(new Set(sessions.map((session) => session.sessionManager.getSessionId())).size, 6);

    // B stays inside its final generation while A shuts down its tracing state.
    for (const [index, session] of sessions.entries()) {
      const a = index * 100 + 1;
      runs.push(session.prompt(`Add ${a} and ${a + 1}.`));
    }
    await provider.finalHeld;
    await runs[0];
    const first = sessions[0];
    assert.ok(first);
    await first.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    // An idle summary in A must not become a child of B's still-open prompt.
    await first.extensionRunner.emit({
      type: "session_tree",
      newLeafId: null,
      oldLeafId: null,
      summaryEntry: {
        type: "branch_summary",
        id: "neutral-summary",
        parentId: null,
        timestamp: new Date().toISOString(),
        fromId: "neutral-branch",
        summary: "A's neutral branch summary.",
      },
    });
    provider.releaseFinal();
    await Promise.all(runs);

    // Shutdown removed A's state, not the shared runtime. Every session can run again.
    await Promise.all(sessions.map((session, index) => {
      const a = index * 100 + 11;
      return session.prompt(`Add ${a} and ${a + 1}.`);
    }));
    await tracing.dispose();

    const spans = capture.spans();
    assert.equal(provider.requests.length, 24);
    for (const request of provider.requests.filter((request) => request.isFinal)) {
      assert.equal(request.toolOutput, String(request.a + request.b));
    }
    assert.equal(spans.length, 25, "24 turn observations plus A's idle summary");
    const summary = spans.find((span) => span.name === "Branch Summary");
    assert.ok(summary);
    assert.equal(summary.attrs["session.id"], first.sessionManager.getSessionId());
    assert.equal(summary.parentSpanId, undefined);
    assert.deepEqual(observation(summary).output, { role: "assistant", content: "A's neutral branch summary." });

    const firstRoots = spans.filter((span) => span.name === "Conversational Turn" &&
      Number(span.attrs["langfuse.observation.metadata.turn_number"]) === 1);
    assert.equal(firstRoots.length, 3);
    const lastStart = firstRoots.reduce((latest, root) => root.startNs > latest ? root.startNs : latest, 0n);
    for (const root of firstRoots) assert.ok(root.endNs > lastStart, "all traced roots really overlapped");
    const tracedIds = sessions.slice(0, 3).map((session) => session.sessionManager.getSessionId());
    assert.deepEqual(new Set(spans.map((span) => span.attrs["session.id"])), new Set(tracedIds));

    for (const [index, session] of sessions.entries()) {
      const id = session.sessionManager.getSessionId();
      const owned = spans.filter((span) => span.attrs["session.id"] === id);
      if (index < 3) assertTracedTurns(owned, index);
      else assert.deepEqual(owned, []);

      const lastMessage = session.messages.at(-1);
      assert.ok(lastMessage && lastMessage.role === "assistant");
      const finalText = lastMessage.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      const a = index * 100 + 11;
      assert.equal(finalText, `Sum ${a}+${a + 1}=${a + a + 1}`);
    }
  } finally {
    provider.close();
    await Promise.allSettled(runs);
    for (const session of sessions) session.dispose();
    await tracing.dispose();
    capture.close();
    rmSync(sandbox.agentDir, { recursive: true, force: true });
    rmSync(sandbox.workspace, { recursive: true, force: true });
  }
});
