import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
	type ConversationId,
	createRegistry,
	defineDoc,
	defineExtension,
	Harness,
	LiveDoc,
	section,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { config, parseModel } from "./config.ts";
import { demoProvider } from "./demo-model.ts";
import { containerName, Sandboxes } from "./sandbox.ts";

export const context = BACKGROUND_CONTEXT;

/** `slug` names the agent's container and project directory; conversation ids restart with a new database. */
export type AgentInfo = { name: string; slug: string; createdAt: number };

/** The hub's agent list, committed together with each agent's conversation. */
export const Agents = defineDoc<{ items: Record<string, AgentInfo> }>({
	kind: "hub.agents",
	version: 1,
	scope: "session",
	initial: () => ({ items: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** How a person's message is shown; the model sees it as a user message prefixed with the author. */
export const MESSAGE_KIND = "hub.message";

const Hub = defineExtension({
	name: "hub",
	sections: [
		section(
			"preamble",
			() =>
				"You are a coding agent. Your tools run inside an isolated Linux container; the project lives in /workspace. " +
				"Several people may write to you; each message starts with its author's name in brackets.",
			{ tag: false },
		),
		section("cwd", (input) => input.env?.cwd),
	],
});

export async function openHub() {
	await mkdir(config.dataDir, { recursive: true });
	const model = parseModel(config.model);

	const models = createModels();
	models.setProvider(model.provider === "faux" ? demoProvider() : anthropicProvider());

	const registry = createRegistry();
	registry.install(createCodingTools());
	registry.install(Hub);

	const sandboxes = new Sandboxes();
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(config.dataDir, "agents.sqlite")),
		{
			models,
			registry,
			settings: {
				retry: { maxRetries: 3 },
				toolExecution: "parallel",
				// A failed model call should not leave later messages from other people stuck in the queue.
				afterFailedRun: "continue",
			},
			env: async ({ conversationId, read }, envContext) => {
				const agent = (await read.snapshot(Agents, envContext))?.items[conversationId];
				return agent === undefined ? undefined : sandboxes.env(agent.slug);
			},
			onReport: (error, info) => console.error(`[report] ${info.type}`, error),
		},
		context,
	);

	async function listAgents() {
		const doc = await harness.snapshot(Agents, context);
		const items = Object.entries(doc?.items ?? {});
		return Promise.all(
			items.map(async ([id, info]) => {
				const live = await harness.snapshot(LiveDoc, Number(id) as ConversationId, context);
				return { id: Number(id), ...info, container: containerName(info.slug), busy: live?.run !== undefined };
			}),
		);
	}

	async function createAgent(name: string) {
		const slug = randomBytes(4).toString("hex");
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model },
				init: async (tx, id) => {
					(await tx.doc(Agents)).items[id] = { name, slug, createdAt: Date.now() };
				},
			},
			context,
		);
		// Container start is not part of the commit: a crash here just means it starts on the agent's first tool call.
		await sandboxes.ensure(slug);
		return { id: conversation.id, name, container: containerName(slug) };
	}

	async function close() {
		await harness.close(context);
		sandboxes.close();
	}

	return { harness, listAgents, createAgent, close, model };
}
