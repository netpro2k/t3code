#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- Native build and GitHub publication adapter.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { CLI_RELEASE_REPOSITORY, isForkReleaseVersion } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";
import { loadRepoEnv } from "./lib/public-config.ts";

const Target = Schema.Literals(["darwin-arm64", "linux-x64", "linux-arm64"]);
const Asset = Schema.Struct({ name: Schema.String, sha256: Schema.String });
const Receipt = Schema.Struct({
  version: Schema.String,
  commit: Schema.String,
  configuration: Schema.String,
  target: Target,
  signed: Schema.Boolean,
  assets: Schema.Array(Asset),
});
const Feed = Schema.Struct({
  version: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      sha512: Schema.String,
      size: Schema.Number,
    }),
  ),
  path: Schema.optionalKey(Schema.String),
  sha512: Schema.optionalKey(Schema.String),
});
const GitHubRelease = Schema.Struct({
  id: Schema.Number,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  target_commitish: Schema.String,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      digest: Schema.NullOr(Schema.String),
    }),
  ),
});
const decodeTarget = Schema.decodeUnknownSync(Target);
const decodeEngine = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ engines: Schema.Struct({ node: Schema.String }) })),
);
const decodeReleaseList = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        tagName: Schema.String,
        isDraft: Schema.Boolean,
        isPrerelease: Schema.Boolean,
      }),
    ),
  ),
);
const decodeReceipt = Schema.decodeSync(Schema.fromJsonString(Receipt));
const decodeFeed = Schema.decodeUnknownSync(fromYaml(Feed));
const decodeRelease = Schema.decodeSync(Schema.fromJsonString(GitHubRelease));
const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const receiptName = "build.json";
const defaultTargets: ReadonlyArray<typeof Target.Type> = ["darwin-arm64", "linux-x64"];

function requireVersion(version: string) {
  if (!isForkReleaseVersion(version))
    throw new Error("Use X.Y.Z-netpro2k or X.Y.Z-netpro2k.N (N > 0).");
}

function safeName(name: string) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`Asset must be a plain filename: ${name}`);
  }
  return name;
}

function feedName(target: typeof Target.Type) {
  return target === "darwin-arm64"
    ? "latest-mac.yml"
    : target === "linux-arm64"
      ? "latest-linux-arm64.yml"
      : "latest-linux.yml";
}

function desktopAssetName(version: string, target: typeof Target.Type, extension: string) {
  const arch =
    target === "linux-x64"
      ? extension.startsWith("AppImage")
        ? "x86_64"
        : "amd64"
      : target.split("-")[1];
  return `T3-Code-${version}-${arch}.${extension}`;
}

function isReleaseAsset(name: string, version: string, target: typeof Target.Type) {
  if (name === feedName(target) || name === `t3-${version}-${target}.tar.gz`) return true;
  const extensions =
    target === "darwin-arm64"
      ? ["dmg", "zip", "dmg.blockmap", "zip.blockmap"]
      : ["AppImage", "deb", "AppImage.blockmap"];
  return extensions.some((extension) => name === desktopAssetName(version, target, extension));
}

