# Jujutsu — topic split

The source thread is 14 exchanges over ~17 minutes. It is not one topic: it
drifts across harness internals, Jujutsu semantics, and GitHub workflow
compatibility, and it changes its mind about the core mechanism halfway through.
This is the split into distinctive areas, each with its own document.

The thread itself is no longer kept verbatim — it was distilled into
[`research/digest.md`](../research/digest.md), which holds the durable record,
and the raw transcript was deleted. Where these documents quote it, the quote is
verbatim and deliberate.

## The areas

| #                                                | Area                                        | Source turns  | What it settles                                                                                                          |
| ------------------------------------------------ | ------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [01](01-framing-and-intent.md)                   | **Framing and intent**                      | 1–4           | "Jujutsu" means Jujutsu the VCS, not Jiu-Jitsu the martial art. The thread's first nine answers solve the wrong problem. |
| [02](02-git-blocking-at-tool-call-level.md)      | **Blocking Git at the tool-call level**     | 2, 3, 9       | Where the boundary goes: preset patch vs runtime guard, and why "loud" beat "silent".                                    |
| [03](03-project-detection.md)                    | **Conditional project detection**           | 4, 9          | How the plugin decides it is in a `jj` project and stays out of the way everywhere else.                                 |
| [04](04-simulated-filesystem-and-branching.md)   | **Simulated filesystem and branching**      | 5             | Almost entirely fabricated; documents what was claimed and what is actually true.                                        |
| [05](05-filesystem-seam.md)                      | **Filesystem seam — `ctx.fs` vs `node:fs`** | 6             | Plugins must go through the harness filesystem service, not Node's `fs`.                                                 |
| [06](06-shell-seam-and-bash-sandbox.md)          | **Shell seam and the bash sandbox**         | 7             | Real bash under an OS sandbox; the interception point and its limits.                                                    |
| [07](07-jujutsu-core-model.md)                   | **Jujutsu core model**                      | 12, 14        | Working copy `@`, change ID vs commit ID, `jj new`, bookmarks, colocated init.                                           |
| [08](08-jj-hunk.md)                              | **`jj-hunk`**                               | 10            | Non-interactive hunk selection — the reason a headless agent can drive `jj` at all.                                      |
| [09](09-github-upstream-and-remotes.md)          | **GitHub upstream, remotes, nested forks**  | 11, 12        | Pushing bookmarks, `-c @` quick PRs, force-with-lease semantics, remote-ref blowup, workspaces vs worktrees.             |
| [10](10-workflow-compatibility.md)               | **Workflow compatibility**                  | 13, 14        | Editors/AI assistants, pnpm monorepos and Turborepo, CI and stacked PRs, review and CODEOWNERS.                          |
| [11](11-verified-dsh-api-contract.md)            | **Verified DSH API contract**               | 2, 3, 6, 7, 8 | The authoritative seams, read from the installed `0.2.0-rc.2` source, with citations.                                    |
| [12](12-risks-and-open-questions.md)             | **Risks and open questions**                | all           | Every claim that could not be verified, and the decisions still to make.                                                 |
| [13](13-empirical-verification.md)               | **Empirical verification**                  | —             | What was measured with real `jj` 0.46.0 and `jj-hunk` 0.5.1, with the commands. Corrects three earlier assumptions.      |
| [14](14-decision-log.md)                         | **Decision log**                            | —             | The eight open decisions, with recommendations.                                                                          |
| [15](15-verb-mapping.md)                         | **Git → `jj` verb mapping**                 | 2, 3, 9       | The denial-message table: the actual product surface of the guard.                                                       |
| [16](16-package-conventions.md)                  | **Package conventions**                     | —             | How a DSH host plugin is shaped, read out of a shipping plugin.                                                          |
| [17](17-bypass-and-approval.md)                  | **Bypass and approval**                     | —             | D2 resolved: deny by default, explicit per-call bypass through the harness approval channel.                             |
| [18](18-tool-surface.md)                         | **Tool surface**                            | —             | D4 resolved: the ten first-class `jj` tools, all returning JSON.                                                         |
| [19](19-jj-hunk-provisioning.md)                 | **`jj-hunk` provisioning**                  | —             | D3 resolved: offer to install via `cargo`, on an explicit yes.                                                           |
| [20](20-test-plan.md)                            | **Test plan and fixtures**                  | —             | Seven fixture repos, three test layers, and an assertion per acceptance criterion.                                       |
| [21](21-guard-evasion.md)                        | **Guard evasion**                           | —             | What a command-text guard can and cannot catch, measured against a 40+ command corpus.                                   |
| [22](22-context-injection.md)                    | **Context injection**                       | —             | The injection seam DSH provides (`ctx.systemPrompt`), and what the model is told about `jj`.                             |
| [23](23-correction-loop-walkthrough.md)          | **The correction loop**                     | —             | `git commit` → deny/ask → self-correct → `jj-hunk split`, traced through every real seam.                                |
| [24](24-implementation-plan.md)                  | **Implementation plan**                     | —             | The verified harness interfaces, module-by-module signatures, build order M0–M6, and test mapping.                       |
| [25](25-prompt-copy.md)                          | **Prompt copy**                             | —             | The literal strings: injected context, all denial messages, and the ten tool descriptions.                               |
| [26](26-preflight-and-error-taxonomy.md)         | **Preflight and errors**                    | —             | Every environmental precondition and error code, with its fail-open/fail-closed posture.                                 |
| [27](27-integration-surfaces.md)                 | **Integration surfaces**                    | —             | The whole harness extension map — 90 events, ~95 services — and which of them this plugin should use.                    |
| [28](28-teaching-and-interaction-surfaces.md)    | **Teaching and interaction**                | —             | Skills, slash commands, and structured questions.                                                                        |
| [29](29-state-config-and-sandbox-surfaces.md)    | **State, config, sandbox**                  | —             | `storage`, the settings UI, `sandboxPolicy`, and the permission presets.                                                 |
| [30](30-lifecycle-and-observability-surfaces.md) | **Lifecycle and observability**             | —             | Session init, end-of-turn, and how tool calls present.                                                                   |
| [31](31-probe-results-pipeline.md)               | **Probe results — pipeline**                | —             | Whether a `deny` can carry context, whether `inject` lands, and what a throw at `agent/created` costs.                   |
| [32](32-probe-results-teaching.md)               | **Probe results — teaching**                | —             | Skill visibility, compaction, the real token delta, and question reachability.                                           |
| [33](33-probe-results-jj.md)                     | **Probe results — `jj`**                    | —             | Measured `jj` behaviour: version detection, conflict propagation, and the identity matrix.                               |
| [34](34-probe-plan.md)                           | **Probe plan**                              | —             | What is still open, the one throwaway plugin that closes five of them, and what is needed to run it.                     |
| [35](35-probe-results-live.md)                   | **Probe results — live session**            | —             | The probe was built, installed, exercised and removed. Twelve of fourteen questions are now closed.                      |

