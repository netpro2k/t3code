---
name: maintain-patch-stack
description: Author, audit, and rebase this fork's self-contained `[PATCH]` commit stack onto an exact upstream release, ref, or the latest upstream/main. Use when creating or revising a fork-only commit, syncing or pulling upstream changes, resolving rebase conflicts, checking whether upstream supersedes a patch, or reviewing upstream changes for semantic conflicts with fork behavior.
---

# Maintain Patch Stack

Keep `main` as a linear sequence of fork-owned `[PATCH]` commits rebased onto the upstream target the user requested. An explicit version means that exact stable tag; use `upstream/main` only when no version, tag, commit, or branch was named. Run commands from the repository root and obey the repository's `AGENTS.md` safety and verification rules.

## Author a patch commit

1. Confirm the worktree state and identify the intended patch boundary. Preserve unrelated user changes.
2. Make one independently understandable feature or behavior change. Include its focused tests and user-facing documentation in the same commit.
3. Minimize future conflicts:
   - Prefer the smallest complete change and existing extension points.
   - Avoid unrelated formatting, renames, generated churn, or dependency updates.
   - Keep cross-surface or cross-provider changes together when they are required for one behavior.
   - Do not split contracts from the clients and server that consume them.
4. Recover intent from the implementation thread and the final diff. Do not invent requirements that were not established.
5. Create the commit with this structure:

   ```text
   [PATCH] <short one-line description>

   Intent:
   <why this patch exists and the user-visible outcome>

   Behavior:
   - <important behavior and edge cases>

   Design constraints:
   - <choices that future conflict resolution must preserve>

   Integration:
   - <affected clients, providers, contracts, storage, or docs>

   Verification:
   - <focused checks performed>

   Rebase notes:
   - <likely conflict hotspots and criteria for deciding upstream supersedes it>
   ```

   Omit a section only when it truly has no useful content. Keep the subject imperative, specific, and short. The body is durable design context, not a file-by-file changelog.

6. Inspect the staged diff and message before committing. Verify that the commit contains only its stated concern.

Do not create a separate commit-writing skill. This workflow owns both commit consistency and rebasing so the format and audit criteria cannot drift.

## Rebase onto an upstream target

1. Run read-only discovery and resolve the target before auditing:

   ```bash
   git status --short --branch
   git remote -v
   git fetch upstream --tags
   ```

   - If the request names a stable version such as `0.0.37`, set `TARGET_REF` to the exact canonical tag (`refs/tags/v0.0.37`) and resolve its peeled commit after fetching. Never substitute `upstream/main`, a nightly/prerelease tag, or another tag with a similar version.
   - If the user names another tag, branch, or commit, resolve that exact object as `TARGET_REF`.
   - Only an unversioned request such as “sync with upstream” defaults `TARGET_REF` to `upstream/main`.
   - Fail clearly if the requested target does not exist or is ambiguous. Do not silently choose a moving branch.

   Then run discovery against the literal resolved target:

   ```bash
   git rev-parse 'TARGET_REF^{}'
   git merge-base HEAD TARGET_REF
   git log --reverse --format='%H %s' TARGET_REF..HEAD
   git cherry TARGET_REF HEAD
   ```

   Replace `TARGET_REF` with the resolved ref in actual commands. Require a clean worktree. If there are unrelated changes, do not stash, discard, or absorb them without the user's direction. Confirm that `upstream` is the canonical repository and `origin` is the fork. Never expose credentials.

2. Record the exact hashes printed by the first two commands. Replace the descriptive placeholders in the third command with those literal values and a current timestamp, then create the backup before rewriting history:

   ```bash
   git merge-base HEAD TARGET_REF
   git rev-parse HEAD
   git branch patch-stack-backup/YYYYMMDD-HHMMSS OLD_TIP
   ```

