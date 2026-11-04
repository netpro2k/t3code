# Release Runbook

## This fork: native builds and GitHub-hosted updates

This fork uses `netpro2k/t3code` releases for desktop and server updates. npm and
upstream publication do not make an update available. CI is optional: the release
command builds on the Mac and Linux hosts and publishes through `gh`.

Use `0.1.4-netpro2k` for the audited stack on upstream `v0.1.4`; additional builds
use `.1`, `.2`, and so on. Never reuse a published version. Despite the SemVer
suffix, these are regular GitHub releases marked latest, with `latest*.yml`
manifests. GitHub prereleases are not the fork's stable update feed.

### Build and publish

Commit the audited patch stack, run `vp run check:changed`, and push the exact
commit to the fork. Select the Node version pinned in that commit's root
`package.json` on both build machines. Native builds need the same platform tools
as the existing desktop builder, including Rust. macOS automatic updates need a
consistent certificate signature. On Studio, set up the private local identity once:

```sh
bash scripts/fork-signing.sh setup
source "$HOME/.config/t3code/signing/environment.sh"
```

Setup generates a 3072-bit RSA signing key and an independent random 256-bit unlock
password using OpenSSL's cryptographic randomness. It verifies two different signed
executables against the same designated certificate requirement. Private material
stays outside the checkout in an owner-only directory: the keychain, encrypted
PKCS#8 backup, and password files are never release assets. Keep a secure backup of
that directory; recreating the certificate would require another manual Desktop
installation. The release command unlocks only this dedicated keychain, with its
password sent over stdin. It does not need access to the login keychain.

`T3CODE_CLI_MAC_SIGN_IDENTITY` selects the same certificate for Desktop and the server
archive, and `CSC_KEYCHAIN` selects its keychain. The packaged signature contains the
public certificate and is checked against the configured fingerprint. For these
personal builds, notarization and restricted passkey entitlements remain optional.
To notarize with an Apple Developer ID certificate, provide `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. To enable restricted passkey entitlements,
also configure the profile, team, and RP domains required by the desktop builder.
Use absolute paths for keychain, API key and profile files. Do not commit private
signing configuration or copy it into build staging.

The builder carries only the public Clerk key, JWT template, CLI OAuth client ID,
and relay URL from the checkout's environment files into the disposable worktree.
Use the same public configuration on both hosts; publication checks its fingerprint
as well as the source commit. Signing configuration comes from exported environment
variables, not copied private configuration files.

Linux builds need `patchelf` and the installed `libatomic.so.1` package. The archive
bundles that library with its license and the package source reference from dpkg
(Ubuntu) or pacman (Arch Linux).
These private releases target oma and Studio. Fork Linux builds use the build
host's glibc as their compatibility ceiling and retain the measured requirement
in the build log and DEB dependency; non-fork builds keep upstream's 2.39 ceiling.

Run this on each native host, passing the same exact commit and version:

```sh
node scripts/fork-release.ts build --version 0.1.4-netpro2k \
  --ref <patched-commit-sha> --dir /absolute/path/t3-releases/0.1.4-netpro2k
```

The command uses a disposable worktree beside the checkout and leaves the working
install alone. It builds the desktop (Mac DMG plus updater ZIP; Linux AppImage plus
DEB), builds the standalone server archive, smoke-tests that archive against isolated
state, and verifies the desktop manifest's version, sizes, and SHA-512 digests.
Mac builds verify the packaged app's signature; notarized builds also pass Gatekeeper assessment. The
output contains one directory per native target and a `build.json` receipt binding
its assets to the source commit. Default release targets are `darwin-arm64` and
`linux-x64`; an additional native Linux ARM64 build can be included with
`--targets darwin-arm64,linux-x64,linux-arm64` on validation and publication.

Copy the complete target directories into one release directory, preserving their
receipts. Linux AppImages keep upstream's versionless filenames for in-place
updates; the release tag and receipts identify the immutable candidate. With `gh`
authenticated for write access to the fork:

```sh
node scripts/fork-release.ts validate --version 0.1.4-netpro2k --dir /path/to/release
node scripts/fork-release.ts upload --version 0.1.4-netpro2k --dir /path/to/release \
  --notes /path/to/release-notes.md
