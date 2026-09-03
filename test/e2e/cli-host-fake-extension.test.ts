import { afterEach, describe, expect, it } from "vitest";

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  execPath: string;
  kill(pid: number, signal?: string): void;
  pid: number;
  platform: string;
};
declare const require: (moduleName: string) => unknown;
declare function clearTimeout(timeoutId: unknown): void;
declare function setTimeout(callback: () => void, ms: number): unknown;

type BufferLike = {
  length: number;
  readUInt32LE(offset: number): number;
  slice(start: number, end?: number): BufferLike;
  toString(encoding?: string): string;
  write(value: string, offset?: number): number;
  writeUInt32LE(value: number, offset: number): number;
};

type EventEmitterLike = {
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
};

type WritableLike = EventEmitterLike & {
  end(): void;
  write(data: string | BufferLike): boolean;
};

type ReadableLike = EventEmitterLike;

type ChildProcessLike = EventEmitterLike & {
  pid?: number;
  stdin: WritableLike;
  stdout: ReadableLike;
  stderr: ReadableLike;
  kill(signal: string): void;
};

type NativeMessage = Record<string, unknown> & {
  id?: number;
  type?: string;
  url?: string;
  tabId?: number;
  options?: {
    filter?: string;
    includeText?: boolean;
    depth?: number;
    compact?: boolean;
  };
  savePath?: string;
  annotate?: boolean;
  fullpage?: boolean;
};

type FakeHostOptions = {
  targetActive?: boolean;
  targetInspectionFailures?: number[];
  targetInspectionError?: NativeMessage;
  targetInspectionResponse?: NativeMessage;
};

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type MessageWaiter = {
  predicate: (message: NativeMessage) => boolean;
  resolve: (message: NativeMessage) => void;
  reject: (error: Error) => void;
  timeout: unknown;
};

const { spawn } = require("node:child_process") as {
  spawn: (command: string, args: string[], options: Record<string, unknown>) => ChildProcessLike;
};
const fs = require("node:fs") as {
  mkdirSync(targetPath: string, options: { recursive: boolean }): void;
  mkdtempSync(prefix: string): string;
  readFileSync(targetPath: string, encoding: "utf8"): string;
  rmSync(targetPath: string, options: { recursive: boolean; force: boolean }): void;
  writeFileSync(targetPath: string, content: string, options?: { mode?: number }): void;
};
const os = require("node:os") as { tmpdir(): string };
const path = require("node:path") as { join(...paths: string[]): string };
const { Buffer: BufferCtor } = require("node:buffer") as {
  Buffer: {
    alloc(size: number): BufferLike;
    byteLength(value: string): number;
    concat(chunks: BufferLike[]): BufferLike;
    from(value: string, encoding?: string): BufferLike;
  };
};

const tempDirs: string[] = [];
const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function createSocketPath() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\surf-e2e-contract-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "surf-e2e-contract-"));
  tempDirs.push(tempDir);
  return path.join(tempDir, "surf.sock");
}

function writeNativeMessage(stdin: WritableLike, message: NativeMessage) {
  const json = JSON.stringify(message);
  const header = BufferCtor.alloc(4);
  header.writeUInt32LE(BufferCtor.byteLength(json), 0);
  stdin.write(BufferCtor.concat([header, BufferCtor.from(json, "utf8")]));
}

