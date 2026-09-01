# Distributable agent skills

Skills that T3 Code offers for installation into a user's agent configuration live under
`apps/server/resources/skills`. This is a source and distribution directory, not an agent discovery
root for work performed inside the T3 Code repository.

Do not place these skills in `.agents/skills` or `.codex/skills`. Those locations apply instructions
to agents working on this repository, which is a different scope from teaching a user's agent how to
operate their installed T3 environment.

Each skill retains its normal installable directory shape, including `SKILL.md` and optional
provider metadata such as `agents/openai.yaml`.

This fork's Linux and macOS update scripts copy `manage-t3-threads` into both user-wide roots:

- `~/.agents/skills/<skill-name>` for Codex, Grok Build, and other Agent Skills clients
- `~/.claude/skills/<skill-name>` for Claude Code; Grok Build also scans this compatibility root

The update scripts preserve the complete directory shape and overwrite only files owned by the
tracked skill. They do not delete other files or skills. These default user roots intentionally do
not follow a custom Claude `CLAUDE_CONFIG_DIR`; a separately configured Claude home needs its own
copy. Merely storing a resource here does not expose it to agents working in this repository, and
the current server package still publishes only `apps/server/dist`.
