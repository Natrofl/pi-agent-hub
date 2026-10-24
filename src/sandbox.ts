import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Connection, localDaemon, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { config } from "./config.ts";

const run = promisify(execFile);

const DAEMON_PATH = "/opt/pi-env/pi-env";
const WORKSPACE = "/workspace";

export function containerName(slug: string): string {
	return `pi-agent-${slug}`;
}

export function projectDir(slug: string): string {
	return join(config.dataDir, "projects", slug);
}

async function docker(...args: string[]): Promise<string> {
	const { stdout } = await run("docker", args, { maxBuffer: 1024 * 1024 });
	return stdout.trim();
}

/**
 * One long-lived container per agent. Tools never run on the host: the pi-env daemon is mounted into the container
 * and started over `docker exec -i`, so the agent sees only /workspace and none of the hub's environment variables.
 */
export class Sandboxes {
	#envs = new Map<string, RemoteExecutionEnv>();
	#starting = new Map<string, Promise<void>>();

	env(slug: string): RemoteExecutionEnv {
		let env = this.#envs.get(slug);
		if (env === undefined) {
			const name = containerName(slug);
			const connection = new Connection({
				command: async () => {
					await this.ensure(slug);
					return ["docker", "exec", "-i", name, DAEMON_PATH];
				},
				onLog: (text) => console.error(`[${name}] ${text.trimEnd()}`),
			});
			env = new RemoteExecutionEnv({ connection, id: `pi-env:${name}`, cwd: WORKSPACE });
			this.#envs.set(slug, env);
		}
		return env;
	}

	/** Starts the agent's container, creating it on first use; concurrent callers share one attempt. */
	ensure(slug: string): Promise<void> {
		let pending = this.#starting.get(slug);
		if (pending === undefined) {
			pending = this.#ensure(slug).finally(() => this.#starting.delete(slug));
			this.#starting.set(slug, pending);
		}
		return pending;
	}

	async #ensure(slug: string): Promise<void> {
		const name = containerName(slug);
		const state = await docker("inspect", "-f", "{{.State.Running}}", name).catch(() => "missing");
		if (state === "true") return;
		if (state === "false") {
			await docker("start", name);
			return;
		}
		const dir = projectDir(slug);
		await mkdir(dir, { recursive: true });
		const uid = process.getuid?.() ?? 1000;
		const gid = process.getgid?.() ?? 1000;
		await docker(
			"run", "-d",
			"--name", name,
			"--label", "pi-agent-hub=1",
			"--init",
			// Survives a Docker or host restart on its own; the hub reattaches by name.
			"--restart", "unless-stopped",
			// The host user's ids, so files the agent writes in the bind mount stay editable outside.
			"--user", `${uid}:${gid}`,
			"--cap-drop", "ALL",
			"--security-opt", "no-new-privileges",
			"--memory", config.sandbox.memory,
			"--cpus", config.sandbox.cpus,
			"--pids-limit", config.sandbox.pids,
			"--network", config.sandbox.network,
			"-e", "HOME=/tmp",
			"-v", `${dir}:${WORKSPACE}`,
			"-v", `${localDaemon()}:${DAEMON_PATH}:ro`,
			"-w", WORKSPACE,
			config.sandbox.image,
			"sleep", "infinity",
		);
	}

	close(): void {
		for (const env of this.#envs.values()) env.connection.close();
		this.#envs.clear();
	}
}