node scripts/fork-release.ts publish --version 0.1.4-netpro2k --dir /path/to/release \
  --notes /path/to/release-notes.md
```

`upload` creates or resumes a draft. `publish` can also do the entire upload in one
command. Both require all selected targets from one commit, generate `SHA256SUMS`
for the server archives, upload only recognized artifacts, and verify GitHub's
asset digests before proceeding. A different existing asset is never overwritten;
use a new revision instead. Debug configs, unpacked apps, credentials, and receipts
are not uploaded. Publication makes the completed release available to clients;
it does not force an installation on running machines.

### One-time rollout from the source-run install

The existing `update-mac.sh` and `update-linux.sh` build/install from the checkout.
They do not publish releases, assign fork revisions, or install the service launcher
needed by remote server updates. Do not use them to bootstrap the release channel.

For the first rollout, prepare both published packages before stopping anything:

1. Before launching Desktop with the new setup, turn **Local environment OFF** in
   Settings → Connections. Download and verify the fork CLI archive against the
   published `SHA256SUMS` and stage the matching desktop package. Preserve the current app and service files
   for recovery, and arrange database backup while the service is stopped.
2. Hand the cutover to an OS-owned process outside the running server, using the
   existing detached-cutover helpers as the model. Quit Desktop, stop the exact
   old service, and confirm its recorded PID has exited. On Mac, unload both the
   fork's `com.netpro2k.t3code.server` job and any legacy
   `com.t3tools.t3code.service` job before installing the launcher.
3. Preserve the existing T3 home, provider PATH, and Tailscale HTTPS port 8443.
   The launcher reads optional `<T3 home>/service.env`; configure
   `T3CODE_TAILSCALE_SERVE=true` and `T3CODE_TAILSCALE_SERVE_PORT=8443` there.
4. Install the released executable with `t3 service install --base-dir <T3 home>`,
   and repoint the CLI shim to the release installation. The native service
   installer uses `t3code.service` on Linux and `com.t3tools.t3code.service` on Mac.
5. Install the signed Mac app in Applications and the Linux AppImage at its stable
   writable path. Pair the background service as a saved connection using
   `t3 pair --base-dir <T3 home>` and open its pairing URL in Desktop. Verify the
   server advertises `serverSelfUpdate: boot-service`, both client and server report
   the fork version, and Desktop connects to the service as a saved environment.

Run the initial migration from raw Codex outside the server being replaced, or hand
it to an OS-owned detached process. The source installers are not a release bootstrap.
Saved connections use ordinary paired credentials. Re-pair with `t3 pair` when
credentials expire. Desktop and the service must use the same T3 home for local
Finder/reveal and editor actions. Browser tools use the server's Chromium stream;
configure its separate browser profile and sign-ins as needed.

### Subsequent updates

The nightly T3 task uses [prepare-fork-release](../../.agents/skills/prepare-fork-release/SKILL.md)
to check the latest published upstream stable release, audit/rebase in its own
worktree, and prepare both native builds as a draft. One durable claim under the
shared Git directory prevents overlapping candidates, including while a draft
awaits approval. Preparation chooses recommended patch drops and build adaptations within the
private two-host target, then reports their tradeoffs with the tested draft for the final
upgrade decision. A requested revision is rebuilt before approval. No-update runs archive themselves; ready drafts and failures stay
visible in pinned threads. Later runs remove recorded clean worktrees only after
their threads are archived and stopped.

Approval publishes the exact verified draft and replaces `main` with its audited
commit using an exact force-with-lease. It does not merge the old patch history,
rebase again, or install into running clients/servers. Keep build receipts and
artifacts until publication. The same skill can resume interrupted preparation or
publication; ambiguous rebase decisions still require the user.

Clients discover the new desktop release from the fork feed. Update Everything
updates launcher-managed servers separately, waits for their restart, then installs
and relaunches Desktop. The server independently rejects upstream-only targets,
unpublished releases, or releases missing its archive/checksums before cache reuse
or launcher handoff. The official mobile client remains unchanged and cannot force
a standalone fork server onto an upstream build.

Test the first upgrade from `0.1.4-netpro2k` to the next fork release on both machines:
server handoff/reconnect, desktop replacement/relaunch, preserved local file actions,
and rejection of an upstream-only server target. Repeat with `.1` to test a rebuild
of the same upstream version. Keep Mac signing identity and app identity consistent.

The sections below describe upstream's inherited stable/nightly workflow as reference.

Unified release workflow: `.github/workflows/release.yml`. Beta is a product label, not a release channel—channels remain `stable` and `nightly` (plus `preview` for maintainer test builds).

## Channels and triggers

- **Stable (`channel=stable` on `main`, or pushing a `vX.Y.Z` tag):** Manual dispatch promotes the **latest published nightly commit** (not `main` HEAD) using its base version unless overridden. Pushing a `vX.Y.Z` tag ships that exact commit. Finalization commits version bumps to `main` using `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`.
- **Nightly (scheduled every 30 min when new commits exist and >=6 h elapsed, or manual `channel=nightly` on `main`):** Publishes a GitHub prerelease, `nightly` desktop updater channel, `nightly` npm dist-tag, hosted `nightly` web alias, and marketing site. Does not bump versions on `main`.
  - Pause/resume automatic nightlies: `gh variable set PAUSE_NIGHTLY -b true -R pingdotgg/t3code` / `gh variable delete PAUSE_NIGHTLY -R pingdotgg/t3code`.
- **Preview (`channel=preview`, any branch—default dispatch channel):** Exercises build, signing, notarization, and smoke tests into a **draft** GitHub release and skips npm, web, AUR, and announcements. **Never publish a preview draft or push a test tag**—there is no dry-run tag path (any non-nightly `v*` tag publishes stable), and published preview tags hide nightlies from the update feed. Rebase onto `main` before dispatching `preview`.
- **PR macOS previews:** Applying the `preview:mac` label triggers a two-workflow split (`desktop-macos-preview.yml` builds the untrusted JS bundle; `desktop-macos-preview-publish.yml` checks author trust against `main`'s `.github/VOUCHED.td`, packages/signs using `main`, and publishes to rolling `desktop-preview`). One-shot per commit; label is removed automatically.

## Critical release invariants

- **Server self-update ordering:** Connected servers update to the exact client version by downloading the GitHub Release CLI archive (or `npx t3@<version>`). Keep the release graph order strictly: `release` (CLI archives + `SHA256SUMS` + desktop installers) → `publish_cli` (`t3` npm launcher) → `deploy_web` (hosted channel alias). Never publish clients before the archives and npm launcher exist.
- **Standalone CLI archives & Node pin:** `engines.node` in root `package.json` must stay exact (Node SEA builds reject mismatches). There is no macOS x64 CLI archive (SEA is unsupported there; x64 desktop uses Electron).
- **Smoke fixture:** `scripts/fixtures/desktop-launch` is intentionally an old SQLite snapshot to verify forward migrations on packaged builds—never regenerate it on schema changes.
- **Hosted web & marketing:** Vercel Git auto-deployments stay disabled (`apps/{web,marketing}/vercel.ts`). Releases build with `--skip-domain` and alias `app.t3.codes` / `latest.app.t3.codes` (stable) or `nightly.app.t3.codes` + marketing (nightly) only after publication.

## Update feed

Nightly installs check `releases.atom` (the 10 newest git tags), then the `update-feed` release's `nightly.json` pointer, then the GitHub API as fallback. **Never delete the `update-feed` release.**

- If `Check the update feed` fails because stray/preview tags pushed the newest nightly out of `releases.atom`, delete the unneeded tags (`git push origin :refs/tags/<tag>`—converting a release to draft keeps its tag).
- **To pull a bad nightly:** delete its release and tag, run `gh release delete-asset update-feed nightly.json` (so installs fall back until the next tick rewrites it), and move npm's `nightly` dist-tag back with `npm dist-tag add t3@<last-good> nightly`.

## T3 Connect relay deployment

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` on every push to `main`. See [infra/relay/README.md](../../infra/relay/README.md#deployment-ci) for required variables/secrets. Keep `.env.example` in sync with `production` public identifiers so preview builds work off non-`main` branches. After editing a secret/variable, manually run **Deploy T3 Connect relay** (with `force` unchecked).

Labeling a same-repo PR `relay:preview` deploys stage `pr-<number>` (cleaned up on unlabel/close).

### Managed tunnel cleanup rollout

`RELAY_TUNNEL_CLEANUP_MODE` and `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` accept `off` (default), `dry-run`, or `enabled` and take effect on the next relay deploy (without `force`). Monitor `relay.managed_endpoint_reaper.sweep` spans in Axiom. To stop cleanup during an incident, set the mode to `off` and redeploy the relay.

## Mobile releases

- **iOS TestFlight / App Store:** Merges to `main` publish compatible OTAs and build TestFlight prereleases (`testflight` profile at `3.0.0`). To cut an App Store build, dispatch **Mobile EAS Production** (`mode=build`, `profile=production`, `platform=ios`, explicit version). Before shipping `3.0.0` to the App Store, advance `build.testflight.env.T3CODE_MOBILE_VERSION` in `apps/mobile/eas.json` to the next unreleased major.
- **Android APK mirror:** `.github/workflows/mobile-android-apk.yml` polls Google Play Alpha hourly and mirrors new Play-signed universal APKs to `android-beta-<build-number>` prereleases (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`). Nightlies attach the latest internal-testing APK when available.

## Windows payload topology and update validation

Windows packages the bundled server and its unpacked native modules in `resources/server.asar` (+ `server.asar.unpacked`) and embeds the matching-architecture Linux CLI archive as `resources/wsl-runtime.tar.gz` + SHA-256 sidecar (passed via `--wsl-runtime`). Avoid whole-package smart unpacking (keeps unpacked file counts and NSIS differential blockmaps bounded). `scripts/build-desktop-artifact.ts` enforces all structural, native-load, and WSL archive checks at build time.

## One-time credentials setup

### npm OIDC trusted publishing

Configure `t3` on npm with GitHub Actions Trusted Publishing for `.github/workflows/release.yml` (the workflow publishes only the `t3` launcher tarball via `npm publish --provenance`). Set the publisher's environment to `production`, which `publish_cli` declares.

### Apple signing and notarization (macOS)

- **Secrets:** `CSC_LINK` (base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (raw `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE` (base64 profile for `com.t3tools.t3code` with Associated Domains).
- **Variables:** `APPLE_TEAM_ID`, optional `CLERK_PASSKEY_RP_DOMAINS`.
- The packager only enables passkey entitlements (`keychain-access-groups`, `com.apple.developer.web-browser.public-key-credential`) present in the provisioning profile; regenerate and re-upload `MACOS_PROVISIONING_PROFILE` after Apple approves managed capabilities. Complete Clerk AASA setup per [Connect setup](./02_connect-setup.md#desktop-passkeys).

### Azure Trusted Signing (Windows)

Set secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` with an Entra service principal granted Trusted Signing permissions.

## Ongoing stable release checklist

1. Verify the latest nightly (desktop launch, `npm view t3@<version> version`, remote server update + DB migration smoke test).
2. Dispatch **Release** on `main` with `channel=stable` (leave `version` blank unless overriding the nightly's base version).
3. Confirm `Resolve release commit` matches the verified nightly, then verify `release` → `publish_cli` → `deploy_web` all succeed.
4. Smoke-test the published artifacts.
