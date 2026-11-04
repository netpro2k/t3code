import json
import multiprocessing
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import release_state as state


def concurrent_claim(directory, owner, barrier, results):
    directory = Path(directory)
    barrier.wait()
    with state.coordination_lock(directory):
        results.put(state.claim(directory / "pending.json", {"owner": owner, "stage": "preparing"}))


class ReleaseStateTests(unittest.TestCase):
    def test_stable_release_selection_rejects_nonstable_and_downgrades(self):
        release = {"tag_name": "v0.1.10", "draft": False, "prerelease": False}
        self.assertTrue(state.needs_release(release, ["v0.1.9", "v0.1.9-netpro2k.2"]))
        self.assertFalse(state.needs_release(release, ["v0.1.10"]))
        self.assertFalse(state.needs_release(release, ["v0.2.0"]))
        for patch in ({"draft": True}, {"prerelease": True}, {"tag_name": "v0.1.11-nightly"}, {"tag_name": "v0.1.11;bad"}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                state.needs_release({**release, **patch}, [])

    def test_concurrent_runs_share_one_durable_owner_and_resume_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            context = multiprocessing.get_context("fork")
            barrier = context.Barrier(2)
            results = context.Queue()
            processes = [context.Process(target=concurrent_claim, args=(temporary, owner, barrier, results)) for owner in ("first", "second")]
            for process in processes:
                process.start()
            outcomes = [results.get(), results.get()]
            for process in processes:
                process.join()
                self.assertEqual(process.exitcode, 0)
            self.assertEqual(sorted(result["status"] for result in outcomes), ["busy", "claimed"])
            current = json.loads((directory / "pending.json").read_text())
            with state.coordination_lock(directory):
                resumed = state.claim(directory / "pending.json", {"owner": current["owner"], "stage": "replacement"})
            self.assertEqual(resumed["status"], "resume")
            self.assertEqual(resumed["stage"], "preparing")
            with self.assertRaises(ValueError):
                state.owned(directory / "pending.json", "another")

    def test_pending_owner_cannot_retire_before_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            pending = directory / "pending.json"
            state.write_json(pending, {"owner": "owner", "stage": "ready"})
            with self.assertRaises(ValueError):
                state.retire(directory / "retired", pending, "owner", directory / "worktree", "no-update")
            self.assertTrue(pending.exists())

    def test_completion_keeps_the_claim_until_published_tag_and_main_match(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            pending = directory / "pending.json"
            commit = "a" * 40
            state.write_json(pending, {"owner": "owner", "stage": "ready", "version": "0.1.8-netpro2k", "commit": commit})
            with patch.object(state, "github_release", return_value={"draft": True, "prerelease": False}), self.assertRaises(ValueError):
                state.retire(directory / "retired", pending, "owner", directory / "worktree", "published")
            with patch.object(state, "github_release", return_value={"draft": False, "prerelease": False}):
                with patch.object(state, "run", side_effect=["b" * 40, f"{commit}\trefs/heads/main"]), self.assertRaises(ValueError):
                    state.retire(directory / "retired", pending, "owner", directory / "worktree", "published")
            self.assertTrue(pending.exists())
            self.assertFalse((directory / "retired").exists())

    def test_cleanup_preserves_changed_worktrees_and_removes_only_recorded_clean_one(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            repo = directory / "repo"
            repo.mkdir()
            state.run("git", "init", "-b", "main", cwd=repo)
            (repo / "file").write_text("original\n")
            state.run("git", "add", "file", cwd=repo)
            state.run("git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture", cwd=repo)
            worktree = directory / "run"
            state.run("git", "worktree", "add", "-b", "nightly", str(worktree), cwd=repo)
            record = directory / "record.json"
            state.write_json(record, {"owner": "old", "outcome": "no-update", "worktree": str(worktree), "branch": "nightly", "commit": state.run("git", "rev-parse", "HEAD", cwd=repo)})
            with self.assertRaises(ValueError):
                state.cleanup(record, worktree, repo / ".git")
            (worktree / "file").write_text("changed\n")
            with self.assertRaises(ValueError):
                state.cleanup(record, repo, repo / ".git")
            self.assertTrue(worktree.exists())
            (worktree / "file").write_text("original\n")
            state.cleanup(record, repo, repo / ".git")
            self.assertFalse(worktree.exists())
            self.assertFalse(record.exists())
            self.assertTrue(repo.exists())


if __name__ == "__main__":
    unittest.main()
