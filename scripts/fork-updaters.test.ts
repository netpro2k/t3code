// @effect-diagnostics nodeBuiltinImport:off -- Exercise shell updaters with OS commands replaced inside a temporary home.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { afterEach, describe, expect, it } from "vite-plus/test";

const scriptsDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string, executable = false) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content, { mode: executable ? 0o755 : 0o644 });
}

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-updaters-"));
  roots.push(root);
  const home = NodePath.join(root, "home");
  const repo = NodePath.join(root, "repo");
  const applications = NodePath.join(root, "Applications");
  const bin = NodePath.join(home, ".local/bin");
  const env = {
    ...process.env,
    HOME: home,
    PATH: "/usr/bin:/bin",
    TEST_ROOT: root,
    TEST_NODE: process.execPath,
    MOCK_FAILURE: "",
  };
  for (const name of ["update-linux.sh", "update-mac.sh", "complete-mac-update.sh"]) {
    // Redirect the macOS system installation root into this fixture. All other
    // code runs unchanged; no host app, service, or user data is reachable.
    write(
      NodePath.join(repo, "scripts", name),
      name === "update-linux.sh"
        ? NodeFS.readFileSync(NodePath.join(scriptsDirectory, name), "utf8")
        : NodeFS.readFileSync(NodePath.join(scriptsDirectory, name), "utf8").replaceAll(
            "/Applications",
            applications,
          ),
    );
  }
  for (const name of ["apps/server", "apps/desktop", "apps/web", "packages/contracts"]) {
    write(
      NodePath.join(repo, name, "package.json"),
      JSON.stringify({ version: "0.0.45", productName: "T3 Code (Beta)" }),
    );
  }
  const command = (name: string, body: string) =>
    write(NodePath.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, true);
  command("node", 'if [ "$1" = "-e" ]; then exit 0; fi\nexec "$TEST_NODE" "$@"');
  command(
    "git",
    `case "$1" in
    describe) echo v0.1.0 ;;
    rev-parse) echo 81493efb71 ;;
    tag) echo v0.1.0 ;;
  esac`,
  );
  command("uname", "echo x86_64");
  command("systemd-run", 'printf "%s\\n" "$@" > "$TEST_ROOT/handoff"');
  command("magick", 'for last do :; done\n: > "$last"');
  command("ditto", 'cp -R "$1" "$2"');
  command("open", 'printf "%s\\n" "$@" >> "$TEST_ROOT/opened"');
  command("grok", "echo grok-fixture");
  write(NodePath.join(home, ".cargo/bin/cargo"), "#!/bin/sh\necho cargo-fixture\n", true);
  write(
    NodePath.join(home, ".vite-plus/bin/vp"),
    '#!/bin/sh\nset -eu\ncargo --version > "$TEST_ROOT/build-tools"\ngrok --version >> "$TEST_ROOT/build-tools"\n',
    true,
  );
  command(
    "hdiutil",
    `case "$1" in
    attach)
      printf '%s\\n' "$2" > "$TEST_ROOT/attached-dmg"
      for mount do :; done
      mkdir -p "$mount/T3 Code (Beta).app"
      echo new-beta > "$mount/T3 Code (Beta).app/build"
      echo '/dev/disk999 Apple_HFS fixture'
      ;;
  esac`,
  );
  command(
    "launchctl",
    `case "$1" in
    submit)
      printf '%s\\n' "$@" > "$TEST_ROOT/handoff"
      ;;
    print)
      [ "$2" = "gui/501/current" ] || exit 1
      if [ -f "$TEST_ROOT/ready" ]; then echo 'pid = 999999';
      elif [ ! -f "$TEST_ROOT/unloaded" ]; then echo 'state = running';
      else exit 1; fi
      ;;
    bootout)
      [ "$MOCK_FAILURE" != stop ] || exit 1
      touch "$TEST_ROOT/unloaded"
      ;;
    bootstrap)
      [ "$MOCK_FAILURE" != bootstrap ] || exit 1
      touch "$TEST_ROOT/ready"
      ;;
  esac`,
  );
  write(
    NodePath.join(repo, "scripts/update-release-package-versions.ts"),
    "// Fixture manifests already carry the product name.\n",
  );
  write(NodePath.join(repo, "apps/server/scripts/cli.ts"), "// No build needed for the fixture.\n");
  write(NodePath.join(repo, "apps/server/dist/bin.mjs"), "// Fixture server.\n");
  write(
    NodePath.join(repo, "scripts/build-desktop-artifact.ts"),
    `import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
execFileSync('cargo', ['--version']);
execFileSync('grok', ['--version']);
const release = path.join(process.cwd(), 'release');
fs.mkdirSync(release, { recursive: true });
if (!process.env.SKIP_CURRENT_ARTIFACT) {
  fs.writeFileSync(path.join(release, 'T3-Code-0.1.0-arm64.dmg'), 'current-dmg');
  fs.writeFileSync(path.join(release, 'T3-Code-0.1.0-x86_64.AppImage'), 'current-appimage');
}
`,
  );
  write(
    NodePath.join(repo, "scripts/prepare-desktop-update.ts"),
    'console.log(process.env.MOCK_DESKTOP_STATE ?? "stopped");\n',
  );
  write(
    NodePath.join(repo, "scripts/provision-desktop-session.ts"),
    "// No credentials are issued in this fixture.\n",
  );
  NodeFS.mkdirSync(applications, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(repo, "release"), { recursive: true });
  for (const name of ["T3-Code-0.0.45-arm64.dmg", "T3-Code-0.0.45-x86_64.AppImage"]) {
    const path = NodePath.join(repo, "release", name);
    write(path, "stale-alpha-artifact");
    NodeFS.utimesSync(path, 4_070_908_800, 4_070_908_800);
  }
  return { root, home, repo, applications, env, bin };
}

