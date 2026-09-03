import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

const cdpState = vi.hoisted(() => ({
  entries: [] as Array<Record<string, unknown>>,
  enableNetworkTracking: vi.fn(),
  disableNetworkTracking: vi.fn(),
  drainNetworkEvents: vi.fn(),
  getNetworkEntries: vi.fn(() => cdpState.entries),
}));

vi.mock("../../../src/cdp/controller", () => ({
  CDPController: class {
    enableNetworkTracking = cdpState.enableNetworkTracking;
    disableNetworkTracking = cdpState.disableNetworkTracking;
    drainNetworkEvents = cdpState.drainNetworkEvents;
    getNetworkEntries = cdpState.getNetworkEntries;
  },
}));

vi.mock("../../../src/native/port-manager", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: vi.fn(),
}));

async function loadHandleMessage() {
  vi.resetModules();
  (globalThis as any).chrome = createChromeMock();
  const mod = await import("../../../src/service-worker/index");
  return mod.handleMessage;
}

describe("network export handlers", () => {
  beforeEach(() => {
    resetChromeMock();
    cdpState.entries = [];
    cdpState.enableNetworkTracking.mockReset();
    cdpState.disableNetworkTracking.mockReset();
    cdpState.drainNetworkEvents.mockReset();
    cdpState.getNetworkEntries.mockClear();
  });

  it("uses bounded summaries even when legacy callers omit full", async () => {
    const handleMessage = await loadHandleMessage();
    cdpState.entries = [
      {
        id: "r-legacy",
        ts: 1,
        method: "POST",
        url: "https://example.test/api?future_secret=value",
        origin: "https://example.test",
        requestHeaders: { Authorization: "Bearer secret" },
        requestBody: "private request",
        responseHeaders: { "set-cookie": "private=response" },
        responseBody: "private response",
        responseBodySize: 16,
        bodyCapture: { mode: "text", complete: true, capturedBytes: 16 },
        tabId: 42,
        type: "XHR",
        status: 200,
        flags: [],
        _requestId: "cdp-legacy",
        _responseReceived: true,
        _loadingFinished: true,
      },
    ];

    const result = await handleMessage({ type: "READ_NETWORK_REQUESTS", tabId: 42, limit: 10 }, {});
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ totalEntries: 1, returnedEntries: 1, truncated: false });
    expect(serialized).toContain("https://example.test/<redacted-path>?<redacted-query>");
    expect(serialized).not.toContain("future_secret");
    for (const forbidden of [
      "Bearer secret",
      "private request",
      "private response",
      "requestHeaders",
      "responseHeaders",
      "requestBody",
      '"responseBody"',
      "cdp-legacy",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(32 * 1024);
  });

  it("returns bounded redacted summaries for network listings", async () => {
    const handleMessage = await loadHandleMessage();
    cdpState.entries = [
      {
        id: "r1",
        ts: 1,
        method: "GET",
        url: "https://example.test/api?id_token=secret",
        origin: "https://example.test",
        requestHeaders: { Authorization: "Bearer secret" },
        responseBody: "x".repeat(100_000),
        responseBodySize: 100_000,
        bodyCapture: { mode: "text", complete: true, capturedBytes: 100_000 },
        tabId: 42,
        type: "XHR",
        status: 0,
        flags: ["failed"],
        failureReason: "net::ERR_FAILED",
        _requestId: "cdp-r1",
        _responseReceived: false,
        _loadingFinished: true,
      },
    ];

    const result = await handleMessage(
      {
        type: "READ_NETWORK_REQUESTS",
        tabId: 42,
        full: true,
        origin: "https://example.test",
        limit: 10,
        format: "raw",
      },
      {},
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain('"responseBody"');
    expect(result).toMatchObject({
      totalEntries: 1,
      returnedEntries: 1,
      truncated: false,
      format: "raw",
      entries: [{ status: 0, failureReason: "net::ERR_FAILED" }],
    });
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(32 * 1024);
  });

  it("rejects unbounded format metadata before building the response envelope", async () => {
    const handleMessage = await loadHandleMessage();
    await expect(
      handleMessage(
        { type: "READ_NETWORK_REQUESTS", tabId: 42, full: true, format: "x".repeat(4_096) },
        {},
      ),
    ).rejects.toThrow("network format must be compact, urls, curl, raw, or verbose");
  });

  it("bounds the complete listing envelope before native transport", async () => {
    const handleMessage = await loadHandleMessage();
    cdpState.entries = Array.from({ length: 100 }, (_, index) => ({
      id: `r${index}`,
      ts: index,
      method: "GET",
      url: `https://example.test/${"x".repeat(4_000)}?signature=secret-${index}`,
      origin: "https://example.test",
      requestHeaders: { Authorization: `Bearer secret-${index}` },
      responseBody: "y".repeat(100_000),
      bodyCapture: { mode: "text", complete: true, capturedBytes: 100_000 },
      tabId: 42,
      type: "XHR",
      status: 200,
      flags: ["failed"],
      failureReason: `net::${"x".repeat(512)}-${index}`,
      _requestId: `cdp-r${index}`,
      _responseReceived: true,
      _loadingFinished: true,
    }));

    const result = await handleMessage(
      { type: "READ_NETWORK_REQUESTS", tabId: 42, full: true, limit: 100, format: "raw" },
      {},
    );
    const serialized = JSON.stringify(result);

    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(32 * 1024);
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("signature=secret");
    expect(result).toMatchObject({ totalEntries: 100, truncated: true });
    expect(result.returnedEntries).toBeLessThan(100);
    expect(result.entries.at(-1)?.id).toBe("r99");
  });

  it("reports 150 filtered matches separately from a 100-item limit", async () => {
    const handleMessage = await loadHandleMessage();
    cdpState.entries = Array.from({ length: 150 }, (_, index) => ({
      id: `r${index}`,
      ts: index,
      method: "GET",
      url: `https://example.test/${index}`,
      origin: "https://example.test",
      requestHeaders: {},
      bodyCapture: { mode: "none", complete: false, reason: "disabled" },
      tabId: 42,
      type: "XHR",
      status: 200,
      flags: [],
      _requestId: `cdp-r${index}`,
      _responseReceived: true,
      _loadingFinished: true,
    }));

    const result = await handleMessage(
      { type: "READ_NETWORK_REQUESTS", tabId: 42, full: true, limit: 100 },
      {},
    );

    expect(result).toMatchObject({ totalEntries: 150, returnedEntries: 100, truncated: true });
    expect(result.entries[0]?.id).toBe("r50");
    expect(result.entries.at(-1)?.id).toBe("r149");
  });

  it("reports filtered total separately from count and byte truncation", async () => {
    const handleMessage = await loadHandleMessage();
    const makeEntry = (id: string, origin: string, status: number) => ({
      id,
      ts: Number(id.slice(1)),
      method: "GET",
      url: `${origin}/${id}`,
      origin,
      requestHeaders: {},
      bodyCapture: { mode: "none", complete: false, reason: "disabled" },
      tabId: 42,
      type: "XHR",
      status,
      flags: status === 0 ? ["failed"] : [],
      failureReason: status === 0 ? "net::ERR_FAILED" : undefined,
      _requestId: `cdp-${id}`,
      _responseReceived: status !== 0,
      _loadingFinished: true,
    });
    cdpState.entries = [
      makeEntry("r1", "https://api.github.com", 200),
      makeEntry("r2", "https://api.github.com", 0),
      makeEntry("r3", "https://other.example", 200),
    ];

    const result = await handleMessage(
      {
        type: "READ_NETWORK_REQUESTS",
        tabId: 42,
        full: true,
        origin: "api.github.com",
        status: ["2xx", "failed"],
        limit: 1,
      },
      {},
    );

    expect(result).toMatchObject({
      totalEntries: 2,
      returnedEntries: 1,
      truncated: true,
      entries: [{ id: "r2", status: 0 }],
    });
  });

  it("returns captured entries and format flags", async () => {
    const handleMessage = await loadHandleMessage();
    cdpState.entries = [{ id: "r1", url: "https://example.test" }];
    const result = await handleMessage(
      { type: "EXPORT_NETWORK_REQUESTS", tabId: 42, har: true },
      {},
    );
    expect(result).toEqual({ entries: cdpState.entries, har: true, jsonl: false });
    expect(cdpState.enableNetworkTracking).toHaveBeenCalledWith(42);
    expect(cdpState.drainNetworkEvents).toHaveBeenCalledWith(42);
    expect(cdpState.getNetworkEntries).toHaveBeenCalledWith(42, {});
  });

  it("stops explicit network capture", async () => {
    const handleMessage = await loadHandleMessage();
    await expect(handleMessage({ type: "STOP_NETWORK_CAPTURE", tabId: 42 }, {})).resolves.toEqual({
      success: true,
    });
    expect(cdpState.disableNetworkTracking).toHaveBeenCalledWith(42);
  });

  it("rejects entries exceeding the native-message source cap", async () => {
    const handleMessage = await loadHandleMessage();
    cdpState.entries = [{ body: "x".repeat(17 * 1024 * 1024) }];
    await expect(handleMessage({ type: "EXPORT_NETWORK_REQUESTS", tabId: 42 }, {})).rejects.toThrow(
      /16 MiB native-message limit/,
    );
  });
});
