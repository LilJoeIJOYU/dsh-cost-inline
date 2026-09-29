/**
 * Host half of the cost-meter bundle.
 *
 * Everything the user sees is computed in the browser from data the Client
 * already receives — the session's cumulative `tokenUsage` projection, the
 * `modelSelection` projection, and the account Remote's `getBalance` read — so
 * this half registers nothing and only exists so the bundle has a Host row the
 * Loader can mount and the `dsh.client` declaration has an owning entry.
 */

/** Host plugin body — no host-side behavior for this tooltip plugin. */
export function apply() {}
