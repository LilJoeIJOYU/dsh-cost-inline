# Publishing this plugin

## 1. Pick a package name

The convention is `dsh-xxx` or `@author/xxx`. The name must be unique on npm, and
a scope must be one you own.

This package is now **`dsh-cost-inline`** — checked free on the registry, and it
names the thing that makes it different: the readout lives inline inside the
composer's existing token-usage panel instead of adding a surface of its own. It
used to be `@local/dsh-cost-meter`; `@local` is a placeholder scope that is not
yours, which is why it had to change.

⚠️ **`dsh-cost-meter` is already taken.** It is published by `smallsun`
(latest `1.7.45`, <https://github.com/Han-1413141/dsh-cost-meter>) and covers the
same ground far more widely: per-session and per-day cost, history, a built-in
90+ model price catalogue, peak/off-peak pricing, Coding Plan quotas, provider
balance queries with progress bars, and a bilingual UI. Worth reading before
publishing, both to avoid the clash and to see whether it already does what you
want.

Check whether any name is free:

```sh
npm view <name> version      # 404 / "not found" means it is free
```

## 2. Make the three name sites agree

This is the one non-obvious requirement. The host resolves the browser bundle
under the installed `package.json`'s `name`, serves `exports["./client"]`, and the
bundle must register **that exact id** — otherwise the page fails with
`bundle … loaded without registering "<id>"`. So all three of these must be
identical:

| Where | Field |
|---|---|
| `package.json` | `name` |
| `cordis.patch.yml` | the inserted row's `name` |
| `client.js` | `window.__ModuleLoader__.load({ id: … })` |

Renaming a package that is **already installed in a profile** needs care: the old
row and the new row would both insert the same `id`, which the loader rejects.
Remove the old bundle first, then install the renamed one:

```sh
dsh plugin --profile <profile> remove <old-name>
dsh plugin --profile <profile> add <new-name>
```

## 3. Make the manifest publishable

- Remove `"private": true` — `npm publish` refuses private packages.
- Keep `files` complete: `index.js`, `client.js`, `cordis.patch.yml`,
  `locale/*.json`, `README.md`.
- Add a `LICENSE` file (`package.json` already says MIT, but npm expects the text).
- `engines.dsh` is **declarative only** — current readers do not enforce it — but
  it documents the tested runtime, which for this package is `0.2.1-rc.2`.
- Do **not** add `@deepseek-ai/dsh*` peerDependencies unless the range satisfies
  the running DSH version: the installer's compatibility gate inspects those peers
  and refuses the install with `incompatible-version`.

## 3b. Optional: directory metadata

Published community plugins carry a `dshhub` block beside `dsh`, which a plugin
directory can read without activating the plugin. Observed on
`dsh-cost-meter@1.5.5`:

```json
"dshhub": {
  "schemaVersion": 1,
  "displayName": "Cost Meter",
  "summary": "one-line description",
  "surfaces": ["host", "web"],
  "categories": ["费用", "Web UI", "观测"],
  "capabilities": { "provides": ["service:cost-meter"] },
  "permissions": { "network": ["https://api.deepseek.com"] },
  "compatibility": { "dsh": ">=0.1.0-rc.5", "node": ">=20" }
}
```

It sits outside the `dsh` field, so the manifest readers in this build do not use
it — whatever reads it is a hub, not the loader. Add it only if you publish into
one.

## 4. Publish

**npm** (others then install by name — this is the form the community README
documents):

```sh
cd plugins/dsh-cost-meter
npm publish --access public        # --access public is required for a scoped name
```

Users run:

```sh
dsh plugin add <package-name>
```

or enable it from the Plugins page / Settings → Plugins.

**git only** (no npm account needed):

```sh
git init && git add -A && git commit -m "dsh-cost-meter 1.0.0"
git remote add origin <repo-url> && git push -u origin main
```

Users install straight from the repository:

```sh
dsh plugin add github:<user>/<repo>
```

The installer checks the repository with `git ls-remote` before running `pnpm add`,
so a reachable repo is required; registry packages, paths and tarballs skip that
check.

**tarball** (hand it to someone directly):

```sh
npm pack                            # writes <name>-1.0.0.tgz
```

Users run `dsh plugin add ./<name>-1.0.0.tgz`.

## 5. What to tell users

- It works by taking over the composer dock's `activity` and `usage` cells —
  registering the same cell `id`s at a lower `priority`, which is the documented
  way to occupy an existing cell. A DSH update could rename those cells again;
  0.2.1 already split the old single `stats` cell into them, which is why 1.0.0
  stopped working.
- Its panel reuses the host's own label keys for token wording
  (`chat:stats.*`, `chat:message.turnUsage.*`, `chat:duration.*`). Those are not a
  public contract.
- The unit prices are published constants hardcoded in `PRICING` near the top of
  `client.js`; they go stale, and the comment there records the date they were
  last read.
- The balance row needs the DeepSeek account provider mounted
  (`ctx.remote.account`); without it the estimate still works and the balance row
  reports that it is unavailable.
