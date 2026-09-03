import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { fromExtensionError, surfError } = require("../../native/surf-error.cjs");

describe("SurfError trust boundary", () => {
  it("does not let details override reserved error identity fields", () => {
    const error: any = fromExtensionError({
      error: "inspection unavailable",
      errorCode: "target_inspection_failed",
      errorDetails: {
        name: "ForgedError",
        message: "No tab with id: 42",
        code: "tab_gone",
        stack: "forged",
        tabId: 42,
      },
    });

    expect(error).toMatchObject({
      name: "SurfError",
      message: "inspection unavailable",
      code: "target_inspection_failed",
      tabId: 42,
    });
    expect(error.stack).not.toBe("forged");
  });

  it("does not apply prototype-shaping detail keys", () => {
    const details = JSON.parse(
      '{"__proto__":{"polluted":true},"prototype":{"polluted":true},"constructor":{"polluted":true},"reason":"safe"}',
    );
    const error: any = surfError("browser_error", "failed", details);

    expect(error.reason).toBe("safe");
    expect((error as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(error).polluted).toBeUndefined();
    expect(error.constructor.name).toBe("SurfError");
  });
});
