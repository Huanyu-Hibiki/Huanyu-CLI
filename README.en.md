[中文](README.md) · English

# hy

The Huanyu store CLI for installing, updating, purchasing, and managing skills in the Huanyu store.

Requires Node.js 18 or later. Run it with npx; no separate install needed:

```bash
npx github:Huanyu-Hibiki/Huanyu-CLI install <skill>   # Install a skill
npx github:Huanyu-Hibiki/Huanyu-CLI update             # Update installed skills
npx github:Huanyu-Hibiki/Huanyu-CLI login              # Sign in
npx github:Huanyu-Hibiki/Huanyu-CLI publish <dir>      # Publish your own skill
npx github:Huanyu-Hibiki/Huanyu-CLI status             # Show installed skills and account (default)
npx github:Huanyu-Hibiki/Huanyu-CLI help               # All commands
```

## Commands

Descriptions match the `hy help` wording.

| Command | Description |
|---------|-------------|
| `status` (default) | Show installed skills and account |
| `list` | List skills and prices |
| `install <skill> [--to <host>\|<path>]` | Install to all hosts or a chosen one |
| `update [<skill>] [--path <directory>]` | Update |
| `login [--token <access-token>]` | Sign in |
| `logout` | Revoke the access token and sign out |
| `subscribe <skill> [--plan <plan>]` | Purchase and install |
| `manage` | Manage purchases |
| `publish <directory> [--notes <text>]` | Publish; --repo <path> --all batch, --check audit only |
| `product <skill> --set <field>=<value>` | Manage product details |
| `unpublish <skill> <version>` | Yank a release |
| `audit [--repo <path>]` | Reconcile local skills with the store |
| `help` / `--version` | Help / version |

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

## Free-version cleanup

For products pairing a free skill with a paid one (for example `ppt-design` and `ppt-design-pro`), installing or updating the paid version automatically removes the free version installed under the same agent (listed under `removed` in the output) — the two versions would otherwise compete for the same requests. Removal shares one transaction with the install and rolls back together; development directories, free versions behind protected links, and similar locations are skipped and explained in `skipped`.

## Backups and recovery

When a previous version is replaced or cleaned up, the original directory is kept as a `.hy-backup-<timestamp>` backup under the install root; `hy status` reports its location. The next install or update of that skill removes it automatically, and you can delete it manually at any time. After a forced exit (exit code 130) or an unfinished rollback, backup paths are printed to stderr for manual recovery.

## Purchases and reruns

Payment happens in the browser and the checkout session is saved locally: if payment times out or the command is interrupted, rerunning the same command resumes the same payment page and will not charge twice. If installation still fails after the purchase is confirmed (a fulfillment race, an interrupted download, and so on), the error carries a hint — rerun the same command to finish installing; it will not charge again either.

## Output and exit codes

- Output follows your system language; use `--lang zh` / `--lang en` or the `HY_LANG` environment variable.
- `--json` prints structured JSON (with `next_command` and friends for agents); errors go to stderr.
- Exit codes: `0` success; `1` general failures (network/verification/install/publish, with error details); `2` usage errors; `3` sign-in or purchase required; `130` forced exit on a second Ctrl+C (backup paths are printed to stderr).
- Environment variables: `HY_API` overrides the store base URL (HTTPS required, except localhost); `HY_TOKEN` supplies a token directly (takes priority over local sign-in; for CI).

## Development

Zero npm dependencies; tests use the built-in `node:test`. Always run them with `npm test`: the entry point `scripts/test.js` lists test files explicitly — a bare `node --test` would also pick up the reference implementation under `template/` and the test infrastructure `test/driver.js` / `test/fixture.js`.

CI runs the suite on a windows/macos/ubuntu × Node 18/22 matrix and verifies the published tarball with `npm pack --dry-run` in one cell. See [docs/release-checklist.md](docs/release-checklist.md) before releasing.

## License

[MIT](LICENSE)
