// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- This standalone installer helper owns a short-lived local socket and retry timer.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const RESPONSE_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PROTOCOL_VERSION = 1 as const;

interface DesktopAppPrepareUpdateRequest {
  readonly version: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly type: "prepare-update";
  readonly platform: "darwin" | "linux";
}

type DesktopAppControlResponse =
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly requestId: string;
      readonly ok: true;
      readonly preparedForUpdate: true;
    }
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly requestId: string;
      readonly ok: false;
      readonly message: string;
    };

function isDesktopAppControlResponse(value: unknown): value is DesktopAppControlResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  if (
    response.version !== PROTOCOL_VERSION ||
    typeof response.requestId !== "string" ||
    typeof response.ok !== "boolean"
  ) {
    return false;
  }
  return response.ok ? response.preparedForUpdate === true : typeof response.message === "string";
}

function resolveControlAddress(stateDir: string): string {
  const stateHash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 24);
  const userKey = typeof process.getuid === "function" ? process.getuid() : stateHash.slice(0, 12);
  return NodePath.join(NodeOS.tmpdir(), `t3code-${userKey}`, `${stateHash}.sock`);
}

function isNotRunningError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED")
  );
}

function exchange(
  address: string,
  request: DesktopAppPrepareUpdateRequest,
): Promise<DesktopAppControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (error: Error | null, response?: DesktopAppControlResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== null) reject(error);
      else if (response !== undefined) resolve(response);
    };
    const timeout = setTimeout(
      () => finish(new Error("The desktop app did not respond in time.")),
      RESPONSE_TIMEOUT_MS,
    );

    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish(new Error("The desktop app response is too large."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(new Error("The desktop app response is not valid JSON."));
        return;
      }
      if (!isDesktopAppControlResponse(parsed) || parsed.requestId !== request.requestId) {
        finish(new Error("The desktop app response is invalid."));
        return;
      }
      finish(null, parsed);
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("The desktop app closed the connection.")));
  });
}

function canConnect(address: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (isNotRunningError(error)) resolve(false);
      else reject(error);
    });
  });
}

async function waitForExit(address: string): Promise<void> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (await canConnect(address)) {
    if (Date.now() >= deadline) {
      throw new Error("The desktop app did not exit within 30 seconds.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main(): Promise<void> {
  const baseDir = process.argv[2];
  if (!baseDir || process.argv.length !== 3) {
    throw new Error("Usage: prepare-desktop-update.ts <t3-home>");
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone installer helper has no Effect runtime.
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Desktop update preparation is not supported on ${platform}.`);
  }

  const address = resolveControlAddress(NodePath.join(NodePath.resolve(baseDir), "userdata"));
  const request: DesktopAppPrepareUpdateRequest = {
    version: PROTOCOL_VERSION,
    requestId: NodeCrypto.randomUUID(),
    type: "prepare-update",
    platform,
  };

  let response: DesktopAppControlResponse;
  try {
    response = await exchange(address, request);
  } catch (error) {
    if (isNotRunningError(error)) {
      process.stdout.write("not-running\n");
      return;
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`The desktop app refused update preparation: ${response.message}`);
  }
  if (!("preparedForUpdate" in response)) {
    throw new Error("The running desktop app is too old to stop itself for this update.");
  }
  await waitForExit(address);
  process.stdout.write("stopped\n");
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
