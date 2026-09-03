// @ts-expect-error - CommonJS module without type definitions
import * as network from "../../../native/formatters/network.cjs";

describe("network formatters", () => {
  describe("formatSize", () => {
    it("returns dash for undefined/null", () => {
      expect(network.formatSize(undefined)).toBe("-");
      expect(network.formatSize(null)).toBe("-");
    });

    it("formats bytes", () => {
      expect(network.formatSize(0)).toBe("0B");
      expect(network.formatSize(512)).toBe("512B");
      expect(network.formatSize(1023)).toBe("1023B");
    });

    it("formats kilobytes", () => {
      expect(network.formatSize(1024)).toBe("1.0K");
      expect(network.formatSize(1536)).toBe("1.5K");
      expect(network.formatSize(1024 * 100)).toBe("100.0K");
    });

    it("formats megabytes", () => {
      expect(network.formatSize(1024 * 1024)).toBe("1.0M");
      expect(network.formatSize(1024 * 1024 * 2.5)).toBe("2.5M");
    });
  });

  describe("formatDuration", () => {
    it("returns dash for undefined/null", () => {
      expect(network.formatDuration(undefined)).toBe("-");
      expect(network.formatDuration(null)).toBe("-");
    });

    it("formats milliseconds", () => {
      expect(network.formatDuration(0)).toBe("0ms");
      expect(network.formatDuration(500)).toBe("500ms");
      expect(network.formatDuration(999)).toBe("999ms");
    });

    it("formats seconds", () => {
      expect(network.formatDuration(1000)).toBe("1.0s");
      expect(network.formatDuration(1500)).toBe("1.5s");
      expect(network.formatDuration(5000)).toBe("5.0s");
    });
  });

  describe("getContentTypeShort", () => {
    it("returns dash for empty input", () => {
      expect(network.getContentTypeShort(undefined)).toBe("-");
      expect(network.getContentTypeShort(null)).toBe("-");
      expect(network.getContentTypeShort("")).toBe("-");
    });

    it("recognizes common content types", () => {
      expect(network.getContentTypeShort("application/json")).toBe("json");
      expect(network.getContentTypeShort("text/html")).toBe("html");
      expect(network.getContentTypeShort("application/javascript")).toBe("js");
      expect(network.getContentTypeShort("text/css")).toBe("css");
      expect(network.getContentTypeShort("image/png")).toBe("img");
      expect(network.getContentTypeShort("font/woff2")).toBe("font");
      expect(network.getContentTypeShort("application/xml")).toBe("xml");
      expect(network.getContentTypeShort("text/plain")).toBe("text");
    });

    it("handles content types with charset", () => {
      expect(network.getContentTypeShort("application/json; charset=utf-8")).toBe("json");
      expect(network.getContentTypeShort("text/html; charset=utf-8")).toBe("html");
    });
  });

  describe("formatCompact", () => {
    it("returns message for empty entries", () => {
      expect(network.formatCompact([])).toBe("No network requests captured");
      expect(network.formatCompact(null)).toBe("No network requests captured");
      expect(network.formatCompact(undefined)).toBe("No network requests captured");
    });

    it("formats entries as table", () => {
      const entries = [
        {
          requestId: "req-12345678",
          method: "GET",
          status: 200,
          url: "https://example.com/api/test",
          contentType: "application/json",
          responseSize: 1024,
          duration: 150,
        },
      ];

      const output = network.formatCompact(entries);
      expect(output).toContain("req-1234");
      expect(output).toContain("GET");
      expect(output).toContain("200");
      expect(output).toContain("json");
      expect(output).toContain("1.0K");
      expect(output).toContain("150ms");
      expect(output).toContain("https://example.com/api/test");
      expect(output).toContain("Total: 1 requests");
    });

    it("uses summary mimeType and responseBodySize fallbacks", () => {
      const output = network.formatCompact([
        {
          id: "r_summary",
          method: "GET",
          status: 200,
          url: "https://example.test/api",
          mimeType: "application/json",
          responseBodySize: 1536,
        },
      ]);

      expect(output).toContain("json");
      expect(output).toContain("1.5K");
    });

    it("does not throw for fail-closed invalid URL placeholders", () => {
      expect(() =>
        network.formatCompact([
          {
            id: "r_invalid",
            method: "GET",
            status: 0,
            url: "<redacted-invalid-url>",
            origin: "",
            flags: ["failed"],
            failureReason: "net::ERR_INVALID_URL",
          },
        ]),
      ).not.toThrow();
      expect(
        network.formatCompact([
          {
            id: "r_invalid",
            method: "GET",
            status: 0,
            url: "<redacted-invalid-url>",
            origin: "",
            flags: ["failed"],
            failureReason: "net::ERR_INVALID_URL",
          },
        ]),
      ).toContain("<redacted-invalid-url>");
    });

    it("shows failure reasons and honest truncated counts", () => {
      const output = network.formatCompact(
        [
          {
            id: "r_failed",
            method: "GET",
            status: 0,
            type: "XHR",
            url: "https://example.test/api",
            failureReason: "net::ERR_CONNECTION_RESET",
          },
        ],
        { totalEntries: 12, truncated: true },
      );

      expect(output).toContain("FAIL");
      expect(output).toContain("net::ERR_CONNECTION_RESET");
      expect(output).toContain("Showing: 1 of 12 requests");
    });
  });

  describe("formatVerbose", () => {
    it("renders status zero as FAILED with a bounded reason", () => {
      const reason = `net::ERR_FAILED ${"x".repeat(500)}`;
      const output = network.formatVerbose(
        [
          {
            id: "r_failed",
            method: "GET",
            status: 0,
            url: "https://example.test",
            failureReason: reason,
          },
        ],
        1,
      );

      expect(output).toContain("Status: FAILED");
      expect(output).toContain("Failure: net::ERR_FAILED");
      expect(output).not.toContain("Status: pending");
      expect(output).not.toContain(reason);
    });
  });

  describe("formatResultCount", () => {
    it("preserves total, returned, and truncation metadata", () => {
      expect(
        network.formatResultCount([{}], {
          totalEntries: 4,
          returnedEntries: 1,
          truncated: true,
        }),
      ).toBe("Count: total=4, returned=1, truncated=true");
    });
  });

  describe("formatCurl", () => {
    it("returns empty string for empty entry", () => {
      expect(network.formatCurl(null)).toBe("");
      expect(network.formatCurl(undefined)).toBe("");
    });

    it("formats basic GET request", () => {
      const entry = {
        method: "GET",
        url: "https://example.com/api",
      };
      expect(network.formatCurl(entry)).toBe("curl -X GET 'https://example.com/api'");
    });

    it("formats POST with headers and body", () => {
      const entry = {
        method: "POST",
        url: "https://example.com/api",
        requestHeaders: {
          "Content-Type": "application/json",
          Authorization: "Bearer token123",
        },
        requestBody: '{"key":"value"}',
      };

      const curl = network.formatCurl(entry);
      expect(curl).toContain("curl -X POST");
      expect(curl).toContain("-H 'Content-Type: application/json'");
      expect(curl).toContain("-H 'Authorization: Bearer token123'");
      expect(curl).toContain('-d \'{"key":"value"}\'');
    });
  });
});
