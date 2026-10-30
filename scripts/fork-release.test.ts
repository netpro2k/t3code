// @effect-diagnostics nodeBuiltinImport:off -- Release fixtures use isolated files, never installed applications.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { hashFile, validateRelease, validateTarget } from "./fork-release.ts";

const version = "0.1.4-netpro2k";
const commit = "a".repeat(40);

const decodeUpload = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      draft: Schema.Boolean,
      prerelease: Schema.Boolean,
      target_commitish: Schema.String,
      assets: Schema.Array(
        Schema.Struct({ name: Schema.String, size: Schema.Number, digest: Schema.String }),
      ),
    }),
  ),
);

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-release-test-"));
  return {
    root,
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

async function target(
  root: string,
  platform: "linux-x64" | "linux-arm64" | "darwin-arm64",
  sourceCommit = commit,
) {
  const directory = NodePath.join(root, platform);
  await NodeFSP.mkdir(directory);
  const arch = platform.split("-")[1];
  const mac = platform === "darwin-arm64";
  const desktop = `T3-Code-${version}-${platform === "linux-x64" ? "x86_64" : arch}.${mac ? "zip" : "AppImage"}`;
  const archive = `t3-${version}-${platform}.tar.gz`;
  const names = [desktop, archive];
  if (mac) names.push(`T3-Code-${version}-${arch}.dmg`);
  else names.push(`T3-Code-${version}-${platform === "linux-x64" ? "amd64" : arch}.deb`);
  for (const name of names)
    await NodeFSP.writeFile(NodePath.join(directory, name), `fixture ${name}`);
  const sha512 = await hashFile(NodePath.join(directory, desktop), "sha512", "base64");
  const size = (await NodeFSP.stat(NodePath.join(directory, desktop))).size;
  const manifest = mac
    ? "latest-mac.yml"
    : platform === "linux-arm64"
      ? "latest-linux-arm64.yml"
      : "latest-linux.yml";
  await NodeFSP.writeFile(
    NodePath.join(directory, manifest),
    `version: ${version}\nfiles:\n  - url: ${desktop}\n    sha512: ${sha512}\n    size: ${size}\npath: ${desktop}\nsha512: ${sha512}\n`,
  );
  names.push(manifest);
  await writeReceipt(directory, platform, sourceCommit, names);
  return { directory, desktop, archive, manifest, names };
}

async function writeReceipt(
  directory: string,
  platform: string,
  sourceCommit: string,
  names: string[],
  signed = true,
  configuration = "c".repeat(64),
) {
  const assets = [];
  for (const name of names)
    assets.push({ name, sha256: await hashFile(NodePath.join(directory, name), "sha256") });
  await NodeFSP.writeFile(
    NodePath.join(directory, "build.json"),
    JSON.stringify({
      version,
      commit: sourceCommit,
      configuration,
      target: platform,
      signed,
      assets,
    }),
  );
}

describe("fork release artifact validation", () => {
  it("accepts a complete release from one commit and rejects mixed or missing targets", async () => {
    await using files = await fixture();
    const linux = await target(files.root, "linux-x64");
    await expect(validateRelease(files.root, version)).rejects.toThrow();
    const mac = await target(files.root, "darwin-arm64");
    expect((await validateRelease(files.root, version)).map((build) => build.commit)).toEqual([
      commit,
      commit,
    ]);
    await target(files.root, "linux-arm64");
    await validateRelease(files.root, version, ["darwin-arm64", "linux-x64", "linux-arm64"]);
    await writeReceipt(mac.directory, "darwin-arm64", "b".repeat(40), mac.names);
    await expect(validateRelease(files.root, version)).rejects.toThrow("same commit");
    await writeReceipt(mac.directory, "darwin-arm64", commit, mac.names, true, "d".repeat(64));
    await expect(validateRelease(files.root, version)).rejects.toThrow("same public Clerk/relay");
    await writeReceipt(mac.directory, "darwin-arm64", commit, mac.names, false);
    await expect(validateRelease(files.root, version)).rejects.toThrow("certificate signed");
    await expect(validateTarget(linux.directory, "0.1.4")).rejects.toThrow("netpro2k");
  });

  it("rejects tampered archives and manifest references even if the receipt is regenerated", async () => {
    await using files = await fixture();
    const build = await target(files.root, "linux-x64");
    await NodeFSP.appendFile(NodePath.join(build.directory, build.archive), "changed");
    await expect(validateTarget(build.directory, version)).rejects.toThrow("asset changed");
    await writeReceipt(build.directory, "linux-x64", commit, build.names);
    await validateTarget(build.directory, version);
    await NodeFSP.appendFile(NodePath.join(build.directory, build.desktop), "changed");
    await writeReceipt(build.directory, "linux-x64", commit, build.names);
    await expect(validateTarget(build.directory, version)).rejects.toThrow(
      "checksum/size mismatch",
    );
    const manifest = NodePath.join(build.directory, build.manifest);
    await NodeFSP.writeFile(
      manifest,
      (await NodeFSP.readFile(manifest, "utf8")).replaceAll(build.desktop, "../outside.AppImage"),
    );
    await writeReceipt(build.directory, "linux-x64", commit, build.names);
    await expect(validateTarget(build.directory, version)).rejects.toThrow("does not advertise");
  });

  it("excludes debug/config files and requires the Mac updater ZIP", async () => {
    await using files = await fixture();
    const build = await target(files.root, "darwin-arm64");
    for (const name of [
      "builder-debug.yml",
      "identity.pem",
      "identity.p12",
      "signing.keychain-db",
      "keychain-password",
    ]) {
      await NodeFSP.writeFile(NodePath.join(build.directory, name), "private material fixture");
      await writeReceipt(build.directory, "darwin-arm64", commit, [...build.names, name]);
      await expect(validateTarget(build.directory, version)).rejects.toThrow("Unexpected");
    }
    await writeReceipt(
      build.directory,
      "darwin-arm64",
      commit,
      build.names.filter((name) => name !== build.desktop),
    );
    await expect(validateTarget(build.directory, version)).rejects.toThrow("Missing release asset");
  });
  it("resumes identical draft uploads and publishes only after verifying remote bytes", async () => {
    await using files = await fixture();
    await target(files.root, "linux-x64");
    await target(files.root, "darwin-arm64");
    const bin = NodePath.join(files.root, "bin");
    await NodeFSP.mkdir(bin);
    const stateFile = NodePath.join(files.root, "github.json");
    const initial = {
      id: 42,
      exists: false,
      draft: true,
      prerelease: false,
      target_commitish: commit,
      assets: [],
    };
    await NodeFSP.writeFile(stateFile, JSON.stringify(initial));
    const notes = NodePath.join(files.root, "notes.md");
    await NodeFSP.writeFile(notes, "Fork release fixture");
    await NodeFSP.writeFile(
      NodePath.join(bin, "gh"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const args = process.argv.slice(2);
const file = process.env.FAKE_RELEASE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[0] === 'api' && args[1].includes('/commits/')) process.stdout.write(state.target_commitish);
else if (args[0] === 'api' && args[1].includes('/git/matching-refs/')) process.stdout.write('');
else if (args[0] === 'api' && args.includes('POST')) {
  const body = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
  if (!body.draft || body.prerelease || body.target_commitish !== state.target_commitish) throw new Error('Invalid draft creation');
  state.exists = true; state.justCreated = true;
  fs.writeFileSync(file, JSON.stringify(state)); process.stdout.write(JSON.stringify(state));
}
else if (args[0] === 'api' && args[1].includes('/releases?')) process.stdout.write(state.justCreated ? '' : String(state.id));
else if (args[0] === 'api' && args[1].endsWith('/releases/42')) {
  state.justCreated = false; fs.writeFileSync(file, JSON.stringify(state)); process.stdout.write(JSON.stringify(state));
}
else if (args[0] === 'release' && args[1] === 'list') process.stdout.write(JSON.stringify(state.exists === false ? [] : [{ tagName: 'v${version}', isDraft: state.draft, isPrerelease: false }]));
else if (args[0] === 'release' && args[1] === 'create') {
  state.exists = true; state.justCreated = true; fs.writeFileSync(file, JSON.stringify(state));
}
else if (args[0] === 'release' && args[1] === 'upload') {
  const data = fs.readFileSync(args[3]);
  state.assets.push({ name: path.basename(args[3]), size: data.length, digest: 'sha256:' + crypto.createHash('sha256').update(data).digest('hex') });
  fs.writeFileSync(file, JSON.stringify(state));
} else if (args[0] === 'release' && args[1] === 'edit') {
  state.draft = false;
  fs.writeFileSync(file, JSON.stringify(state));
} else throw new Error('Unexpected fake gh operation');
`,
      { mode: 0o755 },
    );
    const script = NodeURL.fileURLToPath(new URL("./fork-release.ts", import.meta.url));
    const invoke = (command: string) =>
      NodeChildProcess.execFileSync(
        process.execPath,
        [script, command, "--version", version, "--dir", files.root, "--notes", notes],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            FAKE_RELEASE_STATE: stateFile,
          },
          stdio: "pipe",
        },
      );
    invoke("upload");
    const draft = decodeUpload(await NodeFSP.readFile(stateFile, "utf8"));
    expect(draft.draft).toBe(true);
    expect(draft.assets.some((asset) => asset.name === "build.json")).toBe(false);
    const firstAsset = draft.assets[0];
    if (!firstAsset) throw new Error("Fixture upload produced no assets.");
    const invalid = {
      ...draft,
      assets: [{ ...firstAsset, digest: "sha256:wrong" }, ...draft.assets.slice(1)],
    };
    await NodeFSP.writeFile(stateFile, JSON.stringify(invalid));
    expect(() => invoke("publish")).toThrow();
    expect(decodeUpload(await NodeFSP.readFile(stateFile, "utf8")).draft).toBe(true);
    await NodeFSP.writeFile(stateFile, JSON.stringify(draft));
    const count = draft.assets.length;
    invoke("publish");
    const published = decodeUpload(await NodeFSP.readFile(stateFile, "utf8"));
    expect(published.draft).toBe(false);
    expect(published.assets).toHaveLength(count);
    expect(() => invoke("publish")).toThrow();
  });
});
