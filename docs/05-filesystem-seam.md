# 05 — Filesystem seam: `ctx.fs` vs `node:fs`

**Source turn:** 6
**Status:** the headline claim is **VERIFIED**; the method names in the sample are wrong

## The question

> "does dsh use packaged file system utils or should plugin use node fs directly"

**Answer: use `ctx.fs`. Never import `node:fs` in a plugin.** This is the
single most reliable technical statement in the conversation.

## Why

The harness mounts the filesystem as a swappable Cordis **service**
(`dsh-fs` declares `FileSystem extends Service`). Backends are separate
packages, and the profile chooses one:

| Package | Role |
|---|---|
| `dsh-fs` | the service definition and vocabulary |
| `dsh-fs-local` | direct access to the real disk |
| `dsh-fs-sandbox` | the confined backend |
| `dsh-fs-observation-policy` | the read-before-edit / observation policy |
| `dsh-tool-fs`, `dsh-tool-fs-search` | the model-facing tools on top |

A plugin that reaches for `node:fs` bypasses the mounted backend entirely: it
writes to the real disk even when the composition says the agent is confined,
and it escapes the policy layer that other plugins rely on.

## The actual `ctx.fs` surface

Read from `dsh-fs/lib/types/index.d.ts` — these are the abstract methods a
backend must implement:

```
processPath(target)                      fileUrl(target)
contains(parent, child)                  stat(target, signal?)
readText(target, signal?)                lstat(path, opts?)
streamText(target, signal?)              readBytes(target, signal, maxBytes)
listDir(target, signal?)                 writeText(target, content, expected?, signal?, sandboxPolicy?)
```

Two details that matter and that the conversation gets wrong:

1. **There is no `exists`.** The turn-8/9 samples call `ctx.fs.exists('/…')`.
   **CONTRADICTED.** Use `stat(target)` and treat `undefined` as absent — which
   also gives you the `FsInfo` you need for a detection check.

2. **`writeText` takes an `FsWriteIntent`.** That optional `expected`
   parameter is the read-before-edit token: a write can be rejected if the file
   changed since the read that authorised it. This is the mechanism behind the
   harness's "read a file before editing it" rule, and it is why a plugin
   should never hand-roll file mutation. The turn-8 sample's
   `await vfs.writeText(branchPath, baseState)` **omits it** and would either
   fail or silently bypass the policy, depending on the backend.

The conversation's `ctx.fs.readText('/sandbox/jiujitsu-core/positions.json')`
has the right method and a fictional path. `readText` is real.

## The "structured errors" claim

The conversation says `ctx.fs` normalises failures into typed `FsError`
schemas with predictable codes that the model loop can recover from.
**PLAUSIBLE** — the `FileSystem` service is typed and the tool layer
(`dsh-tool-fs`) does map errors into tool results — but no `FsError` class was
located under that name in this session. Verify before depending on specific
codes.

## Recommended shape

```ts
export const inject = ['fs', 'tools'];

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const info = await ctx.fs.stat(workspaceTarget('.jj'));
    if (info === undefined) return next();   // not a jj workspace
    …
  });
}
```

`inject` is how a Cordis plugin declares the services it needs; the
conversation's `export const inject = ['fs', 'tools']` is **VERIFIED** as the
right idea (it appears in shipping plugins, e.g. `dsh-tool-bash` injects
`['tools', 'shell', 'systemPrompt', 'shellEnv']`).

## Action

- Use `ctx.fs` exclusively. Add a lint rule or a review checklist item: no
  `node:fs` import in `src/`.
- Replace every `ctx.fs.exists(p)` with `(await ctx.fs.stat(p)) !== undefined`.
- Thread `FsWriteIntent` through every write.
