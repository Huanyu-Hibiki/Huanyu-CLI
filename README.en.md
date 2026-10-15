[中文](README.md) · English

# hy

The Huanyu store CLI for installing, updating, and managing skills in the Huanyu store. Phase 1 covers install, login, and publish; updates and purchasing arrive in phase 2.

Requires Node.js 18 or later. Run it with npx; no separate install needed:

```bash
npx github:Huanyu-Hibiki/Huanyu-CLI install <skill>   # Install a skill
npx github:Huanyu-Hibiki/Huanyu-CLI login              # Sign in
npx github:Huanyu-Hibiki/Huanyu-CLI publish <dir>      # Publish your own skill
npx github:Huanyu-Hibiki/Huanyu-CLI status             # Show installed skills and account (default)
npx github:Huanyu-Hibiki/Huanyu-CLI help               # All commands
```

## Commands

Descriptions match the `hy help` wording. Commands marked phase 2 parse correctly and report "not implemented" when run.

| Command | Description | Status |
|---------|-------------|--------|
| `status` (default) | Show installed skills and account | Phase 1 |
| `list` | List skills and prices | Phase 1 |
| `install <skill> [--to <host>\|<path>]` | Install to all hosts or a chosen one | Phase 1 |
| `login [--token <access-token>]` | Sign in | Phase 1 |
| `logout` | Revoke the access token and sign out | Phase 1 |
| `publish <directory> [--notes <text>]` | Publish; --repo <path> --all batch, --check audit only | Phase 1 |
| `help` / `--version` | Help / version | Phase 1 |
| `update [<skill>] [--path <directory>]` | Update | Phase 2 |
| `subscribe <skill> [--plan <plan>]` | Purchase and install | Phase 2 |
| `manage` | Manage purchases | Phase 2 |
| `product` | Manage product details | Phase 2 |
| `unpublish` | Yank a release | Phase 2 |
| `audit` | Reconcile local skills with the store | Phase 2 |

Directory naming and frontmatter conventions for published skills: [docs/skill-convention.md](docs/skill-convention.md).

## Automatic discovery across nine hosts

Without `--to`, install discovers the agent hosts already present on the machine (detected, never created). The first available directory in the order below holds the real copy; the other hosts link to it (junctions on Windows, symlinks on macOS/Linux) — one copy per machine.

| Host | User-level directory |
|------|----------------------|
| zcode | `~/.zcode/skills` |
| agents | `~/.agents/skills` |
| claude | `~/.claude/skills` |
| codex | `~/.codex/skills` (honors `CODEX_HOME`) |
| cursor | `~/.cursor/skills` |
| opencode | `~/.config/opencode/skill` (honors `XDG_CONFIG_HOME`) |
| trae | `~/.trae/skills` |
| qwenwork | `~/.qwenworkcn/skills` |
| workbuddy | `~/.workbuddy/skills` |

Use `--to <host>` (an id from the table above) or `--to <path>` to choose targets; repeat it for several: the first holds the copy, the rest link. Project-level directories are never default targets; reach them explicitly with `--to`. Separate copies of the same skill under other hosts are replaced with links to the copy; development directories (containing `.git`) are skipped.

## Output and exit codes

- Output follows your system language; use `--lang zh` / `--lang en` or the `HY_LANG` environment variable.
- `--json` prints structured JSON (with `next_command` and friends for agents); errors go to stderr.
- Exit codes: `0` success; `1` general failures (network/verification/install/publish, with error details); `2` usage errors (including not-yet-implemented commands); `3` sign-in or purchase required; `130` forced exit on a second Ctrl+C (backup paths are printed to stderr).
- Environment variables: `HY_API` overrides the store base URL (HTTPS required, except localhost); `HY_TOKEN` supplies a token directly (takes priority over local sign-in; for CI).

## Development

Zero npm dependencies; tests use the built-in `node:test`. Always run them with `npm test`: the entry point `scripts/test.js` lists test files explicitly — a bare `node --test` would also pick up the reference implementation under `template/` and the test infrastructure `test/driver.js` / `test/fixture.js`.

CI runs the suite on a windows/macos/ubuntu × Node 18/22 matrix and verifies the published tarball with `npm pack --dry-run` in one cell. See [docs/release-checklist.md](docs/release-checklist.md) before releasing.

## License

[MIT](LICENSE)
