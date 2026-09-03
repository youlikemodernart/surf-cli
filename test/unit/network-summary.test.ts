import { describe, expect, it } from "vitest";
import {
  matchesNetworkOrigin,
  matchesNetworkStatus,
  redactNetworkUrl,
  summarizeNetworkEntries,
} from "../../src/cdp/network-summary";

const baseEntry = {
  id: "r_1",
  ts: 1,
  method: "GET",
  url: "https://teams.example.test/admin?shop=demo&id_token=secret-token&session=secret-session",
  origin: "https://teams.example.test",
  requestHeaders: {
    Authorization: "Bearer secret-token",
    Cookie: "session=secret-session",
    Accept: "application/json",
  },
  requestBody: "x".repeat(200_000),
  requestBodySize: 200_000,
  responseHeaders: { "content-type": "application/json", "set-cookie": "secret=1" },
  responseBody: "y".repeat(500_000),
  responseBodySize: 500_000,
  status: 200,
  mimeType: "application/json",
  bodyCapture: { mode: "text" as const, complete: true, capturedBytes: 500_000 },
  tabId: 7,
  tabUrl: "https://admin.example.test/?token=outer-secret",
  type: "XHR",
  flags: [],
  _requestId: "cdp-1",
  _responseReceived: true,
  _loadingFinished: true,
};

