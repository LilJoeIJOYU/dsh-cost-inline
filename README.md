# Cost meter (`dsh-cost-inline`)

Shows what the task costs, **inside the token-usage panel that already exists** —
no new control is added to the composer.

## Install

Published under its npm package name:

```sh
dsh plugin add dsh-cost-inline
```

or enable it from the Plugins page. Not published yet? See
[PUBLISHING.md](PUBLISHING.md) — the package name has to match in three places
before anyone else can install it.

## What it does

The composer dock's readout — the host's `activity` (time) and `usage` (tokens)
cells in `conversation.composer.dock` — is taken over by registering each of
those cell ids at a lower `priority`. `SlotCore` sorts entries by `priority` and
renders the lowest as the cell head, so this plugin becomes the head of both
cells and the shipped entries are shadowed. The layout is unchanged: the same
two pills in the same place.

Harness **0.2.1** split the old single `stats` cell into those two cells; this
version targets the split ids. On a 0.2.0 harness, use the `1.0.0` commit.

Clicking the token-usage pill opens the panel it always opened, which now ends
with a **花费与余额 / Cost & balance** section:

| Row | Meaning |
|---|---|
| 预估花费 / Estimated cost | The session's tokens priced at the published rates — an estimate |
| 账户余额 / Balance | Current wallet total |
| 充值余额 / Topped-up, 赠送余额 / Granted | The same total split by wallet kind |
| 刷新 / Refresh | Re-reads the balance from the platform immediately |

## How the estimate is priced

Every step is priced at the tier that was in force **when that step ran**, not at
whatever the clock reads now:

- A settled assistant chat node carries the provider's `usage` for that step and
  `timing.stepStartTime`, which comes from the step's own session event `time`.
  Each step is therefore judged against the peak/off-peak window by its own
  timestamp and priced at that tier's rates.
- The **whole-session bucket totals** come from the cumulative `tokenUsage`
  projection, which is exact. Only the peak/off-peak **share** of each bucket is
  taken from the priced steps.

Splitting it that way is deliberate: the chat window is paged and compaction
rewrites it, so a fold over visible nodes can miss older steps. Taking only the
share means a partial window can bias the split but never the totals — the
reported figure always multiplies the provider's exact token counts.

If no step carries usable usage and timing (for example before the first step
settles), the session falls back to the current tier, and the panel says so
rather than implying a split it did not compute.

The panel's small print is deliberately a **single line**: the peak share of the
billed tokens, so a session that crossed a price boundary says so at a glance.

## The published unit prices

Every rate comes from DeepSeek's own price page —
<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>. Prices are CNY per
1,000,000 tokens:

| Model | | cache hit | cache miss | output |
|---|---|---|---|---|
| `deepseek-flash` (DeepSeek-V4.1-Flash) | peak | 0.04 | 2 | 8 |
| | off-peak | 0.02 | 1 | 4 |
| `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) | peak | 0.30 | 9 | 27 |
| | off-peak | 0.15 | 4.5 | 13.5 |

Peak hours are Beijing time, Monday–Friday (excluding Chinese public holidays),
09:00–12:00 and 14:00–18:00; every other time is off-peak at exactly half price.
The published holiday calendar is not modelled, so a holiday inside those
windows is priced as peak.

The page also states the rule this plugin implements: 扣减费用 = token 消耗量 ×
模型单价. Cache writes are charged at the cache-miss rate, because DeepSeek
publishes no separate cache-write rate.

Edit `PRICING` near the top of `client.js` when the page changes; the comment
there records the date the rates were last read. Nothing else in the file reads a
rate. The model is taken from the session's `modelSelection` projection and
falls back to `deepseek-flash` when the session has bound none.

## The balance

The account API is the only place real money comes from, and it reports only
current wallet totals: `getBalance` calls `GET /api/v0/users/get_user_summary`
and returns `normal_wallets` / `bonus_wallets`. There is no per-period charge
endpoint, and the Platform's usage detail is a web page (`/usage`), not an API a
plugin can reach.

The balance row reports its own state rather than a misleading zero: `尚未读取`
before the first reading, `读取中…` while one is in flight, `登录后查看` when
signed out, `余额不可用 · <code>` with the Remote's error code on failure, and
`平台未返回钱包` when the platform answered but returned no wallet rows.

### Claiming the account namespace

A Remote namespace is a cordis service named `<service>.<namespace>`, so
`ctx.remote.account` is readable only from a context that declared it — reading
it anywhere else **throws** rather than returning `undefined`. This plugin
therefore claims it with `ctx.inject(['remote.account'], scope => …)` rather
than adding it to the static `inject` list: the pills and the estimate need no
account at all, so making the whole plugin wait for one would trade a working
estimate for a balance that may not exist. Resolution never lets a throw escape,
and an unusable namespace becomes the reason text on the balance row instead of
a silent no-op.

## Where things live

| File | Role |
|---|---|
| `package.json` | Bundle manifest: `dsh.bundle.patch` makes it installable, `dsh.client` declares the browser half. |
| `cordis.patch.yml` | Inserts the single row `cost-meter` → `dsh-cost-inline`. |
| `index.js` | Host half. Intentionally empty: nothing runs off the browser. |
| `client.js` | Everything: the two-cell takeover, the pills and panels, the rates, the tier pricing, the balance read. |
| `locale/{en,zh}.json` | Title and description shown on the Plugins page. |

## Failure behaviour

A registration that throws during render is retired from its cell by the host.
This plugin leans on that deliberately, and on a second property of the design:
because the shipped entries stay registered in the same cells at `priority: 0`
(one `activity` pill and one `usage` pill), **a crash here falls back to the
stock readout** instead of an empty slot. There is no state in which this plugin can leave the composer
without its token usage.

The estimate needs no network and no account, so it keeps working whatever the
account does. The balance read is guarded and never substitutes a zero for a
failure.

One deliberate deviation while shadowing the host readout: this takeover always
renders the **detailed** pill and its panel. The host's `performanceUsage:
compact` setting would draw two static pills with no panel at all, which would
put the cost section out of reach, so the setting is not followed here. The
profile is configured `detailed`, which is what the panel is built around.

## Reinstalling or removing

Installed with `plugin_manager` `install_bundle` against this directory; the
profile records a `link:` dependency, so edits to `client.js` reach the open page
live, while a change to `index.js` or `package.json` needs an app restart.