function buildExtensionResponse(
  message: NativeMessage,
  currentUrl: string,
  targetActive: boolean,
  targetExists = true,
) {
  switch (message.type) {
    case "TARGET_RESOLVE":
    case "TARGET_INSPECT":
      if (!targetExists) {
        return {
          id: message.id,
          error: "No tab with id: 42",
          errorCode: "tab_gone",
          errorDetails: { tabId: 42 },
        };
      }
      return {
        id: message.id,
        tabId: message.tabId || 42,
        windowId: 7,
        title: "Contract Fixture",
        url: currentUrl,
        active: targetActive,
        restricted: false,
      };
    case "SESSION_CLOSE_TARGET":
      return { id: message.id, success: true, tabId: message.tabId };
    case "LIST_TABS":
      return {
        id: message.id,
        tabs: [{ id: 42, title: "Contract Fixture", url: currentUrl, active: true }],
      };
    case "EXECUTE_NAVIGATE":
      return {
        id: message.id,
        success: true,
        _resolvedTabId: 42,
      };
    case "GET_PAGE_TEXT":
      return {
        id: message.id,
        title: "Contract Fixture",
        url: currentUrl,
        text: "Contract fixture page text from the fake extension.",
      };
    case "READ_PAGE":
      return {
        id: message.id,
        pageContent:
          '[e1] heading "Contract Fixture"\n[e2] button "Continue"\nText: fake extension page content',
        text: "Contract fixture page text from the fake extension.",
      };
    case "EXECUTE_SCREENSHOT":
      return {
        id: message.id,
        screenshotId: "fake-screenshot-1",
        base64: tinyPngBase64,
        width: 1,
        height: 1,
      };
    case "READ_NETWORK_REQUESTS":
      if (message.origin === "empty.fixture.test") {
        return {
          id: message.id,
          entries: [],
          totalEntries: 3,
          returnedEntries: 0,
          truncated: true,
          maxBytes: 30 * 1024,
          format: message.format,
        };
      }
      return {
        id: message.id,
        entries: [
          {
            id: "r_failed",
            ts: 1,
            method: "GET",
            url: "https://fixture.test/api?token=%3Credacted%3E",
            origin: "https://fixture.test",
            status: 0,
            type: "XHR",
            flags: ["failed"],
            failureReason: "net::ERR_CONNECTION_RESET",
            bodyCapture: { mode: "none", complete: false, reason: "request-failed" },
          },
        ],
        totalEntries: 4,
        returnedEntries: 1,
        truncated: true,
        maxBytes: 30 * 1024,
        format: message.format,
      };
    case "EXECUTE_JAVASCRIPT":
      return {
        id: message.id,
        output: JSON.stringify({
          status: 200,
          ok: true,
          url: "https://fixture.test/api",
          body: '{"ok":true}',
          bodyJson: { ok: true },
        }),
      };
    default:
      return { id: message.id, error: `Unhandled fake extension message: ${message.type}` };
  }
}