3. Establish separate rewrite and product-report baselines before auditing:
   - The **rewrite range** is `old_base..TARGET_REF`. It explains which commits are mechanically new to this rebase and supplies the old side of the final `range-diff`.
   - The **product-report range** answers the user's requested upgrade. When the request names a stable version, resolve its exact tag and find the latest stable release tag (not a nightly or prerelease tag) already contained by `OLD_TIP`. Use that contained release as the report base so upgrades spanning multiple releases include the complete product delta. If no stable release tag is contained, use `old_base` and state that fallback.
   - If `OLD_TIP` already contains the requested release, say so. Use the nearest lower stable release tag to summarize the named release itself, and report the current rewrite range separately; do not imply that this turn introduced release content already present.
   - An exact release target excludes every descendant after that tag, even when `upstream/main` is ahead. Record the count and tip of newer upstream commits as deliberately not included; do not describe them as branch additions.
   - When no release or other product baseline is named, use `old_base..TARGET_REF` for both purposes.
   - Patch supersession is not bounded by either range. An upstream replacement may have landed before `old_base` and left a stale fork patch in the stack.
4. Audit every patch semantically before rebasing:
   - Read every `[PATCH]` message and its diff in oldest-first order.
   - Before running any rebase, create a pre-rebase audit ledger in working notes outside the repository and send the user a concise classification summary. Include one row per patch with: patch hash/subject, current fork delta, exact external production consumer or independently invoked artifact, relevant upstream/history evidence, classification, and planned action (`replay`, `shrink`, `drop`, or `stop for decision`). An ordinary source file, exported symbol, or defining module is not itself a production entry point. Consumer evidence must name a different production file or an explicit route, package, CLI, build, or runtime registration that loads it. Do not proceed while any evidence cell is blank or merely says that the patch applies cleanly.
   - Treat patch-message claims as intent and evidence pointers, not proof of the current tree. For every Behavior, Design constraint, and Integration claim, trace the current diff to reachable production use. Search imports, callers, registrations, build or packaging entry points, scripts, and relevant tests. A surviving helper or passing test alone does not prove user-visible behavior; code with no production path is a candidate for removal unless its standalone or dynamic entry point is demonstrated.
   - Read upstream changes since `old_base` for new conflicts, then search all relevant upstream history for semantic replacements even when they predate `old_base`. Follow PR numbers, commit hashes, and phrases such as `backport`, `former`, `remaining`, `until upstream`, or `superseded` in patch messages.
   - Treat a patch as a **supersession trigger** when its message references an upstream PR/commit, says that upstream already replaced part of it, describes a backport or temporary implementation, or preserves only a `remaining`/`former` delta. For every triggered patch, recover earlier forms from backup refs or repository history, compare the original behavior with upstream, and trace every current changed symbol outside its defining file and tests. Record those concrete results in the ledger.
   - A patch-specific instruction such as `drop only when ...` applies only after current production reachability is proven. It does not justify retaining dead residual code or a behavior whose upstream architecture removed the need. If no production path, standalone entry point, dynamic registration, or packaging consumer can be demonstrated, do not classify the patch as still needed; drop it when the behavior is obsolete/superseded, or stop for a decision when the consequence remains genuinely unclear.
   - For every planned `shrink`, audit the proposed residual independently from the original patch. After rewriting it, regenerate that ledger row from the final diff and run a repository-wide `rg` or `git grep` for each retained symbol/path, excluding its definition and tests. Reachability from removed hunks cannot justify the residual. A definition-only search result means there is no direct consumer; retain it only with concrete dynamic-loading evidence, otherwise drop the residual or stop for a decision.
   - Treat `git cherry` and an unchanged `git range-diff` entry as mechanical signals only. They do not prove that a patch is reachable, useful, or absent from upstream.
   - For each patch, classify it as still needed, partly superseded, fully superseded, or design-conflicting.
   - Check all applicable clients, providers, contracts, reverse states, connection modes, tests, and docs. Upstream may implement the headline while missing a constraint preserved in the patch body.
   - Before retaining a patch, identify the concrete production behavior or independently invoked artifact that would disappear if the patch were dropped. Before declaring it fully superseded, show how upstream supplies that behavior or removes the need for it.
   - Tests validate behavior after classification; they are not evidence that a patch is necessary. Do not substitute broad test counts for the per-patch ledger.
