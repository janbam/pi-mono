import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type RebindContext = {
	session: { setBeforeProviderRequest: (callback: () => void | Promise<void>) => void };
	cacheWarmController: {
		pause: () => Promise<void>;
		rebind: (session: RebindContext["session"], options?: { resume?: boolean }) => Promise<void>;
		resume: () => Promise<void>;
	};
	unsubscribe?: () => void;
	applyRuntimeSettings: () => void;
	renderCurrentSessionState: () => void;
	bindCurrentSessionExtensions: () => Promise<void>;
	bindCacheWarmSessionHooks: () => void;
	subscribeToAgent: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
};

type InteractiveModePrototype = {
	rebindCurrentSession(this: RebindContext, options?: { renderBeforeBind?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("overlapping startup and replacement session rebinds", () => {
	it("does not subscribe from the stale startup rebind", async () => {
		// Give both synthetic sessions the lifecycle surface owned by real AgentSession instances.
		const startupSession = { setBeforeProviderRequest: () => {} };
		const replacementSession = { setBeforeProviderRequest: () => {} };
		let resolveStartupBind!: () => void;
		let resolveReplacementBind!: () => void;

		const startupBind = new Promise<void>((resolve) => {
			resolveStartupBind = resolve;
		});
		const replacementBind = new Promise<void>((resolve) => {
			resolveReplacementBind = resolve;
		});

		const subscribeToAgent = vi.fn();
		const updateTerminalTitle = vi.fn();
		let bindCount = 0;

		const context: RebindContext = {
			session: startupSession,
			cacheWarmController: { pause: async () => {}, rebind: async () => {}, resume: async () => {} },
			applyRuntimeSettings: () => {},
			renderCurrentSessionState: () => {},
			bindCurrentSessionExtensions: () => {
				bindCount += 1;
				return bindCount === 1 ? startupBind : replacementBind;
			},
			bindCacheWarmSessionHooks: () => {},
			subscribeToAgent,
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor: () => {},
			updateTerminalTitle,
		};

		const startupRebind = interactiveModePrototype.rebindCurrentSession.call(context);
		await vi.waitFor(() => expect(bindCount).toBe(1));

		context.session = replacementSession;
		const replacementRebind = interactiveModePrototype.rebindCurrentSession.call(context, {
			renderBeforeBind: true,
		});

		await vi.waitFor(() => expect(bindCount).toBe(2));
		expect(subscribeToAgent).toHaveBeenCalledTimes(1);

		resolveStartupBind();
		await startupRebind;

		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).not.toHaveBeenCalled();

		resolveReplacementBind();
		await replacementRebind;

		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).toHaveBeenCalledTimes(1);
	});
});