The build specification is [`SPEC.md`](../SPEC.md).

## Decisions taken

| Decision                                           | Where                                                      |
| -------------------------------------------------- | ---------------------------------------------------------- |
| Loud guard, no silent translation                  | [02](02-git-blocking-at-tool-call-level.md)                |
| Deny Git by default, explicit bypass required (D2) | [17](17-bypass-and-approval.md)                            |
| Full first-class `jj` tool set (D4)                | [18](18-tool-surface.md)                                   |
| Offer to install `jj-hunk` via cargo (D3)          | [19](19-jj-hunk-provisioning.md)                           |
| `--query` over saved hunk IDs                      | [08](08-jj-hunk.md), [13 §6](13-empirical-verification.md) |
| Use `ctx.fs`, never `node:fs`                      | [05](05-filesystem-seam.md)                                |
| Fail open on detector errors                       | [SPEC §8](../SPEC.md)                                      |

## How to read it

- **Building the guard?** [02](02-git-blocking-at-tool-call-level.md) then
  [11](11-verified-dsh-api-contract.md). The contract doc is the one that is
  checkable; the conversation is not.
- **Building the `jj` surface?** [07](07-jujutsu-core-model.md) →
  [08](08-jj-hunk.md) → [09](09-github-upstream-and-remotes.md).
- **Deciding whether any of this is safe to ship?**
  [12](12-risks-and-open-questions.md).

## Verification status used throughout

Every claim below is tagged:

- **VERIFIED** — read directly from the installed DSH source or the Jujutsu
  documentation in this session.
- **PLAUSIBLE** — consistent with the verified surface, not yet checked.
- **UNVERIFIED** — asserted by the conversation, no supporting evidence found.
- **CONTRADICTED** — checked, and false for DSH `0.2.0-rc.2`.

The source thread contains a high proportion of **UNVERIFIED** and
**CONTRADICTED** material because AI Mode was answering about a harness whose
internals it does not have. Treat it as a source of _questions and directions_,
not of facts. The facts are in [11](11-verified-dsh-api-contract.md).