5. Only after the ledger is complete, run `git rebase TARGET_REF` and enact its planned action for every patch. Resolve conflicts in the patch currently being replayed, preserving its documented intent while adopting upstream structure and naming. Keep resolutions narrowly scoped. For an exact release request, verify the new first parent/base resolves to the tag commit before continuing.
6. When upstream has fully superseded a patch, drop it only after verifying parity against the patch's Intent, Behavior, Design constraints, and Integration sections. A different upstream architecture may remove the need for a residual hunk without reproducing that hunk literally; verify reachability and user-visible outcome, not textual similarity. Record the evidence in the final report. If only part is upstream, retain a smaller patch and update its message to describe the remaining delta.
7. When an upstream change creates a design conflict without a mechanically correct answer, stop at that patch, preserve the rebase and backup state, and ask the user to choose between the concrete behaviors. Do not hide the conflict behind compatibility machinery.
8. After each resolved patch, run the smallest focused tests that cover the resolution. Before handoff, inspect the complete result:

   ```bash
   git range-diff OLD_BASE..OLD_TIP TARGET_REF..HEAD
   git log --reverse --format='%H%n%B%n---' TARGET_REF..HEAD
   git status --short --branch
   ```

   Confirm `git merge-base HEAD TARGET_REF` equals the resolved target commit. Confirm every remaining fork commit starts with `[PATCH]`, contains durable intent, and still represents one concern. Regenerate ledger rows for every shrunk or conflict-resolved patch from its final diff, compare the final stack with the pre-rebase ledger, and explain any changed classification. Recheck that every retained patch has an exact external production consumer or independently invoked artifact; do not infer this from a source definition, passing tests, or a clean replay. Ensure the worktree is clean.

9. Finish with a user-oriented upgrade report, not a commit-by-commit changelog:
   - **What's new from upstream:** Open with the stable release actually contained by `OLD_TIP`, the exact selected target and resolved commit, and whether the target was already present. Summarize the user-visible features and fixes in the product-report range, not merely the commits newly fetched or replayed. When targeting a release tag, state that newer `upstream/main` commits were deliberately excluded.
   - **Patch-stack update:** Identify patches that were changed, partly superseded, fully superseded, or found to design-conflict during the complete semantic audit. Include replacements that landed before `old_base`, and say when the operation removed a patch that was already stale at the start. For every shrunk patch, name the exact external production consumer for the retained residual; if none exists, the patch cannot be reported as retained behavior. Explain the user-visible behavior removed or retained and the evidence for each supersession decision. Do not repeat the functionality of patches that replayed unchanged; summarize those with a count or a single status sentence only after validating their reachability and necessity. Say explicitly when no patches were obviated in part or in full.
   - **Rebase details:** Report the requested target ref and resolved commit, new base and tip, conflict resolutions, semantic risks reviewed, focused verification, backup branch, clean-worktree status, and whether rewritten history was pushed.

   Base the report on the audited diffs, reachable behavior, patch history, and the explicit product-report range, not commit subjects or `range-diff` alone. Make it useful to someone deciding what changed in the product and which fork deltas still require maintenance.

   Do not delete the backup or push rewritten history unless the user explicitly asks. If authorized to update the fork, use `git push --force-with-lease`, never an unconditional force push.

## Resolve interruptions safely

- Inspect `git status` and the current patch before acting.
- Use `git rebase --continue` after a verified resolution.
- Use `git rebase --skip` only for a patch proven fully superseded or empty.
- Use `git rebase --abort` when the chosen strategy is invalid; the backup branch remains the recovery point.
- Never rewrite upstream commits or mix a new feature into a conflict resolution.
