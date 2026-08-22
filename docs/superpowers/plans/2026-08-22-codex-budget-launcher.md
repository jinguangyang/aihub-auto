# Codex Budget Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a user-level PowerShell command that launches one-shot Codex tasks with explicit low/normal/heavy context profiles and guards against accidental oversized prompts.

**Architecture:** A PowerShell script validates mode and task length, displays the selected limits, and invokes the existing `codex exec` command. A `.cmd` shim in the existing PATH directory `C:\Users\Administrator\.local\bin` makes `codex-budget` directly executable. A standalone PowerShell test script injects a fake `codex.cmd`, so validation and argument forwarding are tested without API calls or token spend.

**Tech Stack:** Windows PowerShell 5.1-compatible PowerShell, batch command shim, existing Codex CLI 0.149.0.

## Global Constraints

- Do not read or write Codex credentials, sessions, prompts, or command output.
- Reject blank prompts, unknown modes, and prompts longer than 12,000 characters.
- Preserve the native Codex exit code.
- Do not make a billable API request during verification.
- Preserve existing Codex configuration and repository untracked artifacts.

---

### Task 1: Test and implement the launcher

**Files:**
- Create: `C:\Users\Administrator\.codex\tools\codex-budget.tests.ps1`
- Create: `C:\Users\Administrator\.codex\tools\codex-budget.ps1`

**Interfaces:**
- Consumes: positional arguments `<fast|normal|heavy> <task>` and the existing `codex` command on PATH.
- Produces: validated invocation of `codex [--profile PROFILE] exec -- TASK` with Codex's exit code.

- [ ] **Step 1: Write a test harness using a temporary fake `codex.cmd`.**

  Assert blank/oversized/unknown inputs are rejected, each mode forwards the expected arguments, and native exit code `7` is preserved.

- [ ] **Step 2: Run the test and verify RED.**

  Run:

  ```powershell
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME\.codex\tools\codex-budget.tests.ps1"
  ```

  Expected: FAIL because `codex-budget.ps1` does not exist.

- [ ] **Step 3: Implement the minimal launcher.**

  Use a 12,000-character limit, fixed display metadata for the existing profile settings, `Get-Command codex`, and splatted argument arrays. Do not log task text.

- [ ] **Step 4: Run the test and verify GREEN.**

  Expected: all validation, forwarding, and exit-code tests pass.

### Task 2: Install the PATH shim and verify command discovery

**Files:**
- Create: `C:\Users\Administrator\.local\bin\codex-budget.cmd`

**Interfaces:**
- Consumes: all command-line arguments.
- Produces: a child `powershell.exe` invocation of the launcher with unchanged exit code.

- [ ] **Step 1: Add the command shim.**

  Resolve the launcher relative to `%USERPROFILE%` and forward `%*` using `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`.

- [ ] **Step 2: Verify parsing and discovery without an API request.**

  Run the complete test harness, `Get-Command codex-budget`, and a rejected blank-task invocation. Expected: tests pass, command resolves from `.local\bin`, and blank task exits before Codex starts.

- [ ] **Step 3: Record usage.**

  Report the three command forms and backup/rollback instructions; do not modify the PowerShell profile.
