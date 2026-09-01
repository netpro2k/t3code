// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const runInstaller = (scriptPath: string, sourceDir: string, homeDir: string) =>
  NodeChildProcess.spawnSync("bash", [scriptPath, sourceDir, homeDir], {
    encoding: "utf8",
  });

it.layer(NodeServices.layer)("install-user-agent-skill", (it) => {
  it.effect("installs the complete skill into both user roots and updates it idempotently", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const scriptPath = path.join(repoRoot, "scripts/install-user-agent-skill.sh");
      const fixtureRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-install-" });
      const homeDir = path.join(fixtureRoot, "home");
      const sourceDir = path.join(fixtureRoot, "source/manage-t3-threads");

      yield* fs.makeDirectory(path.join(sourceDir, "agents"), { recursive: true });
      yield* fs.makeDirectory(path.join(sourceDir, "references"), { recursive: true });
      yield* fs.makeDirectory(homeDir, { recursive: true });
      yield* fs.writeFileString(path.join(sourceDir, "SKILL.md"), "version one\n");
      yield* fs.writeFileString(path.join(sourceDir, "agents/openai.yaml"), "interface: {}\n");
      yield* fs.writeFileString(path.join(sourceDir, "references/usage.md"), "usage\n");

      const firstInstall = yield* Effect.sync(() => runInstaller(scriptPath, sourceDir, homeDir));
      assert.equal(firstInstall.status, 0, firstInstall.stderr);

      const destinations = [
        path.join(homeDir, ".agents/skills/manage-t3-threads"),
        path.join(homeDir, ".claude/skills/manage-t3-threads"),
      ];
      for (const destination of destinations) {
        assert.equal(yield* fs.readFileString(path.join(destination, "SKILL.md")), "version one\n");
        assert.equal(
          yield* fs.readFileString(path.join(destination, "agents/openai.yaml")),
          "interface: {}\n",
        );
        assert.equal(
          yield* fs.readFileString(path.join(destination, "references/usage.md")),
          "usage\n",
        );
      }

      yield* fs.writeFileString(path.join(destinations[0]!, "user-note.md"), "preserve me\n");
      yield* fs.writeFileString(path.join(sourceDir, "SKILL.md"), "version two\n");

      const secondInstall = yield* Effect.sync(() => runInstaller(scriptPath, sourceDir, homeDir));
      assert.equal(secondInstall.status, 0, secondInstall.stderr);
      for (const destination of destinations) {
        assert.equal(yield* fs.readFileString(path.join(destination, "SKILL.md")), "version two\n");
      }
      assert.equal(
        yield* fs.readFileString(path.join(destinations[0]!, "user-note.md")),
        "preserve me\n",
      );
    }),
  );

  it.effect("preflights both roots before refusing a symlinked skill destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const scriptPath = path.join(repoRoot, "scripts/install-user-agent-skill.sh");
      const fixtureRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-preflight-" });
      const homeDir = path.join(fixtureRoot, "home");
      const sourceDir = path.join(fixtureRoot, "source/manage-t3-threads");
      const agentsDestination = path.join(homeDir, ".agents/skills/manage-t3-threads");
      const claudeSkillsRoot = path.join(homeDir, ".claude/skills");
      const claudeDestination = path.join(claudeSkillsRoot, "manage-t3-threads");
      const symlinkTarget = path.join(fixtureRoot, "outside");

      yield* fs.makeDirectory(sourceDir, { recursive: true });
      yield* fs.makeDirectory(agentsDestination, { recursive: true });
      yield* fs.makeDirectory(claudeSkillsRoot, { recursive: true });
      yield* fs.makeDirectory(symlinkTarget, { recursive: true });
      yield* fs.writeFileString(path.join(sourceDir, "SKILL.md"), "new contents\n");
      yield* fs.writeFileString(path.join(agentsDestination, "SKILL.md"), "old contents\n");
      yield* fs.symlink(symlinkTarget, claudeDestination);

      const install = yield* Effect.sync(() => runInstaller(scriptPath, sourceDir, homeDir));

      assert.equal(install.status, 1);
      assert.match(install.stderr, /Refusing to replace symlinked skill directory/);
      assert.equal(
        yield* fs.readFileString(path.join(agentsDestination, "SKILL.md")),
        "old contents\n",
      );
      assert.isFalse(yield* fs.exists(path.join(symlinkTarget, "SKILL.md")));
    }),
  );

  it.effect("keeps both updater integrations ordered before service replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const installerPath = path.join(repoRoot, "scripts/install-user-agent-skill.sh");
      const linuxPath = path.join(repoRoot, "scripts/update-linux.sh");
      const macPath = path.join(repoRoot, "scripts/update-mac.sh");

      const syntax = yield* Effect.sync(() =>
        NodeChildProcess.spawnSync("bash", ["-n", installerPath, linuxPath, macPath], {
          encoding: "utf8",
        }),
      );
      assert.equal(syntax.status, 0, syntax.stderr);

      const integrations = [
        { path: linuxPath, stopMarker: "systemctl --user stop t3code.service" },
        { path: macPath, stopMarker: 'stop_launchd_service "$service_target"' },
      ];
      for (const integration of integrations) {
        const source = yield* fs.readFileString(integration.path);
        const shimIndex = source.indexOf('install_user_t3_shim "$server_entry"');
        const installerIndex = source.indexOf("scripts/install-user-agent-skill.sh");
        const stopIndex = source.indexOf(integration.stopMarker);

        assert.isAtLeast(shimIndex, 0);
        assert.isAbove(installerIndex, shimIndex);
        assert.isAbove(stopIndex, installerIndex);
        assert.equal(source.match(/scripts\/install-user-agent-skill\.sh/g)?.length, 1);
        assert.include(source, "apps/server/resources/skills/manage-t3-threads");
      }
    }),
  );
});
