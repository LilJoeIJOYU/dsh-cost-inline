/**
 * Cost meter, Client half.
 *
 * Takes over the composer dock's `stats` cell — the token-usage pills the Chat
 * plugin registers there — by registering the same cell `id` at a lower
 * `priority`, which is the documented way to occupy an existing cell. Nothing
 * new is added to the composer's layout: the two pills keep their exact
 * position, and the money lives inside the panel that the token-usage pill
 * already opens.
 *
 * The panel gains a "cost & balance" section with two independent money figures:
 *
 *   预估花费  token counts × the published DeepSeek unit prices (the estimate)
 *   实际扣费  the drop in the account's wallet balance, accumulated from
 *             readings taken while this session was the open one
 *   账户余额  the account's current wallet total, split into topped-up and
 *             granted
 *   刷新      re-reads the balance immediately
 *
 * The harness carries no money rates itself — every `price`/`pricing` value in
 * it is a token-count heuristic and the model catalog declares no cost — and the
 * account API reports only current wallet totals, with no per-period charge. So
 * the estimate comes from the published price list hardcoded below, and the
 * "actual" figure is measured as the balance's decrease. Showing both lets each
 * one check the other.
 *
 * If this component throws, the host retires only this cell head and the
 * shipped StatsPills (still registered at priority 0) renders instead, so a
 * failure here degrades to the stock readout rather than an empty dock.
 */

