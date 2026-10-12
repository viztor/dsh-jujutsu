# 06 — Shell seam and the bash sandbox

**Source turn:** 7
**Status:** the architecture is real; several package names in the answer are not

## The question

> "how about bash command does dsh offer simulated bash environmemt"

**No.** The harness runs **real** bash. What it adds is a confinement layer
around the spawned process. There is no in-memory shell simulation.

## What is real

| Package                                                                             | Role                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `dsh-shell`                                                                         | the shell capability seam (`ctx.shell`)                          |
| `dsh-shell-env`                                                                     | shell environment                                                |
| `dsh-bash-local`                                                                    | runs `bash -c` as a plain subprocess with the user's permissions |
| `dsh-bash-sandbox`                                                                  | runs the same command under an OS-level confinement              |
| `dsh-sandbox`, `dsh-sandbox-local`, `dsh-sandbox-policy`, `dsh-sandbox-windows-acl` | the sandbox backends and policy                                  |
| `dsh-tool-bash`                                                                     | the model-facing `bash` tool                                     |
| `dsh-tool-bash-persistent`                                                          | the stateful variant                                             |

So the conversation's core structural claim — _a modular shell executor seam
that swaps between a local executor and a sandboxed one_ — is **VERIFIED**.

Its package names are not:

| Claimed                                                                                 | Verdict                                                                                                              |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `dsh-bash-local`                                                                        | **VERIFIED**                                                                                                         |
| `dsh-bash-sandbox`                                                                      | **VERIFIED**                                                                                                         |
| `dsh-terminal-bash`                                                                     | **CONTRADICTED** — the stateful tool ships as `dsh-tool-bash-persistent`                                             |
| `dsh-tool-bash`                                                                         | **VERIFIED**                                                                                                         |
| confinement via bubblewrap/Landlock (Linux), **Seatbelt (macOS)**, ACL tokens (Windows) | **PLAUSIBLE** — `dsh-sandbox-windows-acl` confirms the Windows mechanism; the others were not opened in this session |

## The tool name

The `bash` tool is registered as `name: "bash"` via `defineTool` from
`@deepseek-ai/dsh-tools`. The conversation's `execute_bash` and
`terminal_write` are **CONTRADICTED** — neither name exists. This matters
directly for [02](02-git-blocking-at-tool-call-level.md): the guard matches
`exec.name === 'bash'`.

## Where interception happens

Both the one-shot `bash` tool and the persistent shell go through
`ctx.shell`, and both pass through `tools/pre-execute` **before** any OS
process is spawned. That is the whole reason a guard can work at all: the
harness gives you a veto before `spawn`.

Note the tool's own source comment, which says exactly where deployment policy
belongs:

> `TODO(permissions): deployment policy belongs in tools/pre-execute and
> sandboxing executors`

That is an endorsement of the design in
[02](02-git-blocking-at-tool-call-level.md) from the harness authors.

## What the sandbox does _not_ do

The conversation implies the sandbox can express "no Git in this project".
It cannot. `dsh-bash-sandbox` confines _where_ commands may write (the
`workspace-write` boundary and its siblings), not _which binaries_ may run.
Blocking a specific command is a policy concern, and policy lives in
`tools/pre-execute` — not in the sandbox backend.

This is worth stating plainly because the turn-7 answer blurs the two, and a
reader could conclude that a sandbox rule is available for Git. It is not.

## Consequence for `dsh-jujutsu`

- The guard is a **policy** plugin: it inspects `exec.name === 'bash'` and the
  parsed `command` argument. See
  [02](02-git-blocking-at-tool-call-level.md).
- Do **not** try to enforce the Git block by adding a sandbox rule; the seam
  does not support command-level denial.
- Do not assume a `git` binary is absent. It will be present; the guard is
  what makes it unreachable.