export async function hashFile(
  file: string,
  algorithm: "sha256" | "sha512",
  encoding: "hex" | "base64" = "hex",
) {
  const hash = NodeCrypto.createHash(algorithm);
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

async function requireRegularFile(file: string) {
  if (!(await NodeFSP.lstat(file)).isFile()) throw new Error(`Expected a regular file: ${file}`);
}

export async function validateTarget(directory: string, version: string) {
  requireVersion(version);
  const receipt = decodeReceipt(
    await NodeFSP.readFile(NodePath.join(directory, receiptName), "utf8"),
  );
  if (receipt.version !== version || !/^[a-f0-9]{40}$/.test(receipt.commit))
    throw new Error("Build version/commit mismatch.");
  if (receipt.target === "darwin-arm64" && !receipt.signed)
    throw new Error("macOS updater builds must be certificate signed.");
  const names = new Set<string>();
  for (const asset of receipt.assets) {
    safeName(asset.name);
    if (!isReleaseAsset(asset.name, version, receipt.target) || names.has(asset.name))
      throw new Error(`Unexpected or duplicate release asset: ${asset.name}`);
    names.add(asset.name);
    const file = NodePath.join(directory, asset.name);
    await requireRegularFile(file);
    if ((await hashFile(file, "sha256")) !== asset.sha256)
      throw new Error(`Build asset changed: ${asset.name}`);
  }
  const required = [
    feedName(receipt.target),
    `t3-${version}-${receipt.target}.tar.gz`,
    ...(receipt.target === "darwin-arm64"
      ? [
          desktopAssetName(version, receipt.target, "dmg"),
          desktopAssetName(version, receipt.target, "zip"),
        ]
      : [desktopAssetName(version, receipt.target, "AppImage")]),
  ];
  for (const name of required)
    if (!names.has(name)) throw new Error(`Missing release asset: ${name}`);
  const feed = decodeFeed(
    await NodeFSP.readFile(NodePath.join(directory, feedName(receipt.target)), "utf8"),
  );
  if (feed.version !== version || feed.files.length === 0)
    throw new Error("Updater manifest version/files mismatch.");
  const expectedUpdate = desktopAssetName(
    version,
    receipt.target,
    receipt.target === "darwin-arm64" ? "zip" : "AppImage",
  );
  if (!feed.files.some((file) => file.url === expectedUpdate))
    throw new Error(`Manifest does not advertise ${expectedUpdate}`);
  for (const file of feed.files) {
    safeName(file.url);
    if (!names.has(file.url)) throw new Error(`Manifest references missing asset: ${file.url}`);
    const path = NodePath.join(directory, file.url);
    if (
      (await NodeFSP.stat(path)).size !== file.size ||
      (await hashFile(path, "sha512", "base64")) !== file.sha512
    )
      throw new Error(`Manifest checksum/size mismatch: ${file.url}`);
  }
  if (
    feed.path !== undefined &&
    (!names.has(safeName(feed.path)) ||
      !feed.sha512 ||
      (await hashFile(NodePath.join(directory, feed.path), "sha512", "base64")) !== feed.sha512)
  )
    throw new Error("Legacy manifest checksum/path mismatch.");
  return receipt;
}

export async function validateRelease(
  directory: string,
  version: string,
  targets = defaultTargets,
) {
  const builds = [];
  const names = new Set<string>();
  for (const target of targets) {
    const location = NodePath.join(directory, target);
    const receipt = await validateTarget(location, version);
    if (receipt.target !== target) throw new Error(`Build directory target mismatch: ${target}`);
    for (const asset of receipt.assets) {
      if (names.has(asset.name)) throw new Error(`Duplicate asset across targets: ${asset.name}`);
      names.add(asset.name);
    }
    builds.push({ directory: location, ...receipt });
  }
  if (new Set(builds.map((build) => build.commit)).size !== 1)
    throw new Error("All targets must be built from the same commit.");
  if (new Set(builds.map((build) => build.configuration)).size !== 1)
    throw new Error("All targets must use the same public Clerk/relay build configuration.");
  return builds;
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd = repoRoot,
  capture = false,
  env = process.env,
) {
  const output = NodeChildProcess.execFileSync(command, [...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  return output?.trim() ?? "";
}

function git(args: ReadonlyArray<string>) {
  return run("git", args, repoRoot, true);
}

async function build(
  version: string,
  ref: string,
  output: string,
  host: { platform: string; arch: string },
) {
  requireVersion(version);
  const target = decodeTarget(`${host.platform}-${host.arch}`);
  const commit = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const engine = decodeEngine(git(["show", `${commit}:package.json`])).engines.node;
  if (process.versions.node !== engine)
    throw new Error(
      `Build with Node ${engine}, as pinned by the selected commit (current: ${process.versions.node}).`,
    );
  const configured = loadRepoEnv({ repoRoot });
  const publicKeys = [
    "T3CODE_CLERK_PUBLISHABLE_KEY",
    "T3CODE_CLERK_JWT_TEMPLATE",
    "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
    "T3CODE_RELAY_URL",
  ];
  const publicConfig = Object.fromEntries(publicKeys.map((key) => [key, configured[key] ?? ""]));
  const configuration = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(publicConfig))
    .digest("hex");
  const upstreamTag = `v${version.split("-")[0]}`;
  git(["merge-base", "--is-ancestor", upstreamTag, commit]);
  if (!NodePath.relative(repoRoot, output).startsWith(`..${NodePath.sep}`))
    throw new Error("Keep release output outside the checkout.");
  const destination = NodePath.join(output, target);
  if (NodeFS.existsSync(destination))
    throw new Error(`Refusing to replace an existing build: ${destination}`);
  if (target === "darwin-arm64") {
    const identity = process.env.T3CODE_CLI_MAC_SIGN_IDENTITY;
    if (!identity || identity === "-")
      throw new Error(
        "Set T3CODE_CLI_MAC_SIGN_IDENTITY to the persistent certificate used for this release.",
      );
    if (process.env.T3CODE_SIGNING_DIRECTORY)
      run("bash", [
        NodePath.join(repoRoot, "scripts/fork-signing.sh"),
        "unlock",
        process.env.T3CODE_SIGNING_DIRECTORY,
      ]);
    const notarizationKeys = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];
    if (
      notarizationKeys.some((key) => process.env[key]) &&
      !notarizationKeys.every((key) => process.env[key])
    )
      throw new Error(
        "Provide all three APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER values, or omit notarization.",
      );
    for (const key of ["T3CODE_MACOS_PROVISIONING_PROFILE", "APPLE_API_KEY"]) {
      const file = process.env[key];
      if (!file) continue;
      if (!NodePath.isAbsolute(file)) throw new Error(`${key} must be an absolute file path.`);
      await requireRegularFile(file);
    }
  }
  const worktree = await NodeFSP.mkdtemp(NodePath.join(NodePath.dirname(repoRoot), ".t3-release-"));
  const stage = await NodeFSP.mkdtemp(NodePath.join(NodePath.dirname(repoRoot), ".t3-assets-"));
  let added = false;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...publicConfig,
    T3CODE_TELEMETRY_CHANNEL: "dev",
    APP_VERSION: version,
    ...(target === "darwin-arm64"
      ? {
          CSC_NAME: process.env.T3CODE_CLI_MAC_SIGN_IDENTITY!.replace(
            /^Developer ID Application:\s*/,
            "",
          ),
        }
      : {}),
  };
  delete env.VITE_HTTP_URL;
  delete env.VITE_WS_URL;
  try {
    run("git", ["worktree", "add", "--detach", worktree, commit]);
    added = true;
    const node = (args: string[]) => run(process.execPath, args, worktree, false, env);
    run("vp", ["install", "--frozen-lockfile"], worktree, false, env);
    node(["scripts/update-release-package-versions.ts", version]);
    const mac = target === "darwin-arm64";
    const arch = host.arch;
    node([
      "scripts/build-desktop-artifact.ts",
      "--platform",
      mac ? "mac" : "linux",
      "--target",
      mac ? "dmg" : "AppImage",
      "--arch",
      arch,
      "--build-version",
      version,
      ...(mac ? ["--signed"] : []),
    ]);
    if (mac) {
      const appDirectory = NodePath.join(stage, "signed-app");
      run("ditto", [
        "-x",
        "-k",
        NodePath.join(worktree, "release", `T3-Code-${version}-arm64.zip`),
        appDirectory,
      ]);
      const app = (await NodeFSP.readdir(appDirectory)).find((name) => name.endsWith(".app"));
      if (!app) throw new Error("Signed ZIP does not contain the app.");
      const appPath = NodePath.join(appDirectory, app);
      run("codesign", ["--verify", "--deep", "--strict", appPath]);
      const identity = NodeChildProcess.spawnSync("codesign", ["-d", "--verbose=2", appPath], {
        encoding: "utf8",
      });
      if (identity.status !== 0 || !/^Authority=/m.test(identity.stderr))
        throw new Error("macOS automatic updates require a certificate-signed application.");
      const expectedIdentity = process.env.T3CODE_CLI_MAC_SIGN_IDENTITY!;
      if (/^[a-f0-9]{40}$/i.test(expectedIdentity)) {
        const certificatePrefix = NodePath.join(stage, "app-certificate-");
        run("codesign", ["-d", `--extract-certificates=${certificatePrefix}`, appPath]);
        const fingerprint = NodeCrypto.createHash("sha1")
          .update(await NodeFSP.readFile(`${certificatePrefix}0`))
          .digest("hex");
        if (fingerprint !== expectedIdentity.toLowerCase())
          throw new Error("The packaged app uses a different signing certificate.");
      } else if (!identity.stderr.includes(`Authority=${expectedIdentity}`))
        throw new Error("The packaged app uses a different signing certificate.");
      if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
        run("spctl", ["--assess", "--type", "execute", appPath]);
      await NodeFSP.rm(appDirectory, { recursive: true });
    }
    node(["apps/server/scripts/cli.ts", "build-exe"]);
    const rustTarget = mac
      ? "aarch64-apple-darwin"
      : arch === "arm64"
        ? "aarch64-unknown-linux-gnu"
        : "x86_64-unknown-linux-gnu";
    const monitor = NodePath.join(stage, "monitor", target);
    await NodeFSP.mkdir(monitor, { recursive: true });
    await NodeFSP.copyFile(
      NodePath.join(
        worktree,
        "native/resource-monitor/target",
        rustTarget,
        "release/t3-resource-monitor",
      ),
      NodePath.join(monitor, "t3-resource-monitor"),
    );
    node([
      "scripts/build-cli-archive.ts",
      "--platform",
      mac ? "mac" : "linux",
      "--arch",
      arch,
      "--version",
      version,
      "--resource-monitor-dir",
      NodePath.dirname(monitor),
      "--output-dir",
      NodePath.join(stage, "cli"),
    ]);
    const archive = `t3-${version}-${target}.tar.gz`;
    node([
      "scripts/smoke-cli-archive.ts",
      "--archive",
      NodePath.join(stage, "cli", archive),
      "--expect-version",
      version,
    ]);
    const files = NodePath.join(stage, "files");
    await NodeFSP.mkdir(files);
    await NodeFSP.copyFile(NodePath.join(stage, "cli", archive), NodePath.join(files, archive));
    for (const name of await NodeFSP.readdir(NodePath.join(worktree, "release")))
      if (isReleaseAsset(name, version, target))
        await NodeFSP.copyFile(
          NodePath.join(worktree, "release", name),
          NodePath.join(files, name),
        );
    const assets = [];
    for (const name of (await NodeFSP.readdir(files)).sort())
      assets.push({ name, sha256: await hashFile(NodePath.join(files, name), "sha256") });
    await NodeFSP.writeFile(
      NodePath.join(files, receiptName),
      JSON.stringify({ version, commit, configuration, target, signed: mac, assets }, null, 2) +
        "\n",
    );
    await validateTarget(files, version);
    await NodeFSP.mkdir(output, { recursive: true });
    await NodeFSP.cp(files, destination, { recursive: true, errorOnExist: true, force: false });
    process.stdout.write(`Built and verified ${target}: ${destination}\n`);
  } finally {
    if (added) run("git", ["worktree", "remove", "--force", worktree]);
    else await NodeFSP.rm(worktree, { recursive: true, force: true });
    await NodeFSP.rm(stage, { recursive: true, force: true });
  }
}

