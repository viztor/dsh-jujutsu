# 02 — Blocking Git at the tool-call level

**Source turns:** 2, 3, 9 (and the rejected silent variant in 8)
**Status:** the mechanism is real; every code sample in the conversation is wrong

## The question

Can the harness stop the model from using Git, at the tool-call level, and tell
it what to run instead?

**Yes.** And the second half — telling it what to run instead — is the
interesting half.

## What the conversation proposed

**Option A — disable the git plugin via preset patching** (called "recommended"):

```yaml
plugins:
  - id: tool-git
    name: "@deepseek-ai/dsh-tool-git"
    disabled: true
```

**CONTRADICTED.** There is no `@deepseek-ai/dsh-tool-git` package in DSH
`0.2.0-rc.2`, and no tool registers the name `git`. Git is only reachable by
running `git …` through the `bash` tool. You could disable `bash`, but that
removes the agent's whole shell — not a guard, an amputation.

**Option B — a runtime guard on `tools/pre-execute`:**

```ts
ctx.tools.on("tools/pre-execute", (callContext) => {
  if (callContext.name === "execute_bash" && callContext.args.command.includes("git")) {
    throw new Error("Git usage is strictly disabled for this training session.");
  }
});
```

**Partially right, wrong in every detail that matters:**

| The sample                            | Reality (DSH `0.2.0-rc.2`)                                                  |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `ctx.tools.on(...)`                   | `ctx.on('tools/pre-execute', …)` — a plain context listener                 |
| `(callContext)`                       | `(exec, next)` — it is a **waterfall**, and you must call `next()` to allow |
| `throw new Error(...)`                | Return `{ kind: 'deny', reason }`; throwing is not the contract             |
| `callContext.name === 'execute_bash'` | The bash tool is named **`bash`**; there is no `execute_bash`               |
| `callContext.args.command`            | `exec.arguments` (parsed, `unknown`); the bash schema's field is `command`  |
| `callContext.name.startsWith('git_')` | No `git_*` tools exist                                                      |

The correct shape, taken from the shipping Claude Code hooks bridge
(`dsh-hooks-claude-code`):

```ts
ctx.on("tools/pre-execute", async (exec, next) => {
  if (!blocked(exec)) return next();
  return { kind: "deny", reason: "use `jj new` instead of `git commit`" };
});
```

## The design decision the conversation actually settled

Turn 8 proposes a **silent translation layer**: intercept `git checkout -b`,
fake a success message, and never tell the model. Turn 9 rejects it:

> "we dont want a silent translation layer"

That rejection is both correct on the merits and fortunate on the facts:

- **Not implementable.** `tools/pre-execute` explicitly excludes input
  rewriting ("Input rewriting is excluded because arguments are already logged
  and presented"), and `callContext.bypass(…)` does not exist anywhere in the
  installed source.
- **Not desirable.** A silent shim teaches the model that `git` works, so it
  keeps emitting Git, and the harness accumulates a lie between the model and
  the repository.

So: **loud guard.** Deny the call, and put the exact replacement command in the
denial `reason`. The denial is delivered to the model as an error result, which
is exactly the self-correction loop the conversation was reaching for.

## Two channels for the correction

| Channel              | Where                | Shape                                         | Effect                                                                         |
| -------------------- | -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| Deny before dispatch | `tools/pre-execute`  | `{ kind: 'deny', reason }`                    | The tool never runs; the model sees `Error: <reason>`                          |
| Block after dispatch | `tools/post-execute` | `{ kind: 'block', feedback: ContentBlock[] }` | The tool ran; its result is replaced by an error carrying corrective feedback  |
| Monotonic policy     | `tools.guard(fn)`    | return a `string` to deny                     | Runs after the pre-execute waterfall; cannot be overridden by a later listener |

For "Git is forbidden here", `tools/pre-execute` deny is the right channel —
there is no reason to let the command run and then rewrite the outcome. Use
`tools.guard` instead if the rule must be non-negotiable across plugins that
might otherwise allow the call.

## What the guard has to match

Because Git is only reachable through `bash`, the guard inspects **command
text**, not a tool name. That is inherently fuzzy:

- `git status` — trivial
- `jj git export && git push` — contains `git` as a subcommand of `jj`
- `cd /tmp && git log` — Git outside the project
- `echo "git"` — a false positive
- `env FOO=1 git commit` — still Git
- a shell function, an alias, `command git`, `\git`, a script that shells out

This is the weakest point in the whole design and the conversation never
addresses it. See [12](12-risks-and-open-questions.md).

## Recommended shape for `dsh-jujutsu`

1. Detect a `jj` workspace (see [03](03-project-detection.md)). If not a `jj`
   workspace, return `next()` immediately — zero behaviour change elsewhere.
2. On `bash`, parse the command into segments and look for a Git invocation
   that is _not_ `jj git <subcommand>`.
3. Deny with a `reason` naming the `jj` equivalent for that specific verb
   (`commit` → `jj commit` / `jj new`, `checkout -b` → `jj new`,
   `add -p` → `jj-hunk split`, `branch` → `jj bookmark`, …).
4. Log the denial so the plugin's own behaviour is auditable.

Step 3's verb mapping is the actual product. The guard is trivial; the mapping
table is not.
