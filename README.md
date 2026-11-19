# WebWorkBench: public preview

Original code in this preview is licensed under the [MIT License](LICENSE). Third-party dependencies retain their own licenses. This is a source preview, not a complete benchmark or application release.

This is a no-history, neutral harness/API source subset and two deterministic synthetic tasks. It is **not** the private 24-task benchmark release and contains no private experimental results or scores.

```sh
corepack pnpm install --ignore-scripts
corepack pnpm typecheck
corepack pnpm build
corepack pnpm bench job plan --config examples/jobs/neutral-demo.json
```

The demo uses local temporary boolean fixtures, a deterministic harness, and independent state evaluation; no model/provider/browser is contacted. The source API subset intentionally excludes legacy dataset commands and private history links.

## Release gates

- MIT applies only to original code in this snapshot. No Vikunja or other upstream application source/modification is included. Any later Vikunja modification distribution must preserve its upstream AGPL license and provide corresponding source; it must not be relabeled MIT.
- The real 24-task loader depends on an integrity-pinned historical parent, sanitized evidence summary and evaluator references. Those artifacts are withheld pending data-rights/privacy audit; hashes are not disabled or replaced with fake provenance.
- Real application fixtures, vendor SDK archives, screenshots, run logs, private paths and repository links are not included.
- Native-only Vikunja images need independently verified upstream rights, official image identity, license notices and a tested clean Docker context. The old ClearAct overlay recipe is not supported here: it copied obsolete vendor paths and broad packages. No Docker build, real V01 acceptance or public image publication is claimed.
- Historical evidence remains private. This staging subset neither reproduces nor replaces prior experiment claims.