function startHost(socketPath: string, options: FakeHostOptions = {}) {
  const hostPath = path.join(process.cwd(), "native", "host.cjs");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "surf-e2e-state-"));
  tempDirs.push(stateDir);
  const child = spawn(process.execPath, [hostPath], {
    cwd: process.cwd(),
    env: { ...process.env, SURF_SOCKET: socketPath, SURF_STATE_DIR: stateDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: NativeMessage[] = [];
  const waiters: MessageWaiter[] = [];
  let stdoutBuffer = BufferCtor.alloc(0);
  let currentUrl = "about:blank";
  let targetExists = true;
  let targetInspectionCount = 0;
  const targetActive = options.targetActive !== false;
  const targetInspectionFailures = new Set(options.targetInspectionFailures ?? []);
  let stderr = "";
  let closed = false;

  const rejectWaiters = (error: Error) => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }
  };

  const notifyWaiters = (message: NativeMessage) => {
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      if (waiter?.predicate(message)) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
        index -= 1;
      }
    }
  };

  child.stdout.on("data", (chunk: unknown) => {
    stdoutBuffer = BufferCtor.concat([stdoutBuffer, chunk as BufferLike]);

    while (stdoutBuffer.length >= 4) {
      const messageLength = stdoutBuffer.readUInt32LE(0);
      if (stdoutBuffer.length < 4 + messageLength) {
        break;
      }

      const message = JSON.parse(
        stdoutBuffer.slice(4, 4 + messageLength).toString("utf8"),
      ) as NativeMessage;
      stdoutBuffer = stdoutBuffer.slice(4 + messageLength);
      messages.push(message);
      notifyWaiters(message);

      if (message.type === "HOST_READY") {
        writeNativeMessage(child.stdin, {
          type: "EXTENSION_HELLO",
          protocolVersion: 2,
          extensionVersion: "test",
          browserInstanceId: "contract-browser",
          browserEpoch: `contract-epoch-${process.pid}`,
          capabilities: ["browser-sessions", "strict-targets", "keyed-lanes"],
        });
        continue;
      }
      if (message.type === "EXECUTE_NAVIGATE" && message.url) {
        currentUrl = message.url;
      }
      if (message.type === "TARGET_INSPECT") {
        targetInspectionCount += 1;
        if (targetInspectionFailures.has(targetInspectionCount)) {
          writeNativeMessage(child.stdin, {
            id: message.id,
            error: "Tabs permission temporarily unavailable",
            errorCode: "target_inspection_failed",
          });
          continue;
        }
        if (options.targetInspectionError) {
          writeNativeMessage(child.stdin, { ...options.targetInspectionError, id: message.id });
          continue;
        }
        if (options.targetInspectionResponse) {
          writeNativeMessage(child.stdin, { ...options.targetInspectionResponse, id: message.id });
          continue;
        }
      }
      writeNativeMessage(
        child.stdin,
        buildExtensionResponse(message, currentUrl, targetActive, targetExists),
      );
      if (message.type === "SESSION_CLOSE_TARGET") {
        targetExists = false;
      }
    }
  });

  child.stderr.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  child.on("close", (code) => {
    closed = true;
    rejectWaiters(new Error(`native host exited ${String(code)}: ${stderr}`));
  });
  child.on("error", (error) => {
    const hostError = error instanceof Error ? error : new Error(String(error));
    rejectWaiters(hostError);
  });

  return {
    child,
    stateDir,
    messages,
    waitForMessage(
      predicate: (message: NativeMessage) => boolean,
      timeoutMs = 5000,
    ): Promise<NativeMessage> {
      const existing = messages.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }

      return new Promise<NativeMessage>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.predicate === predicate);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          reject(
            new Error(
              `Timed out waiting for native message. Saw: ${JSON.stringify(messages)}. Host stderr: ${stderr}`,
            ),
          );
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timeout });
      });
    },
    async dispose() {
      rejectWaiters(new Error("native host disposed"));
      child.stdin.end();
      if (!closed && child.pid !== undefined) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 1000);
          child.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      if (!closed && child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error)) {
            throw new Error(String(error));
          }
        }
      }
    },
  };
}

async function runCli(socketPath: string, args: string[], cwd = process.cwd()) {
  const cliPath = path.join(process.cwd(), "native", "cli.cjs");

  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, SURF_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 10000);

    child.stdout.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: typeof code === "number" ? code : null, stdout, stderr });
    });
  });
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function seedOldSession(
  stateDir: string,
  ownership = "surf-created",
  mode = "window",
  taskOwnedBackground = false,
) {
  const browserEpoch = `contract-epoch-${process.pid}`;
  fs.writeFileSync(
    path.join(stateDir, "browser-sessions.json"),
    JSON.stringify({
      version: 1,
      browsers: {
        "contract-browser": {
          sessions: {
            old: {
              bindingId: "old-binding",
              name: "old",
              browserInstanceId: "contract-browser",
              browserEpoch,
              tabId: 42,
              windowId: 7,
              mode,
              ownership,
              taskOwnedBackground,
              lastUrl: "https://fixture.test/old",
              createdAt: "2000-01-01T00:00:00.000Z",
              updatedAt: "2000-01-01T00:00:00.000Z",
              lastAccessedAt: "2000-01-01T00:00:00.000Z",
              lastValidatedAt: "2000-01-01T00:00:00.000Z",
            },
          },
          namedTabs: {},
        },
      },
    }),
    { mode: 0o600 },
  );
}