function run(f: ReturnType<typeof fixture>, script: string, args: string[], env = {}) {
  return NodeChildProcess.spawnSync(
    "/bin/bash",
    [NodePath.join(f.repo, "scripts", script), ...args],
    {
      env: { ...f.env, ...env },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("fork updater staging", () => {
  it.each(["linux", "mac"])("stages the Beta release from a service PATH on %s", (platform) => {
    const f = fixture();
    const result = run(f, `update-${platform}.sh`, platform === "linux" ? ["--skip-pull"] : []);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const handoff = NodeFS.readFileSync(NodePath.join(f.root, "handoff"), "utf8");
    if (platform === "mac") {
      expect(NodeFS.readFileSync(NodePath.join(f.root, "attached-dmg"), "utf8").trim()).toBe(
        NodePath.join(f.repo, "release/T3-Code-0.1.0-arm64.dmg"),
      );
      expect(handoff.split("\n")).toContain(NodePath.join(f.applications, "T3 Code (Beta).app"));
      const stage = handoff
        .split("\n")
        .find((line) => line.startsWith(`${f.applications}/.t3code-update.`));
      expect(stage).toBeDefined();
      expect(NodeFS.readFileSync(NodePath.join(stage!, "build"), "utf8").trim()).toBe("new-beta");
      const plist = handoff
        .split("\n")
        .find((line) => line.includes("/.com.netpro2k.t3code.server."));
      expect(NodeFS.readFileSync(plist!, "utf8")).toContain(
        `${f.home}/.local/bin:${f.home}/.cargo/bin`,
      );
    } else {
      const stagedImage = handoff.split("\n").find((line) => line.includes("/.T3-Code.AppImage."));
      expect(NodeFS.readFileSync(stagedImage!, "utf8")).toBe("current-appimage");
      expect(handoff.split("\n")).toContain(NodePath.join(f.home, "Applications/T3-Code.AppImage"));
      const unit = handoff.split("\n").find((line) => line.includes("/.t3code.service."));
      expect(NodeFS.readFileSync(unit!, "utf8")).toContain(
        `${f.home}/.local/bin:${f.home}/.cargo/bin`,
      );
    }
    expect(NodeFS.existsSync(NodePath.join(f.root, "opened"))).toBe(false);
  });

  it.each(["linux", "mac"])(
    "refuses stale artifacts when the current %s build produced none",
    (platform) => {
      const f = fixture();
      const result = run(f, `update-${platform}.sh`, platform === "linux" ? ["--skip-pull"] : [], {
        SKIP_CURRENT_ARTIFACT: "1",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("0.1.0");
      expect(NodeFS.existsSync(NodePath.join(f.root, "handoff"))).toBe(platform === "mac"); // macOS only submitted its preflight job.
      expect(NodeFS.existsSync(NodePath.join(f.root, "attached-dmg"))).toBe(false);
    },
  );
});

function cutover(f: ReturnType<typeof fixture>, env = {}) {
  const stage = NodePath.join(f.applications, ".t3code-update.fixture/T3 Code (Beta).app");
  write(NodePath.join(stage, "build"), "new-beta");
  const launcher = NodePath.join(f.home, "launcher");
  const plist = NodePath.join(f.home, "service.plist");
  write(`${launcher}.tmp`, "new-launcher");
  write(`${plist}.tmp`, "new-service");
  write(plist, "old-service");
  return run(
    f,
    "complete-mac-update.sh",
    [
      f.repo,
      NodePath.join(f.bin, "node"),
      NodePath.join(f.repo, "apps/server/dist/bin.mjs"),
      stage,
      NodePath.join(f.applications, "T3 Code (Beta).app"),
      `${launcher}.tmp`,
      launcher,
      `${plist}.tmp`,
      plist,
      NodePath.join(f.home, "legacy.plist"),
      "gui/501",
      "gui/501/current",
      "gui/501/legacy",
      "gui/501/handoff",
      NodePath.join(f.root, "status"),
    ],
    { PATH: `${f.bin}:/usr/bin:/bin`, ...env },
  );
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "macOS Alpha to Beta cutover",
  () => {
    it.each(["stopped", "not-running"])(
      "retires Alpha after readiness and honors Desktop state %s",
      (state) => {
        const f = fixture();
        write(NodePath.join(f.applications, "T3 Code (Alpha).app/build"), "old-alpha");
        const result = cutover(f, { MOCK_DESKTOP_STATE: state });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(
          NodeFS.readFileSync(NodePath.join(f.applications, "T3 Code (Beta).app/build"), "utf8"),
        ).toBe("new-beta");
        expect(NodeFS.readdirSync(f.applications)).toEqual(["T3 Code (Beta).app"]);
        expect(NodeFS.readFileSync(NodePath.join(f.root, "status"), "utf8").trim()).toBe(
          "succeeded",
        );
        expect(NodeFS.existsSync(NodePath.join(f.root, "opened"))).toBe(state === "stopped");
        if (state === "stopped")
          expect(NodeFS.readFileSync(NodePath.join(f.root, "opened"), "utf8").trim()).toBe(
            NodePath.join(f.applications, "T3 Code (Beta).app"),
          );
      },
    );

    it.each(["stop", "bootstrap"])(
      "restores Alpha and an existing Beta after a %s failure",
      (failure) => {
        const f = fixture();
        write(NodePath.join(f.applications, "T3 Code (Alpha).app/build"), "old-alpha");
        write(NodePath.join(f.applications, "T3 Code (Beta).app/build"), "old-beta");
        const result = cutover(f, { MOCK_FAILURE: failure });
        expect(result.status).not.toBe(0);
        expect(
          NodeFS.readFileSync(NodePath.join(f.applications, "T3 Code (Alpha).app/build"), "utf8"),
        ).toBe("old-alpha");
        expect(
          NodeFS.readFileSync(NodePath.join(f.applications, "T3 Code (Beta).app/build"), "utf8"),
        ).toBe("old-beta");
        expect(NodeFS.readFileSync(NodePath.join(f.root, "status"), "utf8").trim()).toBe("failed");
      },
    );

    it("removes a newly installed Beta and reopens Alpha when service replacement fails", () => {
      const f = fixture();
      write(NodePath.join(f.applications, "T3 Code (Alpha).app/build"), "old-alpha");
      const result = cutover(f, { MOCK_FAILURE: "stop" });
      expect(result.status).not.toBe(0);
      expect(NodeFS.existsSync(NodePath.join(f.applications, "T3 Code (Beta).app"))).toBe(false);
      expect(NodeFS.readFileSync(NodePath.join(f.root, "opened"), "utf8").trim()).toBe(
        NodePath.join(f.applications, "T3 Code (Alpha).app"),
      );
    });
  },
);
