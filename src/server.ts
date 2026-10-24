import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type ConversationId, ConversationBusy, watchEvents } from "@earendil-works/pi-durable";
import { config } from "./config.ts";
import { context, MESSAGE_KIND, openHub } from "./hub.ts";

const hub = await openHub();
const { harness } = hub;
// Continue whatever the previous process left unfinished.
harness.resume();
harness.closed.then((end) => {
	if (end.reason === "failed") {
		console.error("Harness failed, exiting so the supervisor restarts the hub:", end.error);
		process.exit(1);
	}
});

const indexHtml = new URL("../public/index.html", import.meta.url);

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function json(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 1024 * 1024) throw new HttpError(413, "body too large");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		throw new HttpError(400, "invalid JSON");
	}
}

function str(value: unknown, field: string, max = 100_000): string {
	if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${field} is required`);
	if (value.length > max) throw new HttpError(400, `${field} is too long`);
	return value.trim();
}

function authorized(req: IncomingMessage, url: URL): boolean {
	if (config.token === "") return true;
	// EventSource cannot send headers, so the token may also come as a query parameter.
	return req.headers.authorization === `Bearer ${config.token}` || url.searchParams.get("token") === config.token;
}

async function agent(id: ConversationId) {
	const conversation = await harness.conversation(id, context).catch(() => undefined);
	if (conversation === undefined) throw new HttpError(404, "no such agent");
	return conversation;
}

async function streamEvents(req: IncomingMessage, res: ServerResponse, id: ConversationId) {
	await agent(id);
	const stream = await watchEvents(harness, id, context);
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const send = (events: unknown) => res.write(`data: ${JSON.stringify(events)}\n\n`);
	send([stream.snapshot]);
	stream.start(async (events) => {
		send(events);
	});
	const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
	const stop = () => {
		clearInterval(heartbeat);
		void stream.stop();
	};
	req.on("close", stop);
	stream.closed.then(() => res.end(), () => res.end());
}

async function route(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", "http://hub");
	const parts = url.pathname.split("/").filter(Boolean);

	if (req.method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(await readFile(indexHtml));
		return;
	}
	if (parts[0] !== "api") throw new HttpError(404, "not found");
	if (!authorized(req, url)) throw new HttpError(401, "unauthorized");

	// GET /api/agents, POST /api/agents
	if (parts.length === 2 && parts[1] === "agents") {
		if (req.method === "GET") return json(res, 200, { model: `${hub.model.provider}/${hub.model.modelId}`, agents: await hub.listAgents() });
		if (req.method === "POST") {
			const body = await readJson(req);
			return json(res, 201, await hub.createAgent(str(body.name, "name", 100)));
		}
	}

	const id = Number(parts[2]) as ConversationId;
	const action = parts[3];
	if (parts[1] !== "agents" || !Number.isSafeInteger(id) || parts.length !== 4) throw new HttpError(404, "not found");

	if (req.method === "GET" && action === "events") return streamEvents(req, res, id);

	if (req.method === "POST" && action === "messages") {
		const body = await readJson(req);
		const author = str(body.author, "author", 100);
		const text = str(body.text, "text");
		const whenBusy = body.mode === "steer" ? "steer" : "followUp";
		const conversation = await agent(id);
		try {
			const submission = await conversation.submit(
				{
					type: "input",
					content: `[${author}] ${text}`,
					entry: { kind: MESSAGE_KIND, data: { author, text } },
					// The client generates it, so a retry after a dropped connection is not sent twice.
					requestId: typeof body.requestId === "string" ? body.requestId : undefined,
					whenBusy,
				},
				context,
			);
			return json(res, 202, { submissionId: submission.id });
		} catch (error) {
			if (error instanceof ConversationBusy) throw new HttpError(409, "agent is busy");
			throw error;
		}
	}

	if (req.method === "POST" && action === "abort") {
		await (await agent(id)).abort(context);
		return json(res, 200, { ok: true });
	}

	throw new HttpError(404, "not found");
}

const server = createServer((req, res) => {
	route(req, res).catch((error) => {
		const status = error instanceof HttpError ? error.status : 500;
		if (status === 500) console.error(error);
		if (res.headersSent) res.end();
		else json(res, status, { error: error instanceof Error ? error.message : String(error) });
	});
});

server.listen(config.port, config.host, () => {
	console.log(`pi-agent-hub on http://${config.host}:${config.port}  model=${config.model}  data=${config.dataDir}`);
	if (config.token === "" && config.host !== "127.0.0.1" && config.host !== "localhost") {
		console.warn("WARNING: listening beyond localhost without HUB_TOKEN; anyone who can reach the port can drive the agents.");
	}
});

let closing = false;
async function shutdown() {
	if (closing) return;
	closing = true;
	server.close();
	server.closeAllConnections();
	await hub.close();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