function hasOldSession(stateDir: string) {
  const state = JSON.parse(
    fs.readFileSync(path.join(stateDir, "browser-sessions.json"), "utf8"),
  ) as { browsers: { "contract-browser": { sessions: Record<string, unknown> } } };
  return Boolean(state.browsers["contract-browser"].sessions.old);
}

function sessionAccessTime(stateDir: string) {
  const state = JSON.parse(
    fs.readFileSync(path.join(stateDir, "browser-sessions.json"), "utf8"),
  ) as {
    browsers: { "contract-browser": { sessions: { old: { lastAccessedAt?: string } } } };
  };
  return state.browsers["contract-browser"].sessions.old.lastAccessedAt;
}

describe("CLI/native-host/fake-extension E2E contract", () => {
  it("renders bounded failed network summaries through extension, host, and CLI", async () => {
    const socketPath = createSocketPath();
    const host = startHost(socketPath);

    try {
      await host.waitForMessage((message) => message.type === "HOST_READY");
      const result = await runCli(socketPath, [
        "network",
        "--origin",
        "fixture.test",
        "--last",
        "10",
      ]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("FAIL");
      expect(result.stdout).toContain("net::ERR_CONNECTION_RESET");
      expect(result.stdout).toContain("Showing: 1 of 4 requests");
      expect(result.stdout).not.toContain("pending");
      expect(result.stdout).not.toContain("Authorization");

      const rawResult = await runCli(socketPath, ["network", "--format", "raw"]);
      expect(rawResult.code).toBe(0);
      expect(JSON.parse(rawResult.stdout)).toMatchObject({
        totalEntries: 4,
        returnedEntries: 1,
        truncated: true,
        maxBytes: 30 * 1024,
        entries: [{ status: 0, failureReason: "net::ERR_CONNECTION_RESET" }],
      });

      for (const format of ["urls", "curl", "verbose"]) {
        const formattedResult = await runCli(socketPath, ["network", "--format", format]);
        expect(formattedResult.code).toBe(0);
        expect(formattedResult.stdout).toContain("Count: total=4, returned=1, truncated=true");
        if (format === "verbose") {
          expect(formattedResult.stdout).toContain("Status: FAILED");
          expect(formattedResult.stdout).toContain("Failure: net::ERR_CONNECTION_RESET");
          expect(formattedResult.stdout).not.toContain("Status: pending");
        }
      }

      const emptyRawResult = await runCli(socketPath, [
        "network",
        "--origin",
        "empty.fixture.test",
        "--format",
        "raw",
      ]);
      expect(emptyRawResult.code).toBe(0);
      expect(JSON.parse(emptyRawResult.stdout)).toMatchObject({
        entries: [],
        totalEntries: 3,
        returnedEntries: 0,
        truncated: true,
        maxBytes: 30 * 1024,
      });

      expect(host.messages).toContainEqual(
        expect.objectContaining({
          type: "READ_NETWORK_REQUESTS",
          origin: "fixture.test",
          limit: 10,
          full: true,
        }),
      );
    } finally {
      await host.dispose();
    }
  });

  it("runs browser-like navigation, page text, and screenshot flows without Chrome", async () => {
    const socketPath = createSocketPath();
    const host = startHost(socketPath);

    try {
      await host.waitForMessage((message) => message.type === "HOST_READY");

      const tabs = await runCli(socketPath, ["tab.list"]);
      expect(tabs).toMatchObject({ code: 0, stderr: "" });
      expect(tabs.stdout).toBe("42\tContract Fixture\tabout:blank\n");

      const navigation = await runCli(socketPath, [
        "go",
        "https://fixture.test/page",
        "--no-screenshot",
      ]);
      expect(navigation).toMatchObject({ code: 0, stdout: "OK\n" });
      expect(navigation.stderr).toMatch(/\[surf tab=42 window=7(?: queued=\d+ms)?\]/);

      const pageText = await runCli(socketPath, ["page.text"]);
      expect(pageText.code).toBe(0);
      expect(pageText.stderr).toMatch(/\[surf tab=42 window=7(?: queued=\d+ms)?\]/);
      expect(pageText.stdout).toContain("Title: Contract Fixture");
      expect(pageText.stdout).toContain("URL: https://fixture.test/page");
      expect(pageText.stdout).toContain("Contract fixture page text from the fake extension.");

      const pageRead = await runCli(socketPath, ["read", "--depth", "2", "--compact"]);
      expect(pageRead.code).toBe(0);
      expect(pageRead.stderr).toMatch(/\[surf tab=42 window=7(?: queued=\d+ms)?\]/);
      expect(pageRead.stdout).toContain('[e1] heading "Contract Fixture"');
      expect(pageRead.stdout).toContain('[e2] button "Continue"');

      const screenshot = await runCli(socketPath, ["screenshot", "--no-save"]);
      expect(screenshot.code).toBe(0);
      expect(screenshot.stderr).toMatch(/\[surf tab=42 window=7(?: queued=\d+ms)?\]/);
      expect(screenshot.stdout).toContain("Screenshot captured (1x1) - ID: fake-screenshot-1");

      expect(host.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "HOST_READY" }),
          expect.objectContaining({ type: "LIST_TABS" }),
          expect.objectContaining({ type: "EXECUTE_NAVIGATE", url: "https://fixture.test/page" }),
          expect.objectContaining({ type: "GET_PAGE_TEXT" }),
          expect.objectContaining({
            type: "READ_PAGE",
            options: expect.objectContaining({ filter: "interactive", depth: 2, compact: true }),
          }),
          expect.objectContaining({ type: "EXECUTE_SCREENSHOT" }),
        ]),
      );
    } finally {
      await host.dispose();
    }
  });

  it("runs a playbook under one host lease and blocks a duplicate semantic write", async () => {
    const socketPath = createSocketPath();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "surf-playbook-project-"));
    tempDirs.push(project);
    const playbookDir = path.join(project, ".surf", "playbooks", "mutation", "ops");
    fs.mkdirSync(playbookDir, { recursive: true });
    fs.writeFileSync(
      path.join(project, ".surf", "playbooks", "mutation", "playbook.json"),
      JSON.stringify({ id: "mutation", version: "1.0.0", origins: ["https://fixture.test"] }),
    );
    fs.writeFileSync(
      path.join(playbookDir, "submit.json"),
      JSON.stringify({
        id: "submit",
        effect: "write",
        args: { action: { required: true } },
        safety: { authorization: "explicit", duplicate: "transactional", key: ["action"] },
        run: [
          {
            using: "network",
            request: {
              method: "POST",
              url: "https://fixture.test/api",
              body: { action: "{{action}}" },
            },
            extract: { jsonPath: "$.ok" },
            expect: { truthy: true },
          },
        ],
      }),
    );
    const host = startHost(socketPath);

    try {
      await host.waitForMessage((message) => message.type === "HOST_READY");
      const read = await runCli(socketPath, ["use", "page", "read", "--json"]);
      expect(read).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(read.stdout)).toMatchObject({
        status: "completed",
        strategy: "network",
        provenance: { scope: "built-in" },
      });

      const results = await Promise.all([
        runCli(
          socketPath,
          ["use", "mutation", "submit", "--action", "same", "--write", "--no-lock"],
          project,
        ),
        runCli(
          socketPath,
          ["use", "mutation", "submit", "--action", "same", "--write", "--no-lock"],
          project,
        ),
      ]);
      expect(results.filter((result) => result.code === 0)).toHaveLength(1);
      expect(results.filter((result) => result.code === 1)[0]?.stderr).toMatch(
        /write blocked by verified receipt/,
      );
      expect(host.messages.filter((message) => message.type === "EXECUTE_JAVASCRIPT")).toHaveLength(
        2,
      );
    } finally {
      await host.dispose();
    }
  });

  it("CAS-releases exact Surf-created sessions and reconciles idempotently", async () => {
    const socketPath = createSocketPath();
    const host = startHost(socketPath, { targetActive: false });
    const releaseArgs = [
      "session.release",
      "old",
      "--binding-id",
      "old-binding",
      "--browser-instance-id",
      "contract-browser",
      "--browser-epoch",
      `contract-epoch-${process.pid}`,
      "--expected-tab-id",
      "42",
      "--ownership",
      "surf-created",
      "--json",
    ];

    try {
      await host.waitForMessage((message) => message.type === "HOST_READY");
      seedOldSession(host.stateDir);

      const released = await runCli(socketPath, releaseArgs);
      expect(released.code).toBe(0);
      expect(JSON.parse(released.stdout)).toMatchObject({
        outcome: "released",
        name: "old",
        tabId: 42,
        ownership: "surf-created",
        targetClosed: true,
      });
      expect(
        host.messages.filter((message) => message.type === "SESSION_CLOSE_TARGET"),
      ).toHaveLength(1);

      const repeated = await runCli(socketPath, releaseArgs);
      expect(repeated.code).toBe(0);
      expect(JSON.parse(repeated.stdout)).toMatchObject({
        outcome: "already_absent",
        targetClosed: false,
      });
      expect(
        host.messages.filter((message) => message.type === "SESSION_CLOSE_TARGET"),
      ).toHaveLength(1);
    } finally {
      await host.dispose();
    }
  });

  it("retains bindings when target inspection is uncertain before or after close", async () => {
    const releaseArgs = [
      "session.release",
      "old",
      "--binding-id",
      "old-binding",
      "--browser-instance-id",
      "contract-browser",
      "--browser-epoch",
      `contract-epoch-${process.pid}`,
      "--expected-tab-id",
      "42",
      "--ownership",
      "surf-created",
      "--json",
    ];

    for (const targetInspectionFailures of [[1], [2]]) {
      const socketPath = createSocketPath();
      const host = startHost(socketPath, { targetActive: false, targetInspectionFailures });
      try {
        await host.waitForMessage((message) => message.type === "HOST_READY");
        seedOldSession(host.stateDir);

        const result = await runCli(socketPath, releaseArgs);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          outcome: "retained",
          targetClosed: false,
          blocker: "target_state_unknown",
        });
        expect(hasOldSession(host.stateDir)).toBe(true);
        expect(
          host.messages.filter((message) => message.type === "SESSION_CLOSE_TARGET"),
        ).toHaveLength(targetInspectionFailures[0] === 1 ? 0 : 1);
      } finally {
        await host.dispose();
      }
    }
  });

  it("does not let extension error details forge authoritative absence", async () => {
    const socketPath = createSocketPath();
    const host = startHost(socketPath, {
      targetActive: false,
      targetInspectionError: {
        error: "Tabs permission temporarily unavailable",
        errorCode: "target_inspection_failed",
        errorDetails: { code: "tab_gone", tabId: 42 },
      },
    });
    try {
      await host.waitForMessage((message) => message.type === "HOST_READY");
      seedOldSession(host.stateDir);

      const result = await runCli(socketPath, [
        "session.release",
        "old",
        "--binding-id",
        "old-binding",
        "--browser-instance-id",
        "contract-browser",
        "--browser-epoch",
        `contract-epoch-${process.pid}`,
        "--expected-tab-id",
        "42",
        "--ownership",
        "surf-created",
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "retained",
        targetClosed: false,
        blocker: "target_state_unknown",
      });
      expect(hasOldSession(host.stateDir)).toBe(true);
      expect(host.messages.some((message) => message.type === "SESSION_CLOSE_TARGET")).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  it("retains a binding when structured absence identifies another tab", async () => {
    const socketPath = createSocketPath();
    const host = startHost(socketPath, {
      targetActive: false,
      targetInspectionError: {
        error: "Tab 43 gone",
        errorCode: "tab_gone",
        errorDetails: { tabId: 43 },
      },
    });
    try {
      await host.waitForMessage((message) => message.type === "HOST_READY");
      seedOldSession(host.stateDir);

      const result = await runCli(socketPath, [
        "session.release",
        "old",
        "--binding-id",
        "old-binding",
        "--browser-instance-id",
        "contract-browser",
        "--browser-epoch",
        `contract-epoch-${process.pid}`,
        "--expected-tab-id",
        "42",
        "--ownership",
        "surf-created",
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "retained",
        targetClosed: false,
        blocker: "target_state_unknown",
      });
      expect(hasOldSession(host.stateDir)).toBe(true);
      expect(host.messages.some((message) => message.type === "SESSION_CLOSE_TARGET")).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  it("retains a binding when the extension reports mismatched target identity", async () => {
    const socketPath = createSocketPath();
    const host = startHost(socketPath, {
      targetActive: false,
      targetInspectionResponse: { tabId: 405, windowId: 7, active: false },
    });
    try {
      await host.waitForMessage((message) => message.type === "HOST_READY");
      seedOldSession(host.stateDir);

      const result = await runCli(socketPath, [
        "session.release",
        "old",
        "--binding-id",
        "old-binding",
        "--browser-instance-id",
        "contract-browser",
        "--browser-epoch",
        `contract-epoch-${process.pid}`,
        "--expected-tab-id",
        "42",
        "--ownership",
        "surf-created",
        "--json",
      ]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "retained",
        targetClosed: false,
        blocker: "target_identity_changed",
      });
      expect(hasOldSession(host.stateDir)).toBe(true);
      expect(host.messages.some((message) => message.type === "SESSION_CLOSE_TARGET")).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  it.each([
    { mode: "tab", taskOwnedBackground: false },
    { mode: "window", taskOwnedBackground: false },
  ])(
    "rejects a task-owned ensure collision with $mode provenance",
    async ({ mode, taskOwnedBackground }) => {
      const socketPath = createSocketPath();
      const host = startHost(socketPath);
      try {
        await host.waitForMessage((message) => message.type === "HOST_READY");
        seedOldSession(host.stateDir, "surf-created", mode, taskOwnedBackground);

        const result = await runCli(socketPath, [
          "session.ensure",
          "old",
          "--task-owned",
          "--json",
        ]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("not a task-owned background window");
        expect(hasOldSession(host.stateDir)).toBe(true);
      } finally {
        await host.dispose();
      }
    },
  );

  it("retains stale release identities and keeps adopted targets open", async () => {
    const staleSocket = createSocketPath();
    const staleHost = startHost(staleSocket, { targetActive: false });
    try {
      await staleHost.waitForMessage((message) => message.type === "HOST_READY");
      seedOldSession(staleHost.stateDir);
      const stale = await runCli(staleSocket, [
        "session.release",
        "old",
        "--binding-id",
        "replacement",
        "--browser-instance-id",
        "contract-browser",
        "--browser-epoch",
        `contract-epoch-${process.pid}`,
        "--expected-tab-id",
        "42",
        "--ownership",
        "surf-created",
        "--json",
      ]);
      expect(JSON.parse(stale.stdout)).toMatchObject({
        outcome: "retained",
        blocker: "binding_changed",
      });
      expect(staleHost.messages.some((message) => message.type === "SESSION_CLOSE_TARGET")).toBe(
        false,
      );
    } finally {
      await staleHost.dispose();
    }

    const adoptedSocket = createSocketPath();
    const adoptedHost = startHost(adoptedSocket, { targetActive: false });
    try {
      await adoptedHost.waitForMessage((message) => message.type === "HOST_READY");
      seedOldSession(adoptedHost.stateDir, "adopted");
      const adopted = await runCli(adoptedSocket, [
        "session.release",
        "old",
        "--binding-id",
        "old-binding",
        "--browser-instance-id",
        "contract-browser",
        "--browser-epoch",
        `contract-epoch-${process.pid}`,
        "--expected-tab-id",
        "42",
        "--ownership",
        "adopted",
        "--json",
      ]);
      expect(JSON.parse(adopted.stdout)).toMatchObject({
        outcome: "released",
        ownership: "adopted",
        targetClosed: false,
        adoptedTargetKept: true,
      });
      expect(adoptedHost.messages.some((message) => message.type === "SESSION_CLOSE_TARGET")).toBe(
        false,
      );
    } finally {
      await adoptedHost.dispose();
    }
  });

  it("removes an old live Surf-created session and its target", async () => {
    const socketPath = createSocketPath();
    const host = startHost(socketPath, { targetActive: false });

    try {
      await host.waitForMessage((message) => message.type === "HOST_READY");
      seedOldSession(host.stateDir);

      const cleanup = await runCli(socketPath, ["session.cleanup", "--idle-after", "1s", "--json"]);
      expect(cleanup).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(cleanup.stdout)).toMatchObject({
        dryRun: false,
        removed: [{ name: "old", targetAction: "close", targetClosed: true }],
      });
      expect(host.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "SESSION_CLOSE_TARGET", tabId: 42 }),
        ]),
      );

      const listed = await runCli(socketPath, ["session.list", "--json"]);
      expect(JSON.parse(listed.stdout).sessions).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it("keeps an old session and target during cleanup dry-run", async () => {
    const socketPath = createSocketPath();
    const host = startHost(socketPath, { targetActive: false });

    try {
      await host.waitForMessage((message) => message.type === "HOST_READY");
      seedOldSession(host.stateDir);

      const cleanup = await runCli(socketPath, [
        "session.cleanup",
        "--idle-after",
        "1s",
        "--dry-run",
        "--json",
      ]);
      expect(cleanup).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(cleanup.stdout)).toMatchObject({
        dryRun: true,
        removed: [{ name: "old", targetAction: "close", targetClosed: true }],
      });
      expect(host.messages.some((message) => message.type === "SESSION_CLOSE_TARGET")).toBe(false);

      const listed = await runCli(socketPath, ["session.list", "--json"]);
      expect(JSON.parse(listed.stdout).sessions).toHaveLength(1);
    } finally {
      await host.dispose();
    }
  });

  it("removes an idle adopted binding without closing its target", async () => {
    const socketPath = createSocketPath();
    const host = startHost(socketPath, { targetActive: false });

    try {
      await host.waitForMessage((message) => message.type === "HOST_READY");
      seedOldSession(host.stateDir, "adopted");

      const cleanup = await runCli(socketPath, ["session.cleanup", "--idle-after", "1s", "--json"]);
      expect(cleanup).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(cleanup.stdout)).toMatchObject({
        removed: [{ name: "old", ownership: "adopted", targetAction: "keep", targetClosed: false }],
      });
      expect(host.messages.some((message) => message.type === "SESSION_CLOSE_TARGET")).toBe(false);

      const listed = await runCli(socketPath, ["session.list", "--json"]);
      expect(JSON.parse(listed.stdout).sessions).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it("does not refresh idle activity during list/info validation", async () => {
    const socketPath = createSocketPath();
    const host = startHost(socketPath, { targetActive: false });

    try {
      await host.waitForMessage((message) => message.type === "HOST_READY");
      seedOldSession(host.stateDir);
      const originalAccessTime = sessionAccessTime(host.stateDir);

      const listed = await runCli(socketPath, ["session.list", "--refresh", "--json"]);
      expect(listed.code).toBe(0);
      expect(sessionAccessTime(host.stateDir)).toBe(originalAccessTime);

      const info = await runCli(socketPath, ["session.info", "old", "--refresh", "--json"]);
      expect(info.code).toBe(0);
      expect(sessionAccessTime(host.stateDir)).toBe(originalAccessTime);

      const cleanup = await runCli(socketPath, ["session.cleanup", "--idle-after", "1s", "--json"]);
      expect(cleanup.code).toBe(0);
      expect(JSON.parse(cleanup.stdout).removed).toMatchObject([
        { name: "old", reason: "idle", targetAction: "close" },
      ]);
    } finally {
      await host.dispose();
    }
  });
});
