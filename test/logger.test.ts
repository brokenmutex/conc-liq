import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { log } from "../src/logger.js";

describe("log", () => {
  it("serializes bigint values without losing precision", () => {
    const write = mock.method(console, "log", () => undefined);
    try {
      log("info", "bigint_test", { value: 79_228_162_514_264_337_593_543_950_336n });
      const line = write.mock.calls[0]?.arguments[0];
      assert.equal(typeof line, "string");
      assert.equal(
        JSON.parse(line as string).value,
        "79228162514264337593543950336",
      );
    } finally {
      write.mock.restore();
    }
  });
});
