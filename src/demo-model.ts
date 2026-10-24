import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

/**
 * A scripted model for trying the hub without an API key. A message starting with `$` runs the rest in the agent's
 * container through the real bash tool; anything else is echoed back.
 */
export function demoProvider() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "demo" }], tokensPerSecond: 40 });
	// The faux queue consumes each step once, so the step puts itself back for the next request.
	const step = (context: TranscriptContext): AssistantMessage => {
		faux.appendResponses([step]);
		return respond(context);
	};
	faux.setResponses([step]);
	return faux.provider;
}

function respond(context: TranscriptContext): AssistantMessage {
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") {
		const output = last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		return fauxAssistantMessage(`Команда выполнена${last.isError ? " с ошибкой" : ""}. Вывод:\n\n${output}`);
	}
	const text = last?.role === "user" ? userText(last.content) : "";
	const command = text.match(/\$\s*(.+)$/s)?.[1];
	if (command !== undefined) {
		return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
	}
	return fauxAssistantMessage(`Демо-модель получила: «${text}». Начните сообщение с $, чтобы выполнить команду.`);
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}
