import { resolve } from "node:path";

const env = process.env;

export const config = {
	host: env.HOST ?? "127.0.0.1",
	port: Number(env.PORT ?? 8787),
	dataDir: resolve(env.DATA_DIR ?? "./data"),
	/** Without a key the hub runs on the scripted demo model, so crashes can be tested for free. */
	model: env.MODEL ?? (env.ANTHROPIC_API_KEY ? "anthropic/claude-sonnet-5-5" : "faux/demo"),
	/** Empty: no auth, only for a hub bound to localhost. */
	token: env.HUB_TOKEN ?? "",
	sandbox: {
		image: env.AGENT_IMAGE ?? "ubuntu:24.04",
		memory: env.AGENT_MEMORY ?? "2g",
		cpus: env.AGENT_CPUS ?? "2",
		pids: env.AGENT_PIDS ?? "512",
		network: env.AGENT_NETWORK ?? "bridge",
	},
};

export function parseModel(spec: string): { provider: string; modelId: string } {
	const slash = spec.indexOf("/");
	if (slash <= 0) throw new Error(`MODEL must look like provider/modelId, got "${spec}"`);
	return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}
