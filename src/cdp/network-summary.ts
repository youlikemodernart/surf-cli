import type { NetworkEntry } from "./controller";

const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_URL_BYTES = 2 * 1024;
const MAX_REASON_BYTES = 512;

export interface NetworkSummaryEntry {
  id: string;
  ts: number;
  method: string;
  url: string;
  origin: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseBodySize?: number;
  duration?: number;
  ttfb?: number;
  tabId: number;
  type?: string;
  flags: string[];
  failureReason?: string;
  canceled?: boolean;
  blockedReason?: string;
  corsErrorStatus?: { corsError?: string; failedParameter?: string };
  bodyCapture: NetworkEntry["bodyCapture"];
}

export interface NetworkSummaryResult {
  entries: NetworkSummaryEntry[];
  totalEntries: number;
  returnedEntries: number;
  truncated: boolean;
  maxBytes: number;
}

function truncateUtf8(value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(bytes.slice(0, Math.max(0, maxBytes - 3))) + "...";
}

export function redactNetworkUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "<redacted-url>";

    // Treat every component after the origin as private. Tokens routinely
    // appear in path segments, query names, and fragments, not only values.
    let redacted = parsed.origin;
    if (parsed.pathname !== "/") redacted += "/<redacted-path>";
    else redacted += "/";
    if (parsed.search) redacted += "?<redacted-query>";
    if (parsed.hash) redacted += "#<redacted-fragment>";
    return truncateUtf8(redacted, MAX_URL_BYTES) || "";
  } catch {
    return "<redacted-invalid-url>";
  }
}

export function matchesNetworkOrigin(entryOrigin: string, requestedOrigin: unknown): boolean {
  if (requestedOrigin === undefined || requestedOrigin === null || requestedOrigin === "") return true;
  if (typeof requestedOrigin !== "string") return false;
  const candidate = requestedOrigin.trim();
  if (!candidate) return false;
  try {
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(candidate)) {
      const parsed = new URL(candidate);
      if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
      return new URL(entryOrigin).origin === parsed.origin;
    }
    if (/[/?#@]/.test(candidate)) return false;
    return new URL(entryOrigin).host === new URL(`https://${candidate}`).host;
  } catch {
    return false;
  }
}

export function matchesNetworkStatus(status: number | undefined, requestedStatus: unknown): boolean {
  if (requestedStatus === undefined || requestedStatus === null) return true;
  const values = (Array.isArray(requestedStatus) ? requestedStatus : [requestedStatus])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) return false;
  return values.some((value) => {
    if (value === "failed") return status === 0;
    if (/^[1-5]xx$/.test(value)) return status !== undefined && Math.floor(status / 100) === Number(value[0]);
    if (!/^\d{1,3}$/.test(value)) return false;
    return status === Number(value);
  });
}

function summarizeEntry(entry: NetworkEntry): NetworkSummaryEntry {
  return {
    id: truncateUtf8(entry.id, 128) || "",
    ts: entry.ts,
    method: truncateUtf8(entry.method, 32) || "",
    url: redactNetworkUrl(entry.url),
    origin: truncateUtf8(entry.origin, 512) || "",
    status: entry.status,
    statusText: truncateUtf8(entry.statusText, 128),
    mimeType: truncateUtf8(entry.mimeType, 128),
    responseBodySize: entry.responseBodySize,
    duration: entry.duration,
    ttfb: entry.ttfb,
    tabId: entry.tabId,
    type: truncateUtf8(entry.type, 64),
    flags: entry.flags.slice(0, 16).map((flag) => truncateUtf8(flag, 64) || ""),
    failureReason: truncateUtf8(entry.failureReason, MAX_REASON_BYTES),
    canceled: entry.canceled,
    blockedReason: truncateUtf8(entry.blockedReason, MAX_REASON_BYTES),
    corsErrorStatus: entry.corsErrorStatus && typeof entry.corsErrorStatus === "object"
      ? {
          corsError: truncateUtf8(String((entry.corsErrorStatus as { corsError?: unknown }).corsError ?? ""), 128),
          failedParameter: truncateUtf8(String((entry.corsErrorStatus as { failedParameter?: unknown }).failedParameter ?? ""), 128),
        }
      : undefined,
    bodyCapture: {
      mode: entry.bodyCapture.mode,
      complete: entry.bodyCapture.complete,
      reason: truncateUtf8(entry.bodyCapture.reason, 128),
      capturedBytes: entry.bodyCapture.capturedBytes,
    },
  };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function summarizeNetworkEntries(
  sourceEntries: NetworkEntry[],
  options: { maxBytes?: number; maxEntries?: number } = {},
): NetworkSummaryResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = options.maxEntries ?? sourceEntries.length;
  if (!Number.isInteger(maxBytes) || maxBytes < 256) {
    throw new Error("network summary maxBytes must be an integer of at least 256");
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 0) {
    throw new Error("network summary maxEntries must be a non-negative integer");
  }

  const entries: NetworkSummaryEntry[] = [];
  const result: NetworkSummaryResult = {
    entries,
    totalEntries: sourceEntries.length,
    returnedEntries: 0,
    truncated: false,
    maxBytes,
  };

  // Keep the newest matching requests when the byte ceiling truncates a list.
  // Network entries arrive oldest-first, while incident diagnosis is normally
  // concerned with the reload that just occurred.
  for (let index = sourceEntries.length - 1; index >= 0 && entries.length < maxEntries; index -= 1) {
    const entry = summarizeEntry(sourceEntries[index]);
    entries.unshift(entry);
    result.returnedEntries = entries.length;
    if (byteLength(result) > maxBytes) {
      entries.shift();
      result.returnedEntries = entries.length;
      result.truncated = true;
      break;
    }
  }

  if (result.returnedEntries < result.totalEntries) result.truncated = true;
  return result;
}
