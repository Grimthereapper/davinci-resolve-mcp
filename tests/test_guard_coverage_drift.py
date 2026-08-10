"""Drift guard for the PreToolUse guards themselves.

The frame-verification guard is the structural half of AGENTS.md
("Frame-Referenced Color Work"): prose decays over a long session, the hook does
not. But a guard is only load-bearing if it is actually wired and actually
covers the actions that write grade state. Three ways that silently stopped
being true, all of which this file now catches:

1. **The wiring was never committed.** `.claude/settings.json` was untracked, so
   the guards existed in exactly one working copy. Every fresh clone and every
   git worktree ran with no guard at all, and nothing said so.
2. **The raw actions bypassed it.** `GRADE_APPLY_ACTIONS` listed only the
   `safe_*` twins. `set_cdl` and `copy_grades` reach the same
   `item.SetCDL()` / `item.CopyGrades()` writes without the validator, so
   choosing the raw name skipped frame verification entirely.
3. **Group assignment was unguarded.** `assign_color_group` /
   `remove_from_color_group` change which grade renders on a clip. The personal
   config repo tried to reach these by adding `color_group` to the matcher, but
   that is the wrong tool: `color_group`'s own actions are reads plus
   `set_name`, none of which touch grade state.

The guard is deliberately not imported as a package — it ships as an executable
hook script, so it is loaded by path here exactly as Claude Code runs it.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SETTINGS = REPO / ".claude" / "settings.json"
HOOKS_DIR = REPO / ".claude" / "hooks"
GUARD = HOOKS_DIR / "frame_verification_guard.py"

# Actions on timeline_item_color that write grade state through the raw Resolve
# API. Each is the unvalidated twin of a guarded `safe_*` action, or changes
# which grade renders on a clip. Kept here rather than imported so that adding a
# new writer to server.py cannot quietly widen the hole -- this list is the
# claim, and the test below is the proof the guard honours it.
RAW_GRADE_WRITERS = {
    "set_cdl",  # item.SetCDL()      -- raw twin of safe_set_cdl
    "copy_grades",  # item.CopyGrades()  -- raw twin of safe_copy_grade
    "assign_color_group",  # item.AssignToColorGroup() -- group grade now applies
    "remove_from_color_group",  # item.RemoveFromColorGroup() -- group grade drops
}

# Bulk writers overwrite hand-work across many clips with no recovery path, so
# they surface to the user even when frame evidence exists.
RAW_BULK_WRITERS = {"copy_grades"}


def load_guard():
    spec = importlib.util.spec_from_file_location("frame_verification_guard", GUARD)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GuardWiringTest(unittest.TestCase):
    """The hook has to be installed, not merely present on disk."""

    def test_settings_file_exists(self):
        self.assertTrue(
            SETTINGS.is_file(),
            f"missing {SETTINGS}. Without it no guard runs in this checkout.",
        )

    def test_settings_is_tracked_by_git(self):
        # An untracked settings.json is the exact failure this file exists for:
        # guards that work on one machine and nowhere else.
        import subprocess

        proc = subprocess.run(
            ["git", "ls-files", "--error-unmatch", str(SETTINGS.relative_to(REPO))],
            cwd=str(REPO),
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            proc.returncode,
            0,
            msg=(
                ".claude/settings.json is not tracked by git. The guards would be "
                "absent from every fresh clone and worktree. Run: "
                "git add .claude/settings.json"
            ),
        )

    def test_referenced_hook_scripts_exist_and_are_executable(self):
        settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
        commands = [
            hook["command"]
            for entry in settings.get("hooks", {}).get("PreToolUse", [])
            for hook in entry.get("hooks", [])
            if hook.get("type") == "command"
        ]
        self.assertTrue(commands, "no PreToolUse command hooks are configured")

        for command in commands:
            path_text = command.strip().strip('"').replace("$CLAUDE_PROJECT_DIR", str(REPO))
            script = Path(path_text)
            self.assertTrue(script.is_file(), f"hook script does not exist: {script}")
            self.assertTrue(
                os.access(script, os.X_OK),
                f"hook script is not executable, so Claude Code cannot run it: {script}",
            )

    def test_frame_guard_matcher_covers_timeline_item_color(self):
        settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
        matchers = [
            entry.get("matcher", "")
            for entry in settings.get("hooks", {}).get("PreToolUse", [])
            for hook in entry.get("hooks", [])
            if "frame_verification_guard" in hook.get("command", "")
        ]
        self.assertTrue(matchers, "frame_verification_guard is not wired to any matcher")
        self.assertTrue(
            any(re.match(m, "mcp__davinci-resolve__timeline_item_color") for m in matchers),
            f"no matcher reaches timeline_item_color; matchers were {matchers}",
        )


class GuardActionCoverageTest(unittest.TestCase):
    """Matching the tool is not enough -- the action list decides what is caught."""

    def setUp(self):
        self.guard = load_guard()

    def test_raw_grade_writers_are_guarded(self):
        missing = sorted(RAW_GRADE_WRITERS - set(self.guard.GRADE_APPLY_ACTIONS))
        self.assertEqual(
            missing,
            [],
            msg=(
                "these actions write grade state but bypass frame verification: "
                f"{missing}. A caller choosing the raw name instead of the safe_ "
                "twin would apply a grade with no frame ever inspected."
            ),
        )

    def test_bulk_writers_prompt_the_user(self):
        missing = sorted(RAW_BULK_WRITERS - set(self.guard.BULK_APPLY_ACTIONS))
        self.assertEqual(
            missing,
            [],
            msg=(
                f"these actions overwrite grades across clips without asking: {missing}"
            ),
        )

    def test_safe_twins_remain_guarded(self):
        # Regression cover: the safe_* set is what the guard shipped with, and
        # widening the list must never drop them.
        for action in ("safe_set_cdl", "safe_copy_grade", "safe_apply_drx"):
            self.assertIn(action, self.guard.GRADE_APPLY_ACTIONS)

    def test_every_guarded_action_exists_in_server(self):
        # A typo'd action name in the guard is indistinguishable from no guard.
        server = (REPO / "src" / "server.py").read_text(encoding="utf-8")
        for action in sorted(self.guard.GRADE_APPLY_ACTIONS):
            self.assertIn(
                f'"{action}"',
                server,
                msg=f"guard lists action '{action}' which server.py never dispatches",
            )


if __name__ == "__main__":
    unittest.main()
