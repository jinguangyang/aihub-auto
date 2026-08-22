# Codex Budget Launcher Design

**Date:** 2026-08-22

## Goal

Provide a local PowerShell launcher that makes low-token Codex usage the default without changing Codex internals or reading/storing credentials.

## Scope

The launcher supports three explicit profiles:

- `fast`: invokes `codex --profile fast` for short, low-cost tasks.
- `normal`: invokes the default `codex` configuration.
- `heavy`: invokes `codex --profile heavy` only when the caller explicitly selects it.

The launcher accepts one task string and forwards it to `codex exec`, so one-shot tasks do not accumulate an unnecessary interactive history.

## Safety and privacy

- Do not read `auth.json`, bearer tokens, session databases, or conversation history.
- Do not write prompts, command output, or credentials to disk.
- Pass only the selected profile and the caller's task text to Codex.
- Reject unknown profiles and empty task text before launching Codex.
- Refuse task text over 12,000 characters and suggest using a file path or focused log excerpt instead.

## User interface

```powershell
codex-budget fast "修复这个测试失败"
codex-budget normal "实现账户池恢复"
codex-budget heavy "分析整个项目"
```

The command prints the selected profile and configured context limits before starting Codex. It returns Codex's exit code unchanged.

## Non-goals

- No third-party plugin or proxy.
- No automatic deletion of sessions or logs.
- No automatic rewriting of prompts or source files.
- No attempt to estimate billable tokens precisely; character length is only a safety guard.

## Implementation location

Create a user-level script under `C:\Users\Administrator\.codex\tools\codex-budget.ps1`. Add a small user-level command shim under `C:\Users\Administrator\bin\codex-budget.ps1` only if that directory is already on PATH; otherwise document the direct invocation and optional alias.

## Verification

- PowerShell parses the script.
- Empty and oversized tasks are rejected without starting Codex.
- Unknown profiles are rejected without starting Codex.
- `fast`, `normal`, and `heavy` select the expected profile/configuration.
- A harmless `codex exec` smoke test returns successfully without exposing secrets.
