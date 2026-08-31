/**
 * Session-global state example.
 *
 * Stores one extension setting across resume, reload, tree navigation, and derived
 * sessions without adding it to the conversation tree or model context.
 *
 * Usage: /feature-state [on|off|clear]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type FeatureState = {
	enabled: boolean;
};

/** Shared session-state namespace key used by this example. */
const STATE_KEY = "example.feature-state";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Read through the session context when reconstructing extension runtime state.
		const state = ctx.sessionManager.getSessionState<FeatureState>(STATE_KEY);
		ctx.ui.setStatus("feature-state", state?.enabled ? "feature:on" : undefined);
	});

	pi.registerCommand("feature-state", {
		description: "Show or set durable session-global feature state",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "clear") {
				// Undefined appends a tombstone, making the key absent after reopen and derivation.
				pi.setSessionState(STATE_KEY, undefined);
				ctx.ui.setStatus("feature-state", undefined);
				ctx.ui.notify("Feature state cleared", "info");
				return;
			}

			if (action === "on" || action === "off") {
				const state: FeatureState = { enabled: action === "on" };
				pi.setSessionState(STATE_KEY, state);
				ctx.ui.setStatus("feature-state", state.enabled ? "feature:on" : undefined);
			}

			// Report the effective value after any requested write.
			const state = pi.getSessionState<FeatureState>(STATE_KEY);
			ctx.ui.notify(state === undefined ? "Feature state is absent" : `Feature is ${state.enabled ? "on" : "off"}`);
		},
	});
}
