import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveFileName,
  cliArchiveTarCommand,
  cliReleaseIndexPageUrl,
  cliReleaseHasArchive,
  isForkReleaseVersion,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-netpro2k.2", draft: true },
      { tag_name: "v1.2.3-netpro2k.1" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3-netpro2k.1");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });

  it("only accepts unique fork revisions as stable update targets", () => {
    expect(isForkReleaseVersion("1.2.3-netpro2k")).toBe(true);
    expect(isForkReleaseVersion("1.2.3-netpro2k.1")).toBe(true);
    for (const version of [
      "1.2.3",
      "1.2.3-fork.1",
      "1.2.3-netpro2k.0",
      "1.2.3-netpro2k.01",
      "1.2.3-nightly.20261029.1",
    ]) {
      expect(isForkReleaseVersion(version)).toBe(false);
    }
    expect(newestCliReleaseVersion([{ tag_name: "v9.0.0" }], "stable")).toBeUndefined();
  });

  it("requires matching published archive assets for the destination platform", () => {
    const version = "1.2.3-netpro2k.1";
    const release = {
      tag_name: `v${version}`,
      draft: false,
      assets: [{ name: "SHA256SUMS" }, { name: cliArchiveFileName(version, "linux-x64") }],
    };
    expect(cliReleaseHasArchive(release, version)).toBe(true);
    expect(cliReleaseHasArchive(release, version, "linux-x64")).toBe(true);
    expect(cliReleaseHasArchive(release, version, "darwin-arm64")).toBe(false);
    expect(cliReleaseHasArchive({ ...release, draft: true }, version)).toBe(false);
    expect(cliReleaseHasArchive({ ...release, tag_name: "v9.0.0" }, version)).toBe(false);
    expect(cliReleaseHasArchive({ ...release, assets: release.assets.slice(1) }, version)).toBe(
      false,
    );
    expect(cliReleaseHasArchive({ ...release, assets: release.assets.slice(0, 1) }, version)).toBe(
      false,
    );
  });

  it("pages through the release index at the largest page GitHub allows", () => {
    expect(cliReleaseIndexPageUrl(1)).toBe(
      "https://api.github.com/repos/netpro2k/t3code/releases?per_page=100&page=1",
    );
    expect(cliReleaseIndexPageUrl(3)).toContain("page=3");
  });
});
