import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient clone", () => {
	it("sends the clone RPC command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "clone",
			success: true,
			data: { cancelled: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.clone();

		expect(send).toHaveBeenCalledWith({ type: "clone" });
		expect(result).toEqual({ cancelled: false });
	});
});

describe("RpcClient direct tool commands", () => {
	it("sends the get_all_tools RPC command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_all_tools",
			success: true,
			data: { tools: [{ name: "read" }] },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.getAllTools();

		expect(send).toHaveBeenCalledWith({ type: "get_all_tools" });
		expect(result).toEqual([{ name: "read" }]);
	});

	it("sends the execute_tool RPC command without context-oriented fields", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "execute_tool",
			success: true,
			data: {
				toolName: "read",
				toolCallId: "direct-1",
				content: [{ type: "text", text: "ok" }],
				details: {},
				isError: false,
			},
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.executeTool("read", { path: "README.md" }, { toolCallId: "direct-1" });

		expect(send).toHaveBeenCalledWith({
			type: "execute_tool",
			toolName: "read",
			input: { path: "README.md" },
			toolCallId: "direct-1",
		});
		expect(result).toMatchObject({ toolName: "read", toolCallId: "direct-1", isError: false });
	});
});
