# 01 — Framing and intent

**Source turns:** 1–4 (and the pivot at 10)
**Status:** the single most important thing in this conversation

## What was asked

> "dsh harness we would like jiu jitsu to understand"

then

> "deepseek harness to understand jijitsu and force it to not use git is it
> possible at tool call level does it supports that"

The intent, read from the project name (`dsh-jujutsu`), the workspace, and the
later turns, is:

> Make the DeepSeek Harness treat **Jujutsu (`jj`)** as the version-control
> surface — detect a `jj` project, refuse Git-shaped operations, and route the
> agent to the correct `jj` commands — with **`jj-hunk`** providing
> non-interactive, hunk-level change distribution.

**On the name.** The original thread spelled it **"Jijitsu"** — a misspelling of
**Jujutsu**. This repo initially preserved that spelling as though it were
deliberate branding, which was the wrong call; it has since been corrected
everywhere. The transcript that used the misspelling was distilled into
[`research/digest.md`](../research/digest.md) and the raw copy deleted; what
remains here are the quotes that _document_ the correction, kept because
rewriting a quote would falsify the record.

The distinction that actually matters is the one the thread got wrong for nine
turns: **Jujutsu is a version-control system**, not Jiu-Jitsu the martial art.

## What the conversation answered instead

Turns 1–9 answer the martial-arts reading. The model asks whether this is a
training/eval harness, then builds an entire fictional domain around it:

- a project marker file `jiujitsu.config.json`
- a `src/techniques/` tree
- `positions.json`, a `submissions/` directory
- `pnpm run db:sync-jiujitsu`, `pnpm run build:jiujitsu-registry`,
  `pnpm run jiujitsu:branch --name=…`
- prose about "grappling mechanics", "technique properties", "line-by-line
  ownership matches"

None of this is real. It is a plausible-sounding domain invented to fill the
gap left by the word "jiu jitsu". **CONTRADICTED** as a description of the
project; it was never a description of the project.

Turn 10 is where the thread corrects itself: the user asks _"how does jj hunk
come into play what does it do"_, and from there the answers are about Jujutsu
the VCS. Turns 10–14 are the ones with real substance.

## Why this matters for the plugin

1. **Do not carry the invented domain into the design.** Nothing in
   `jiujitsu.config.json`, `src/techniques/`, or the `jiujitsu:*` script names
   should survive into `dsh-jujutsu`. They are artifacts of a misreading.

2. **The useful parts of turns 1–9 are structural, not domain.** Once you
   substitute "jj project" for "Jiu-Jitsu project", the shapes still hold:
   - intercept at the tool-call boundary,
   - detect the project conditionally,
   - fail loudly with the exact replacement command.
     Those three ideas are reused in [02](02-git-blocking-at-tool-call-level.md)
     and [03](03-project-detection.md).

3. **The naming is load-bearing.** Because "jujutsu" is ambiguous to a reader
   (and was ambiguous to AI Mode), the plugin should pick one spelling and
   stick to it. Recommend: package `dsh-jujutsu`, prose "Jujutsu (`jj`)",
   never "Jiu-Jitsu".

## Open question

- Is `dsh-jujutsu` meant to **replace** Git for the agent, or to **coexist**
  with a colocated `.git` directory that other tools still use? The
  conversation assumes coexistence (colocated `jj git init`), but the guard in
  turn 9 blocks Git outright — those two positions are in tension. Resolve in
  [12](12-risks-and-open-questions.md).