async function publish(
  directory: string,
  version: string,
  notes: string,
  draftOnly: boolean,
  targets: ReadonlyArray<typeof Target.Type>,
) {
  const builds = await validateRelease(directory, version, targets);
  const commit = builds[0]!.commit;
  const tag = `v${version}`;
  const endpoint = `repos/${CLI_RELEASE_REPOSITORY}`;
  const gh = (args: string[]) => run("gh", args, repoRoot, true);
  if (gh(["api", `${endpoint}/commits/${commit}`, "--jq", ".sha"]) !== commit)
    throw new Error("Push the exact build commit to the fork before publishing.");
  const releases = decodeReleaseList(
    gh([
      "release",
      "list",
      "--repo",
      CLI_RELEASE_REPOSITORY,
      "--limit",
      "1000",
      "--json",
      "tagName,isDraft,isPrerelease",
    ]),
  );
  if (
    releases.some(
      (release) =>
        !release.isDraft &&
        !release.isPrerelease &&
        isForkReleaseVersion(release.tagName.replace(/^v/, "")) &&
        compareSemverVersions(release.tagName.replace(/^v/, ""), version) >= 0,
    )
  )
    throw new Error("Use a new fork version newer than every published fork release.");
  let releaseId: string;
  if (!releases.some((release) => release.tagName === tag)) {
    const requestDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-release-create-"),
    );
    try {
      const input = NodePath.join(requestDirectory, "release.json");
      await NodeFSP.writeFile(
        input,
        JSON.stringify({
          tag_name: tag,
          target_commitish: commit,
          name: `T3 Code ${version}`,
          body: await NodeFSP.readFile(NodePath.resolve(notes), "utf8"),
          draft: true,
          prerelease: false,
        }),
      );
      releaseId = String(
        decodeRelease(gh(["api", `${endpoint}/releases`, "--method", "POST", "--input", input])).id,
      );
    } finally {
      await NodeFSP.rm(requestDirectory, { recursive: true, force: true });
    }
  } else {
    // New drafts use the creation response; authenticated listing finds drafts on subsequent runs.
    releaseId = gh([
      "api",
      `${endpoint}/releases?per_page=100`,
      "--paginate",
      "--jq",
      `.[] | select(.tag_name == "${tag}") | .id`,
    ]);
  }
  const existingTag = gh([
    "api",
    `${endpoint}/git/matching-refs/tags/${tag}`,
    "--jq",
    `.[] | select(.ref == "refs/tags/${tag}") | .ref`,
  ]);
  if (existingTag && gh(["api", `${endpoint}/commits/${tag}`, "--jq", ".sha"]) !== commit)
    throw new Error("The existing release tag points at a different source commit.");
  if (!/^\d+$/.test(releaseId)) throw new Error("Could not locate the unique draft release.");
  const readRelease = () => decodeRelease(gh(["api", `${endpoint}/releases/${releaseId}`]));
  let release = readRelease();
  if (!release.draft || release.prerelease || release.target_commitish !== commit)
    throw new Error(
      "Release must be an unpublished regular draft targeting the exact build commit.",
    );
  const staging = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-release-upload-"));
  try {
    const files = builds.flatMap((build) =>
      build.assets.map((asset) => ({ ...asset, path: NodePath.join(build.directory, asset.name) })),
    );
    const sums =
      files
        .filter((file) => file.name.endsWith(".tar.gz"))
        .map((file) => `${file.sha256}  ${file.name}`)
        .join("\n") + "\n";
    const sumsPath = NodePath.join(staging, "SHA256SUMS");
    await NodeFSP.writeFile(sumsPath, sums);
    files.push({ name: "SHA256SUMS", sha256: await hashFile(sumsPath, "sha256"), path: sumsPath });
    for (const file of files) {
      const existing = release.assets.find((asset) => asset.name === file.name);
      if (existing) {
        if (
          existing.digest !== `sha256:${file.sha256}` ||
          existing.size !== (await NodeFSP.stat(file.path)).size
        )
          throw new Error(`Refusing to overwrite a different remote asset: ${file.name}`);
      } else gh(["release", "upload", tag, file.path, "--repo", CLI_RELEASE_REPOSITORY]);
    }
    release = readRelease();
    if (!release.draft || release.prerelease || release.target_commitish !== commit)
      throw new Error("Draft release changed during upload.");
    if (release.assets.length !== files.length)
      throw new Error("Draft contains unexpected or missing assets.");
    for (const file of files) {
      const asset = release.assets.find((candidate) => candidate.name === file.name);
      if (
        asset?.digest !== `sha256:${file.sha256}` ||
        asset.size !== (await NodeFSP.stat(file.path)).size
      )
        throw new Error(`Remote upload verification failed: ${file.name}`);
    }
    if (!draftOnly)
      gh([
        "release",
        "edit",
        tag,
        "--repo",
        CLI_RELEASE_REPOSITORY,
        "--draft=false",
        "--prerelease=false",
        "--latest",
      ]);
    process.stdout.write(
      `${draftOnly ? "Uploaded verified draft" : "Published"}: https://github.com/${CLI_RELEASE_REPOSITORY}/releases/tag/${tag}\n`,
    );
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "string" },
      ref: { type: "string" },
      dir: { type: "string" },
      notes: { type: "string" },
      targets: { type: "string", default: defaultTargets.join(",") },
    },
  });
  const [command] = positionals;
  const version = values.version;
  if (!version || !values.dir || positionals.length !== 1)
    throw new Error(
      "Usage: fork-release.ts <build|validate|upload|publish> --version VERSION --dir OUTPUT [--ref COMMIT] [--notes FILE] [--targets darwin-arm64,linux-x64]",
    );
  const directory = NodePath.resolve(values.dir);
  const targets = values.targets.split(",").map((target) => decodeTarget(target));
  if (targets.length === 0 || new Set(targets).size !== targets.length)
    throw new Error("Provide distinct release targets.");
  if (command === "build") {
    const host = await Effect.runPromise(
      Effect.gen(function* () {
        return { platform: yield* HostProcess.Platform, arch: yield* HostProcess.Architecture };
      }),
    );
    await build(version, values.ref ?? "HEAD", directory, host);
  } else if (command === "validate") {
    const builds = await validateRelease(directory, version, targets);
    process.stdout.write(`Verified ${version} at ${builds[0]!.commit}: ${targets.join(", ")}\n`);
  } else if ((command === "upload" || command === "publish") && values.notes)
    await publish(directory, version, values.notes, command === "upload", targets);
  else
    throw new Error(
      "Choose build, validate, upload or publish; upload/publish require --notes FILE.",
    );
}