describe("summarizeNetworkEntries", () => {
  it("redacts URL secrets and omits headers and bodies", () => {
    const result = summarizeNetworkEntries([baseEntry]);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("secret-session");
    expect(serialized).not.toContain("Authorization");
    expect(result.entries[0]).not.toHaveProperty("requestHeaders");
    expect(result.entries[0]).not.toHaveProperty("responseHeaders");
    expect(result.entries[0]).not.toHaveProperty("requestBody");
    expect(result.entries[0]).not.toHaveProperty("responseBody");
    expect(result.entries[0]).toHaveProperty("responseBodySize", 500_000);
    expect(result.entries[0].url).toBe(
      "https://teams.example.test/<redacted-path>?<redacted-query>",
    );
  });

  it("fails closed for userinfo, signed parameters, fragments, and invalid URLs", () => {
    const suppliedSecrets = [
      "user",
      "password",
      "signed-value",
      "unknown-value",
      "encoded secret",
      "unicode-秘密",
      "fragment-secret",
    ];
    const redacted = redactNetworkUrl(
      "https://user:password@example.test/path?hmac=signed-value&x=unknown-value&x=encoded%20secret&empty=&unicode=unicode-%E7%A7%98%E5%AF%86#fragment-secret",
    );
    for (const secret of suppliedSecrets) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toBe(
      "https://example.test/<redacted-path>?<redacted-query>#<redacted-fragment>",
    );
    expect(redactNetworkUrl("not a valid absolute URL?token=secret")).toBe(
      "<redacted-invalid-url>",
    );
  });

  it("redacts secrets in path segments and flag-style query names", () => {
    const secrets = ["reset-token-value", "oauth-code-value", "SECRET_VALUE"];
    const urls = [
      "https://example.test/reset/reset-token-value",
      "https://example.test/oauth/callback/oauth-code-value",
      "https://example.test/?SECRET_VALUE",
    ];
    for (const url of urls) {
      const redacted = redactNetworkUrl(url);
      for (const secret of secrets) {
        expect(redacted).not.toContain(secret);
      }
    }
    expect(redactNetworkUrl("data:text/plain,private-value")).toBe("<redacted-url>");
  });

  it("matches host-only and exact scheme origins without accepting paths or userinfo", () => {
    expect(matchesNetworkOrigin("https://api.github.com", "api.github.com")).toBe(true);
    expect(matchesNetworkOrigin("http://api.github.com", "api.github.com")).toBe(true);
    expect(matchesNetworkOrigin("https://api.github.com", "https://api.github.com")).toBe(true);
    expect(matchesNetworkOrigin("http://api.github.com", "https://api.github.com")).toBe(false);
    expect(matchesNetworkOrigin("https://api.github.com", "https://api.github.com/")).toBe(true);
    expect(matchesNetworkOrigin("https://api.github.com:443", "https://API.GITHUB.COM")).toBe(true);
    expect(matchesNetworkOrigin("https://api.github.com:8443", "api.github.com:8443")).toBe(true);
    expect(matchesNetworkOrigin("https://api.github.com:8443", "api.github.com")).toBe(false);
    expect(matchesNetworkOrigin("https://[::1]:8443", "[::1]:8443")).toBe(true);
    expect(matchesNetworkOrigin("https://api.github.com", "api.github.com/path")).toBe(false);
    expect(matchesNetworkOrigin("https://api.github.com", "user@api.github.com")).toBe(false);
    expect(matchesNetworkOrigin("https://api.github.com.evil.test", "api.github.com")).toBe(false);
    expect(matchesNetworkOrigin("https://evilapi.github.com", "api.github.com")).toBe(false);
  });

  it("normalizes exact, class, failed, comma-separated, and repeated status filters", () => {
    expect(matchesNetworkStatus(200, "200")).toBe(true);
    expect(matchesNetworkStatus(404, "4xx")).toBe(true);
    expect(matchesNetworkStatus(0, "failed")).toBe(true);
    expect(matchesNetworkStatus(503, " 4XX, 5xx ")).toBe(true);
    expect(matchesNetworkStatus(304, "200,304,4xx")).toBe(true);
    expect(matchesNetworkStatus(201, ["404", "2xx"])).toBe(true);
    expect(matchesNetworkStatus(0, "0")).toBe(true);
    expect(matchesNetworkStatus(200, "invalid")).toBe(false);
    expect(matchesNetworkStatus(200, "invalid,2xx")).toBe(true);
    expect(matchesNetworkStatus(200, ", ,")).toBe(false);
  });

  it("preserves a failed request and its reason", () => {
    const result = summarizeNetworkEntries([
      {
        ...baseEntry,
        status: 0,
        flags: ["failed"],
        failureReason: "net::ERR_FAILED",
        canceled: false,
      },
    ]);

    expect(result.entries[0]).toMatchObject({
      status: 0,
      flags: ["failed"],
      failureReason: "net::ERR_FAILED",
      canceled: false,
    });
  });

  it("keeps serialized output within the byte ceiling", () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      ...baseEntry,
      id: `r_${index}`,
      url: `https://teams.example.test/${"z".repeat(4_000)}?token=secret-${index}`,
    }));

    const result = summarizeNetworkEntries(entries, { maxBytes: 8_192, maxEntries: 10 });
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(8_192);
    expect(result.truncated).toBe(true);
    expect(result.totalEntries).toBe(100);
    expect(result.returnedEntries).toBeLessThanOrEqual(10);
    expect(result.entries.at(-1)?.id).toBe("r_99");
  });

  it("enforces item boundaries and count invariants", () => {
    const entries = Array.from({ length: 502 }, (_, index) => ({
      ...baseEntry,
      id: `r_${index}`,
      url: `https://teams.example.test/${index}`,
    }));

    for (const maxEntries of [0, 1, 100, 500]) {
      const result = summarizeNetworkEntries(entries, { maxEntries, maxBytes: 1024 * 1024 });
      expect(result.totalEntries).toBe(502);
      expect(result.returnedEntries).toBe(maxEntries);
      expect(result.entries).toHaveLength(maxEntries);
      expect(result.truncated).toBe(true);
      if (maxEntries > 0) {
        expect(result.entries.at(-1)?.id).toBe("r_501");
      }
    }
    expect(() => summarizeNetworkEntries(entries, { maxEntries: -1 })).toThrow(
      "network summary maxEntries must be a non-negative integer",
    );
    expect(() => summarizeNetworkEntries(entries, { maxEntries: 1.5 })).toThrow(
      "network summary maxEntries must be a non-negative integer",
    );
  });

  it("returns valid bounded UTF-8 for multibyte URLs", () => {
    const result = summarizeNetworkEntries(
      [{ ...baseEntry, url: `https://example.test/${"秘密".repeat(2_000)}` }],
      { maxBytes: 4_096 },
    );
    const serialized = JSON.stringify(result);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(4_096);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it("retains successful and failed examples in one bounded result", () => {
    const result = summarizeNetworkEntries([
      baseEntry,
      {
        ...baseEntry,
        id: "r_2",
        url: "https://teams.example.test/api/fail?api_key=secret",
        status: 0,
        flags: ["failed"],
        failureReason: "net::ERR_CONNECTION_RESET",
      },
    ]);

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.status)).toEqual([200, 0]);
    expect(result.entries[1].failureReason).toBe("net::ERR_CONNECTION_RESET");
  });
});