window.__ModuleLoader__.load({
	id: 'dsh-cost-inline',
	factory(require) {
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;
		const { useEffect, useRef, useState } = React;

		/** Locale namespace this plugin registers its display text under. */
		const NS = 'cost-meter';
		/**
		 * Account calls carry the calling build's version. The account Remote
		 * forwards it only as Platform client metadata, so a constant is safe.
		 */
		const CLIENT_VERSION = '0.2.0-rc.2';
		/** Shortest interval between two automatic balance reads, in ms. */
		const BALANCE_MIN_INTERVAL_MS = 5000;
		/** Viewport margin the panel clamp keeps. */
		const PANEL_MARGIN = 12;
		/** Distance between the trigger's top edge and the panel's bottom. */
		const PANEL_GAP = 8;
		/**
		 * Published DeepSeek rates, CNY per 1,000,000 tokens, taken from
		 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
		 * `peak` applies on Beijing-time weekdays 09:00-12:00 and 14:00-18:00;
		 * `offPeak` is exactly half of it and applies at every other time.
		 * Rates last read off the page on 2026-09-30; update these numbers here when
		 * they change — nothing else in this file reads a rate.
		 */
		const PRICING = {
			'deepseek-flash': {
				label: 'DeepSeek-V4.1-Flash',
				symbol: '¥',
				peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
				offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
			},
			'deepseek-v4-pro': {
				label: 'DeepSeek-V4-Pro',
				symbol: '¥',
				peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
				offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }
			}
		};
		/** Model priced when the session has bound none. */
		const DEFAULT_MODEL = 'deepseek-flash';
		/** Milliseconds of the fixed Beijing (UTC+8) offset used for price tiers. */
		const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

		/**
		 * Pill styling copied from the host's StatsPills module and panel styling
		 * copied from its stat-dialog module, both renamed under this plugin's own
		 * `cmtr_` prefix. Only `--dsw-alias-*` theme tokens are referenced, so the
		 * takeover follows the active theme and content font size.
		 */
		const CSS = [
			'.cmtr_root{box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;gap:12px;display:flex}',
			'.cmtr_anchor{min-width:0;display:inline-flex}',
			'.cmtr_pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
			'.cmtr_pill svg{flex:none;width:14px;height:14px}',
			'button.cmtr_pill{cursor:pointer}',
			'button.cmtr_pill:hover,button.cmtr_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
			'button.cmtr_pill:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
			'.cmtr_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
			'.cmtr_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
			'.cmtr_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}',
			'.cmtr_title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
			'.cmtr_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
			'.cmtr_titleValue{font-variant-numeric:tabular-nums}',
			'.cmtr_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}',
			'.cmtr_titleLabel svg{flex:none;width:14px;height:14px}',
			'.cmtr_details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}',
			'.cmtr_details dt,.cmtr_details dd{min-width:0;margin:0}',
			'.cmtr_details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}',
			'.cmtr_rule{border-top:.5px solid var(--dsw-alias-border-l2);margin:12px 0 10px}',
			'.cmtr_sectionTitle{color:var(--dsw-alias-label-primary);font-weight:500;align-items:center;justify-content:space-between;gap:16px;margin-bottom:8px;display:flex}',
			'.cmtr_refresh{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:0 0;height:22px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;white-space:nowrap;cursor:pointer;flex:none;padding:0 8px}',
			'.cmtr_refresh:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.cmtr_refresh:disabled{color:var(--dsw-alias-label-caption);cursor:default}',
			'.cmtr_refresh:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
			'.cmtr_spend{color:var(--dsw-alias-label-primary)}',
			'.cmtr_note{color:var(--dsw-alias-label-caption);margin-top:8px;font-size:11px;line-height:16px}'
		].join('');

		/**
		 * Display text. The token keys copy the host's own wording so the taken-over
		 * panel reads exactly like the shipped one; `money.*` is this plugin's.
		 */
		const EN = {
			'number.thousand': '{value}K',
			'number.million': '{value}M',
			'number.groupSeparator': ',',
			'duration.compactSeconds': '{seconds}s',
			'duration.compactMinutes': '{minutes}m{seconds}s',
			'message.tokensPerSecond': '{tps} tok/s',
			'message.turnUsage.count': '{count} tok',
			'message.turnUsage.cacheHit': 'Cache hit',
			'message.turnUsage.input': 'Uncached input',
			'message.turnUsage.cacheRead': 'Cached input',
			'message.turnUsage.cacheWrite': 'Cache write',
			'message.turnUsage.output': 'Output',
			'stats.counts': '{turns} turns {steps} steps',
			'stats.cacheHit': 'Cache hit {percent}%',
			'stats.dialog.title': 'Session statistics',
			'stats.dialog.usageTitle': 'Token usage',
			'stats.dialog.llmTime': 'LLM time',
			'stats.dialog.toolTime': 'Tool time',
			'stats.dialog.ttft': 'Avg time to first token (TTFT)',
			'stats.dialog.speed': 'Tokens per second (TPS)',
			'money.title': 'Cost & balance',
			'money.estimate': 'Estimated cost',
			'money.balance': 'Balance',
			'money.recharge': 'Topped-up',
			'money.bonus': 'Granted',
			'money.refresh': 'Refresh',
			'money.refreshing': 'Reading…',
			'money.signedOut': 'Sign in to view',
			'money.unavailable': 'Balance unavailable',
			'money.pending': 'Not read yet',
			'money.noWallets': 'No wallet returned',
			'money.unparsed': 'Amount unreadable',
			'money.splitNote': '{percent}% of the billed tokens were in peak hours.',
			'money.blendNote': 'No per-step timestamps, so the peak split is unknown.'
		};

		const ZH = {
			'number.thousand': '{value}K',
			'number.million': '{value}M',
			'number.groupSeparator': ',',
			'duration.compactSeconds': '{seconds}秒',
			'duration.compactMinutes': '{minutes}分{seconds}秒',
			'message.tokensPerSecond': '{tps} tok/s',
			'message.turnUsage.count': '{count} tok',
			'message.turnUsage.cacheHit': '缓存命中',
			'message.turnUsage.input': '未缓存输入',
			'message.turnUsage.cacheRead': '缓存读取',
			'message.turnUsage.cacheWrite': '缓存写入',
			'message.turnUsage.output': '输出',
			'stats.counts': '{turns} 轮 {steps} 步',
			'stats.cacheHit': '缓存命中 {percent}%',
			'stats.dialog.title': '会话统计',
			'stats.dialog.usageTitle': 'Token 用量',
			'stats.dialog.llmTime': '模型用时',
			'stats.dialog.toolTime': '工具调用用时',
			'stats.dialog.ttft': '首 token 平均（TTFT）',
			'stats.dialog.speed': '输出速度（TPS）',
			'money.title': '花费与余额',
			'money.estimate': '预估花费',
			'money.balance': '账户余额',
			'money.recharge': '充值余额',
			'money.bonus': '赠送余额',
			'money.refresh': '刷新',
			'money.refreshing': '读取中…',
			'money.signedOut': '登录后查看',
			'money.unavailable': '余额不可用',
			'money.pending': '尚未读取',
			'money.noWallets': '平台未返回钱包',
			'money.unparsed': '金额无法解析',
			'money.splitNote': '计费用量中 {percent}% 位于高峰时段。',
			'money.blendNote': '未取到分步时间戳，无法区分峰谷。'
		};

		/* ---------------------------------------------------------------- format */

		/** Compact token count: 517 / 12.2K / 517K / 1.2M. */
		function formatTokens(value, t) {
			const scaled = (candidate) =>
				candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
			if (value < 1e3) return String(value);
			if (value < 1e6) return t('number.thousand', { value: scaled(value / 1e3) });
			return t('number.million', { value: scaled(value / 1e6) });
		}

		/** Exact integer token count with digit grouping. */
		function formatExactTokens(value, t) {
			const digits = String(Math.round(value));
			const groups = [];
			for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
			return groups.join(t('number.groupSeparator'));
		}

		/** Decode throughput: whole tokens from ten up, one decimal below. */
		function formatTokensPerSecond(tps) {
			const clamped = Math.max(0, tps);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}

		/** 45.2s under a minute, 2m42s from there on. */
		function formatDuration(ms, t) {
			const s = ms / 1e3;
			if (s < 60) return t('duration.compactSeconds', { seconds: Math.round(s * 10) / 10 });
			const whole = Math.round(s);
			return t('duration.compactMinutes', { minutes: Math.floor(whole / 60), seconds: whole % 60 });
		}

		/**
		 * Cache-hit share of prompt-side input, never rounding a partial hit to
		 * 100%: extra precision is added until the text stays below it.
		 * @param cacheReadTokens - prompt tokens served from cache.
		 * @param promptTokens - aggregate prompt tokens.
		 * @param decimalPlaces - ordinary precision.
		 * @returns percentage text, or null without prompt input.
		 */
		function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
			if (!(promptTokens > 0)) return null;
			if (cacheReadTokens >= promptTokens) return '100';
			const ratio = (cacheReadTokens / promptTokens) * 100;
			let places = decimalPlaces;
			let text = ratio.toFixed(places);
			while (Number(text) >= 100 && places < 6) {
				places += 1;
				text = ratio.toFixed(places);
			}
			return text;
		}

		/** Sum every billed bucket of one `tokenUsage` value. */
		function usageTotal(usage) {
			if (usage === undefined || usage === null) return 0;
			return (
				(usage.uncachedInputTokens ?? 0) +
				(usage.cacheReadTokens ?? 0) +
				(usage.cacheWriteTokens ?? 0) +
				(usage.outputTokens ?? 0)
			);
		}

		/** Sum the three disjoint prompt-side billing buckets. */
		function billedInputTokens(usage) {
			return (usage?.uncachedInputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
		}

		/** Two decimals with grouping; a positive sub-cent amount shows as `<0.01`. */
		function formatAmount(amount) {
			if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
			if (amount > 0 && amount < 0.01) return '<0.01';
			return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
		}

		/**
		 * Whether one instant falls in DeepSeek's peak-price window.
		 * @param now - epoch milliseconds.
		 * @returns true on a Beijing-time weekday inside 09:00-12:00 or
		 *   14:00-18:00; the published public-holiday calendar is not modelled.
		 */
		function isPeakNow(now) {
			const beijing = new Date(now + BEIJING_OFFSET_MS);
			const weekday = beijing.getUTCDay();
			if (weekday === 0 || weekday === 6) return false;
			const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
			return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
		}

		/** Format an estimate at the precision an amount this small needs. */
		function formatCost(amount) {
			if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
			if (amount < 0.0001) return '<0.0001';
			if (amount < 1) return amount.toFixed(4);
			if (amount < 100) return amount.toFixed(2);
			return amount.toFixed(1);
		}

		/** Resolve the session's routed model id from the selection projection. */
		function pickModelId(selection) {
			const next = selection?.next?.model;
			const last = selection?.lastUsed?.model;
			if (typeof next === 'string') return next;
			if (typeof last === 'string') return last;
			return DEFAULT_MODEL;
		}

		/** Short text for a failed Remote call, shown on the panel's diagnostic line. */
		function describeRemoteError(error) {
			if (error === undefined || error === null) return 'request failed';
			if (typeof error === 'string') return error;
			if (typeof error.code === 'string') return error.code;
			if (typeof error.message === 'string') return error.message;
			try {
				return JSON.stringify(error).slice(0, 120);
			} catch {
				return 'request failed';
			}
		}

		/**
		 * Read the account Remote namespace out of one injection scope.
		 *
		 * A Remote namespace is a cordis service named `<service>.<namespace>`, so
		 * reading it off a context that did not declare it throws instead of
		 * returning undefined. Each access form is therefore attempted inside its
		 * own guard, and only a callable namespace is accepted.
		 * @param scope - the context handed to an injection callback.
		 * @returns the account namespace, or undefined when it is not callable here.
		 */
		function accountFromScope(scope) {
			const attempts = [() => scope.remote?.account, () => scope['remote.account']];
			for (const attempt of attempts) {
				try {
					const candidate = attempt();
					if (typeof candidate?.getBalance === 'function') return candidate;
				} catch {
					/* try the next access form */
				}
			}
			return undefined;
		}

		/** Read one settled step's billed buckets from a raw provider usage record. */
		function stepBuckets(usage) {
			if (usage === undefined || usage === null) return undefined;
			const miss = usage.inputTokens;
			const output = usage.outputTokens;
			if (!Number.isFinite(miss) || !Number.isFinite(output)) return undefined;
			const cacheWrite = Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0;
			return {
				cacheMiss: miss + cacheWrite,
				cacheHit: Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0,
				output
			};
		}

		/**
		 * Epoch time that decides one step's price tier. The step's own start event
		 * time is used, falling back to the completing message's time.
		 */
		function stepTime(node) {
			const start = node?.timing?.stepStartTime;
			if (typeof start === 'number' && Number.isFinite(start)) return start;
			const time = node?.time;
			return typeof time === 'number' && Number.isFinite(time) ? time : undefined;
		}

		/**
		 * Split the visible steps' billed buckets by the tier in force at each step's
		 * own timestamp.
		 * @param nodes - chat snapshot nodes (assistant nodes carry usage and timing).
		 * @returns per-tier bucket sums and how many steps contributed.
		 */
		function foldStepsByTier(nodes) {
			const empty = () => ({ cacheHit: 0, cacheMiss: 0, output: 0 });
			const result = { peak: empty(), offPeak: empty(), steps: 0 };
			for (const node of Array.isArray(nodes) ? nodes : []) {
				if (node?.kind !== 'assistant') continue;
				const buckets = stepBuckets(node.usage);
				if (buckets === undefined) continue;
				const at = stepTime(node);
				if (at === undefined) continue;
				const into = isPeakNow(at) ? result.peak : result.offPeak;
				into.cacheHit += buckets.cacheHit;
				into.cacheMiss += buckets.cacheMiss;
				into.output += buckets.output;
				result.steps += 1;
			}
			return result;
		}

		/** Sum one tier's three buckets. */
		function tierTotal(buckets) {
			return buckets.cacheHit + buckets.cacheMiss + buckets.output;
		}

		/**
		 * Price the session under both tiers.
		 *
		 * The whole-session bucket counts come from the cumulative `tokenUsage`
		 * projection, which is exact; the peak/off-peak *share* of each bucket comes
		 * from the visible steps, each judged by its own timestamp. Taking only the
		 * share from the steps means a paged chat window can bias the split but never
		 * the totals. With no usable step sample the whole session falls back to one
		 * tier, which is what a session inside a single window would give anyway.
		 * @param totals - the `tokenUsage` projection value, or undefined.
		 * @param fold - the per-step tier split.
		 * @param table - the model's rate table.
		 * @returns `{ cost, exact, peakShare }`.
		 */
		function priceByTier(totals, fold, table) {
			const peakSeen = tierTotal(fold.peak);
			const offSeen = tierTotal(fold.offPeak);
			const seen = peakSeen + offSeen;
			const source =
				totals === undefined || totals === null
					? { cacheHit: fold.peak.cacheHit + fold.offPeak.cacheHit, cacheMiss: fold.peak.cacheMiss + fold.offPeak.cacheMiss, output: fold.peak.output + fold.offPeak.output }
					: {
							cacheHit: totals.cacheReadTokens ?? 0,
							cacheMiss: (totals.uncachedInputTokens ?? 0) + (totals.cacheWriteTokens ?? 0),
							output: totals.outputTokens ?? 0
						};
			const overallPeakShare = seen > 0 ? peakSeen / seen : 0;
			let cost = 0;
			for (const key of ['cacheHit', 'cacheMiss', 'output']) {
				const bucketSeen = fold.peak[key] + fold.offPeak[key];
				const share = bucketSeen > 0 ? fold.peak[key] / bucketSeen : overallPeakShare;
				const amount = source[key];
				cost += ((amount * share) * table.peak[key] + (amount * (1 - share)) * table.offPeak[key]) / 1e6;
			}
			return { cost, exact: seen > 0, peakShare: overallPeakShare };
		}

		/** Read the chat snapshot's nodes through the slot's `useChat` hook. */
		function readChatNodes(useChat) {
			return typeof useChat === 'function' ? useChat((state) => state?.legacy?.nodes) : undefined;
		}

		/**
		 * Reduce wallets to one displayable total, preferring CNY.
		 * @param wallets - `{ currency, balance }` records from the account Remote.
		 * @returns `{ symbol, currency, amount }`, or undefined when none parses.
		 */
		function walletTotal(wallets) {
			if (!Array.isArray(wallets)) return undefined;
			const byCurrency = new Map();
			for (const wallet of wallets) {
				const amount = Number(wallet?.balance);
				if (!Number.isFinite(amount)) continue;
				const currency = wallet.currency ?? 'CNY';
				byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount);
			}
			if (byCurrency.has('CNY')) return { symbol: '¥', currency: 'CNY', amount: byCurrency.get('CNY') };
			const first = [...byCurrency.entries()][0];
			if (first === undefined) return undefined;
			return { symbol: first[0] === 'USD' ? '$' : '', currency: first[0], amount: first[1] };
		}

		/** Read one session projection through the slot's selector hook. */
		function readProjection(useProjection, key) {
			return typeof useProjection === 'function' ? useProjection(key) : undefined;
		}

		/* --------------------------------------------------------------- balance */

		/**
		 * Build the account store this panel reads.
		 *
		 * The account Remote pushes account *state* live but never its balance, so
		 * the balance is a one-shot read that must be repeated. Each reading is
		 * compared with the previous one; a drop is real money the platform took,
		 * and it is credited to whichever session was open at the time. Readings
		 * and the per-session ledger survive a page reload in browser storage.
		 * @param ctx - client plugin context.
		 * @returns the store the panel subscribes to.
		 */
		function createBalanceStore(ctx) {
			let snapshot = { status: 'idle' };
			const listeners = new Set();
			let inflight = null;
			let lastReadAt = 0;
			/** Account namespace resolved by the plugin's injection callback. */
			let attachedAccount;

			const publish = (patch) => {
				snapshot = { ...snapshot, ...patch };
				for (const listener of [...listeners]) listener();
			};

			/**
			 * Resolve the account Remote namespace currently attached by the
			 * injection callback. No access here may throw: an unusable namespace
			 * becomes a reported reason the panel shows, never a silent no-op that
			 * looks like "not read yet".
			 * @returns `{ account }` when callable, else `{ reason }`.
			 */
			const resolveAccount = () => {
				if (attachedAccount !== undefined) return { account: attachedAccount };
				try {
					const account = ctx.remote?.account;
					if (typeof account?.getBalance === 'function') return { account };
				} catch (error) {
					return { reason: describeRemoteError(error) };
				}
				return { reason: 'account Remote not mounted' };
			};

			const read = (options) => {
				try {
					const resolved = resolveAccount();
					if (resolved.account === undefined) {
						publish({ status: 'failed', reading: false, error: resolved.reason });
						return Promise.resolve();
					}
					if (inflight !== null) return inflight;
					const force = options?.force === true;
					const now = Date.now();
					if (!force && now - lastReadAt < BALANCE_MIN_INTERVAL_MS) return Promise.resolve();
					lastReadAt = now;
					let metadata;
					try {
						metadata = {
							version: CLIENT_VERSION,
							locale: ctx.locale.getSnapshot().active,
							timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
						};
					} catch {
						metadata = undefined;
					}
					publish({ reading: true });
					inflight = (async () => {
						try {
							const live = resolveAccount();
							if (live.account === undefined) {
								publish({ status: 'failed', reading: false, error: live.reason });
								return;
							}
							const result = await live.account.getBalance(metadata);
							if (result?.ok !== true)
								publish({ status: 'failed', reading: false, error: describeRemoteError(result?.error) });
							else if (result.value === null) publish({ status: 'signedOut', reading: false });
							else if (result.value?.status !== 'ready')
								publish({ status: 'failed', reading: false, error: 'balance query failed' });
							else {
								const recharge = Array.isArray(result.value.value) ? result.value.value : [];
								const bonus = Array.isArray(result.value.bonusWallets) ? result.value.bonusWallets : [];
								publish({
									status: 'ready',
									recharge,
									bonus,
									total: walletTotal([...recharge, ...bonus]),
									walletCount: recharge.length + bonus.length,
									reading: false,
									readAt: now
								});
							}
						} catch (error) {
							console.warn('[cost-meter] balance read failed:', error);
							publish({ status: 'failed', reading: false, error: describeRemoteError(error) });
						} finally {
							inflight = null;
						}
					})();
					return inflight;
				} catch (error) {
					console.warn('[cost-meter] balance read threw synchronously:', error);
					publish({ status: 'failed', reading: false, error: describeRemoteError(error) });
					return Promise.resolve();
				}
			};

			return {
				getSnapshot: () => snapshot,
				refresh: (options) => read(options),
				/**
				 * Hand the store the account namespace an injection callback resolved.
				 * A later call replaces an earlier one; undefined detaches it.
				 */
				attachAccount(account) {
					attachedAccount = account;
					void read({ force: true });
				},
				subscribe(listener) {
					listeners.add(listener);
					if (snapshot.status === 'idle') void read();
					return () => {
						listeners.delete(listener);
					};
				}
			};
		}

		/** Subscribe one component to the balance store. */
		function useBalance(store) {
			const [value, setValue] = useState(store.getSnapshot());
			useEffect(() => store.subscribe(() => setValue(store.getSnapshot())), [store]);
			return value;
		}

		/** Re-render on a locale switch without the registration-time locale seat. */
		function useLocaleRevision(locale) {
			const [revision, setRevision] = useState(0);
			useEffect(() => {
				try {
					return locale.subscribe(() => setRevision((value) => value + 1));
				} catch (error) {
					console.warn('[cost-meter] locale subscription failed:', error);
					return undefined;
				}
			}, [locale]);
			return revision;
		}

		/* ---------------------------------------------------------------- dialog */

		/**
		 * Place one portaled panel above its trigger, clamped to the viewport.
		 * @returns `{ left, top }` once measured, or undefined for the hidden
		 *   measure pass (the panel is laid out, so real dimensions are read).
		 */
		function useAnchoredPosition(open, anchorRef, panelRef) {
			const [pos, setPos] = useState(undefined);
			useEffect(() => {
				if (!open) {
					setPos(undefined);
					return undefined;
				}
				const place = () => {
					const anchor = anchorRef.current;
					const panel = panelRef.current;
					if (anchor === null || anchor === undefined) return;
					const rect = anchor.getBoundingClientRect();
					const width = panel?.offsetWidth ?? 300;
					const height = panel?.offsetHeight ?? 200;
					const left = Math.min(
						Math.max(rect.left + rect.width / 2 - width / 2, PANEL_MARGIN),
						Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN)
					);
					const top = Math.max(
						Math.max(rect.top - PANEL_GAP - height, PANEL_MARGIN),
						PANEL_MARGIN
					);
					setPos({ left: Math.round(left), top: Math.round(top) });
				};
				place();
				const frame = window.requestAnimationFrame(place);
				window.addEventListener('resize', place);
				return () => {
					window.cancelAnimationFrame(frame);
					window.removeEventListener('resize', place);
				};
			}, [open, anchorRef, panelRef]);
			return pos;
		}

		/** Close one panel on an outside pointer press or Escape. */
		function useDismiss(open, setOpen, anchorRef, panelRef) {
			useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const target = event.target;
					if (anchorRef.current?.contains(target) === true) return;
					if (panelRef.current?.contains(target) === true) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('pointerdown', onPointerDown, true);
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown, true);
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [open, setOpen, anchorRef, panelRef]);
		}

		/** Unplaced portal panel: hidden but laid out so the clamp measures it. */
		const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

		/* ------------------------------------------------------------------ icons */

		/** Gauge mark (the host's time-pill icon), drawn locally. */
		function GaugeMark() {
			return h(
				'svg',
				{ viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' },
				h('path', { d: 'M2.3 11.6a6.6 6.6 0 1 1 11.4 0' }),
				h('path', { d: 'M8 8.5 10.7 6.1' }),
				h('circle', { cx: 8, cy: 8.5, r: 1, fill: 'currentColor', stroke: 'none' })
			);
		}

		/** Database mark (the host's usage-pill icon), drawn locally. */
		function DatabaseMark() {
			return h(
				'svg',
				{ viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' },
				h('ellipse', { cx: 8, cy: 4.2, rx: 5, ry: 2.2 }),
				h('path', { d: 'M3 4.2v7.6c0 1.2 2.24 2.2 5 2.2s5-1 5-2.2V4.2' }),
				h('path', { d: 'M3 8c0 1.2 2.24 2.2 5 2.2s5-1 5-2.2' })
			);
		}

		/** Client plugin body. @param ctx - client plugin context. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'cost-meter: dictionaries');
			const t = ctx.locale.bind(NS);
			ctx.effect(() => {
				const tag = document.createElement('style');
				tag.dataset.plugin = 'dsh-cost-inline';
				tag.dataset.pluginCss = 'dsh-cost-inline/cost-meter.css';
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, 'cost-meter: styles');
			const balanceStore = createBalanceStore(ctx);
			/*
			 * The account Remote namespace is a service named `remote.account`, so it
			 * must be resolved through an injection. It is claimed with `ctx.inject`
			 * rather than the static `inject` list on purpose: the pills and the
			 * price-based estimate need no account at all, so gating the whole plugin
			 * on the account would trade a working estimate for a balance that may not
			 * be there. The balance section fills itself in the moment it resolves.
			 */
			try {
				ctx.inject(['remote.account'], (scope) => {
					const account = accountFromScope(scope);
					if (account === undefined) {
						console.warn('[cost-meter] account namespace is not callable in this scope');
						return;
					}
					balanceStore.attachAccount(account);
				});
			} catch (error) {
				/* The estimate needs no account, so a failed claim must not stop the
				   takeover; the balance row reports why it has nothing to show. */
				console.warn('[cost-meter] could not claim the account namespace:', error);
			}

			/**
			 * One of the dock's two pills. Owns its open state, its clamped panel and
			 * the portal that carries it above the composer.
			 * @param props - pill label, panel title, icon, detail rows and the shared
			 *   open seat.
			 */
			function StatPill(props) {
				const rootRef = useRef(null);
				const panelRef = useRef(null);
				const open = props.openPill === props.pillId;
				const setOpen = (next) => props.setOpenPill(next ? props.pillId : null);
				const pos = useAnchoredPosition(open, rootRef, panelRef);
				useDismiss(open, setOpen, rootRef, panelRef);
				const onToggle = () => setOpen(!open);

				const panel =
					open === true
						? ReactDOM.createPortal(
								h(
									'div',
									{
										ref: panelRef,
										className: 'cmtr_panel',
										role: 'dialog',
										'aria-label': props.panelTitle,
										style: pos ?? MEASURE_STYLE
									},
									h(
										'div',
										{ className: 'cmtr_title' },
										h(
											'span',
											{ className: 'cmtr_titleLabel' },
											h(props.icon),
											props.panelTitle
										),
										props.titleValue !== null && props.titleValue !== undefined
											? h('span', { className: 'cmtr_titleValue' }, props.titleValue)
											: null
									),
									h('div', { className: 'cmtr_titleRule' }),
									h('dl', { className: props.detailsClass }, props.rows),
									props.extra ?? null
								),
								document.body
							)
						: null;

				return h(
					'span',
					{ ref: rootRef, className: 'cmtr_anchor' },
					h(
						'button',
						{
							type: 'button',
							className: 'cmtr_pill',
							'aria-haspopup': 'dialog',
							'aria-expanded': open,
							'aria-label': props.ariaLabel,
							onClick: onToggle
						},
						h(props.icon),
						h('span', { className: 'cmtr_label' }, props.label)
					),
					panel
				);
			}

			/**
			 * The taken-over `stats` cell: the session's time pill and its token-usage
			 * pill, the second of which carries the cost and balance section.
			 */
			function StatsRow(props) {
				const t = props.t;
				const usage = readProjection(props.useProjection, 'tokenUsage');
				const stats = readProjection(props.useProjection, 'sessionStats');
				const selection = readProjection(props.useProjection, 'modelSelection');
				const nodes = readChatNodes(props.useChat);
				const balance = useBalance(balanceStore);
				const [openPill, setOpenPill] = useState(null);

				const totalTokens = usageTotal(usage);
				useEffect(() => {
					if (totalTokens > 0) balanceStore.refresh();
				}, [totalTokens]);

				const hasStats = stats !== undefined && stats !== null && (stats.steps ?? 0) > 0;
				const hasUsage = usageTotal(usage) > 0;

				/* Unit prices are published constants; every step is priced at the tier
				   in force at its own timestamp, not at whatever the clock reads now. */
				const table = PRICING[pickModelId(selection)] ?? PRICING[DEFAULT_MODEL];
				const pricing = priceByTier(usage, foldStepsByTier(nodes), table);

				const tps =
					hasStats && (stats.decodeMs ?? 0) > 0
						? formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3))
						: null;
				const counts = hasStats ? t('stats.counts', { turns: stats.turns ?? 0, steps: stats.steps ?? 0 }) : '';
				const timeLabel =
					tps === null
						? [counts]
						: [
								counts,
								h('span', { key: 'sep', className: 'cmtr_sep', 'aria-hidden': true }, '·'),
								t('message.tokensPerSecond', { tps })
							];
				const timeRows = hasStats
					? [
							(stats.llmMs ?? 0) > 0 ? detailRow('llm', t('stats.dialog.llmTime'), formatDuration(stats.llmMs, t)) : null,
							(stats.toolMs ?? 0) > 0 ? detailRow('tool', t('stats.dialog.toolTime'), formatDuration(stats.toolMs, t)) : null,
							(stats.ttftSteps ?? 0) > 0
								? detailRow('ttft', t('stats.dialog.ttft'), formatDuration(stats.ttftMs / stats.ttftSteps, t))
								: null,
							(stats.decodeMs ?? 0) > 0
								? detailRow(
										'speed',
										t('stats.dialog.speed'),
										t('message.tokensPerSecond', { tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) })
									)
								: null
						].filter((row) => row !== null)
					: [];

				const cacheHit = hasUsage ? formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage)) : null;
				const totalText = t('message.turnUsage.count', { count: formatTokens(totalTokens, t) });
				const usageRows = [
					cacheHit !== null ? detailRow('hit', t('message.turnUsage.cacheHit'), `${cacheHit}%`) : null,
					detailRow('input', t('message.turnUsage.input'), t('message.turnUsage.count', { count: formatExactTokens(usage?.uncachedInputTokens ?? 0, t) })),
					detailRow('read', t('message.turnUsage.cacheRead'), t('message.turnUsage.count', { count: formatExactTokens(usage?.cacheReadTokens ?? 0, t) })),
					(usage?.cacheWriteTokens ?? 0) !== 0
						? detailRow('write', t('message.turnUsage.cacheWrite'), t('message.turnUsage.count', { count: formatExactTokens(usage.cacheWriteTokens, t) }))
						: null,
					detailRow('output', t('message.turnUsage.output'), t('message.turnUsage.count', { count: formatExactTokens(usage?.outputTokens ?? 0, t) }))
				].filter((row) => row !== null);

				if (!hasStats && !hasUsage) return null;

				return h(
					'div',
					{ className: 'cmtr_root', 'data-composer-stats': true },
					hasStats
						? h(StatPill, {
								key: 'time',
								pillId: 'time',
								openPill,
								setOpenPill,
								icon: GaugeMark,
								label: timeLabel,
								ariaLabel: tps === null ? counts : `${counts} · ${tps}`,
								panelTitle: t('stats.dialog.title'),
								titleValue: null,
								detailsClass: 'cmtr_details',
								rows: timeRows
							})
						: null,
					hasUsage
						? h(StatPill, {
								key: 'usage',
								pillId: 'usage',
								openPill,
								setOpenPill,
								icon: DatabaseMark,
								label:
									cacheHit === null
										? [totalText]
										: [
												totalText,
												h('span', { key: 'sep', className: 'cmtr_sep', 'aria-hidden': true }, '·'),
												t('stats.cacheHit', { percent: cacheHit })
											],
								ariaLabel: cacheHit === null ? totalText : `${totalText} · ${t('stats.cacheHit', { percent: cacheHit })}`,
								panelTitle: t('stats.dialog.usageTitle'),
								titleValue: t('message.turnUsage.count', { count: formatExactTokens(totalTokens, t) }),
								detailsClass: 'cmtr_details',
								rows: usageRows,
								extra: h(MoneySection, {
									balance,
									t,
									store: balanceStore,
									table,
									tierCost: pricing.cost,
									tierExact: pricing.exact,
									peakShare: pricing.peakShare
								})
							})
						: null
				);
			}

			/** One `<dt>/<dd>` pair of a details grid. */
			function detailRow(key, term, description) {
				return [h('dt', { key: `${key}-t` }, term), h('dd', { key: `${key}-d` }, description)];
			}

			/** Text for the balance row while no wallet amount is available yet. */
			function balanceStateText(balance, t) {
				const status = balance?.status ?? 'idle';
				if (status === 'signedOut') return t('money.signedOut');
				if (status === 'unavailable') return t('money.unavailable');
				if (status === 'failed')
					return balance?.error === undefined
						? t('money.unavailable')
						: `${t('money.unavailable')} · ${balance.error}`;
				if (status === 'ready') return balance?.walletCount === 0 ? t('money.noWallets') : t('money.unparsed');
				return balance?.reading === true ? t('money.refreshing') : t('money.pending');
			}

			/**
			 * The money section appended to the token-usage panel: the per-step,
			 * per-tier cost estimate first, then the account balance.
			 */
			function MoneySection(props) {
				const { balance, t, store, table, tierCost, tierExact, peakShare } = props;
				const status = balance?.status ?? 'idle';
				const rows = [];

				const costText = formatCost(tierCost);
				if (costText !== null) {
					rows.push(
						...detailRow(
							'estimate',
							t('money.estimate'),
							h('span', { className: 'cmtr_spend' }, `≈${table.symbol}${costText}`)
						)
					);
				}

				const settled = status === 'ready' && balance.total !== undefined;
				if (settled) {
					rows.push(
						...detailRow('balance', t('money.balance'), `${balance.total.symbol}${formatAmount(balance.total.amount)}`)
					);
					const recharge = walletTotal(balance.recharge);
					const bonus = walletTotal(balance.bonus);
					if (recharge !== undefined)
						rows.push(...detailRow('recharge', t('money.recharge'), `${recharge.symbol}${formatAmount(recharge.amount)}`));
					if (bonus !== undefined && bonus.amount > 0)
						rows.push(...detailRow('bonus', t('money.bonus'), `${bonus.symbol}${formatAmount(bonus.amount)}`));
				} else {
					rows.push(...detailRow('balance', t('money.balance'), balanceStateText(balance, t)));
				}

				const notes = [];
				if (costText !== null) {
					/* Exactly one small line: the peak share of the billed tokens, or a
					   plain statement that the split could not be computed. */
					notes.push(
						tierExact
							? t('money.splitNote', { percent: Math.round((peakShare ?? 0) * 100) })
							: t('money.blendNote')
					);
				}

				return h(
					'div',
					null,
					h('div', { className: 'cmtr_rule' }),
					h(
						'div',
						{ className: 'cmtr_sectionTitle' },
						h('span', null, t('money.title')),
						h(
							'button',
							{
								type: 'button',
								className: 'cmtr_refresh',
								disabled: balance?.reading === true,
								onClick: () => store.refresh({ force: true })
							},
							balance?.reading === true ? t('money.refreshing') : t('money.refresh')
						)
					),
					h('dl', { className: 'cmtr_details' }, rows),
					notes.map((note, index) => h('div', { key: `note-${index}`, className: 'cmtr_note' }, note))
				);
			}

			ctx.slots.inject('conversation.composer.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.composer.dock',
						/* Same cell as the shipped readout, at a lower priority so this
						   head wins and nothing new is added to the composer's layout. */
						id: 'stats',
						order: 0,
						priority: -1,
						label: () => t('stats.dialog.usageTitle')
					},
					StatsRowWrapped
				)
			);

			/**
			 * Locale- and balance-aware wrapper: `t` follows locale switches, and the
			 * store is bound before the row renders.
			 */
			function StatsRowWrapped(props) {
				useLocaleRevision(ctx.locale);
				return h(StatsRow, { ...props, t });
			}
		}

		return {
			inject: ['slots', 'locale', 'remote'],
			apply
		};
	}
});
