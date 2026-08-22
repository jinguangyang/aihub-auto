# Claude Handoff Memory

Updated: 2026-08-22

## Repository

- Workspace: `D:\code\aihub-auto`
- Branch: `feat/single-user-v0.4.5`
- Latest commits:
  - `d66eae7` - record recovery deployment handoff
  - `843ad0c` - verify identity before retrying managed deletes
  - `bbf9bdd` - recover failed pool deletions and harden upstream origin
- Preserve untracked `.playwright-cli/`, `aihub-auto-src.tar.gz`, and `output/`.

## Implemented

- Validated AIHub upstream origin configuration with restart-bound activation.
- Added pending origin status and console settings UI.
- Added durable pool-Key deletion recovery with account ownership, bounded retries,
  exponential backoff, idempotent 404/410 and exact key-not-found handling.
- Added account-switch/logout persistence and startup reconciliation.
- Added non-secret pool cleanup status and proxy URL redaction.
- Prevented 401 refresh retries unless refreshed identity is positively verified.

## Verification

- `bun run check`: 294 tests pass; TypeScript check passes.
- `bun test apps/router/tests`: 186 tests pass.
- Desktop Rust tests: 4 pass.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`: pass.
- `git diff --check`: pass.
- Final Linux artifact: `output/aihub-auto-headless-linux-x64-v0.4.5-recovery-final`
- Final artifact SHA256:
  `B66EA4DF96B70E8EE04E95EDC7CA1767F9EB9B14625C6D1BA20D11573E8E42B0`

## Deployment

- Host: `111.228.17.120`
- User: `easytunnel-deploy`, SSH port 22, key is stored in the local SSH directory.
- Remote binary: `/opt/aihub-auto/aihub-auto`
- Remote config: `/var/lib/aihub-auto/config.json`
- Active upstream origin: `https://aihub.dog`
- Service: `aihub-auto.service`, active, `NRestarts=0`, listener port `10001`.
- Local and public `healthz`/`ui` checks returned HTTP 200 after restart.
- Rollback directory:
  `/var/lib/aihub-auto/rollback-v0.4.5-recovery-20260822-1005`
- The rollback binary hash was verified against the pre-deployment hash.
- The temporary upload under `/tmp` is safe to remove after final verification.

## Remaining

- No remaining implementation or deployment tasks are recorded.
- The feature branch was confirmed on `fork/feat/single-user-v0.4.5` at `d66eae7`.
- Do not force-push, rewrite history, expose secrets, or delete the rollback directory.
