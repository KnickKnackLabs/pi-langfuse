import assert from "node:assert/strict";
import { it } from "node:test";
import { describeExportFailure } from "../src/export-failure.ts";

it("keeps only a valid HTTP status, never response bodies or headers", () => {
  const result = describeExportFailure({
    code: 401, message: "private-message", data: "private-body", headers: { key: "private-key" },
  }, false);
  assert.deepEqual(result, { reason: "http", httpStatus: 401 });
  assert.ok(Object.isFrozen(result));
});

it("reports the owned deadline without forwarding its error", () => {
  assert.deepEqual(describeExportFailure(new Error("private-error"), true), { reason: "timeout" });
});

it("allows only known connection codes", () => {
  assert.deepEqual(describeExportFailure({ code: "ECONNREFUSED", message: "private-host" }, false), {
    reason: "connection", connectionCode: "ECONNREFUSED",
  });
  for (const code of ["private-value", 200, 600, 401.5]) {
    assert.deepEqual(describeExportFailure({ code }, false), { reason: "unknown" });
  }
});
