import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("installed Pi CLI maps a thrown pi-graph tool error onto the JSON event contract offline", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-real-pi-contract-"));
	try {
		const extensionPath = join(directory, "offline-provider.mjs");
		const piAiUrl = import.meta.resolve("@earendil-works/pi-ai");
		await writeFile(
			extensionPath,
			`import { createFauxCore, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(piAiUrl)};

export default function offlineContractProvider(pi) {
  const faux = createFauxCore({
    api: "pi-graph-contract-api",
    provider: "pi-graph-contract",
    models: [{ id: "offline", name: "Offline Contract Model", reasoning: false, input: ["text"] }],
    tokenSize: { min: 1000, max: 1000 },
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("pi_graph_inspect", { runId: "missing" }, { id: "contract-tool" }), { stopReason: "toolUse", timestamp: 1 }),
    fauxAssistantMessage("pi-graph-real-cli-contract-ok", { timestamp: 2 }),
  ]);
  pi.registerProvider(faux.provider, {
    name: "Pi Graph Offline Contract Provider",
    baseUrl: "http://localhost:0",
    apiKey: "offline-contract-key",
    api: faux.api,
    models: faux.models.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
      id, name, reasoning, input, cost, contextWindow, maxTokens,
    })),
    streamSimple: faux.streamSimple,
  });
}
`,
			"utf8",
		);

		const piPackageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const piCli = join(dirname(piPackageEntry), "cli.js");
		if (!existsSync(piCli)) {
			context.skip("The installed Pi package does not include its CLI entrypoint in this test environment");
			return;
		}
		const piGraphExtension = fileURLToPath(new URL("../extensions/pi-graph.ts", import.meta.url));
		const agentDir = join(directory, "agent");
		const cliArgs = [
			piCli,
			"--mode",
			"json",
			"-p",
			"--no-approve",
			"--no-session",
			"--no-extensions",
			"--extension",
			extensionPath,
			"--extension",
			piGraphExtension,
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--tools",
			"pi_graph_inspect",
			"--offline",
			"--model",
			"pi-graph-contract/offline",
			"contract prompt",
		];
		const cliResult = spawnSync(process.execPath, cliArgs, {
			cwd: directory,
			env: {
				...process.env,
				// The test suite itself runs through tsx. Do not inject its loader into the
				// real CLI subprocess or classify it as another node:test worker; the CLI
				// must exercise its installed Node entrypoint.
				NODE_OPTIONS: "",
				NODE_TEST_CONTEXT: "",
				PI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
			},
			timeout: 20_000,
			maxBuffer: 4 * 1024 * 1024,
			encoding: "utf8",
			// Pi accepts piped prompts, so explicitly close stdin even though this
			// contract supplies its prompt as a positional argument.
			input: "",
		});
		if (cliResult.error || cliResult.status !== 0) {
			throw new Error(
				`Real Pi CLI failed (status=${String(cliResult.status)}, signal=${String(cliResult.signal)}).\nstdout:\n${cliResult.stdout}\nstderr:\n${cliResult.stderr}`,
				{ cause: cliResult.error },
			);
		}
		const stdout = cliResult.stdout;

		const events = stdout
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		assert.ok(events.length > 1);
		assert.equal(events[0]?.type, "session");
		assert.equal(events[0]?.version, 3);
		assert.equal(events[0]?.cwd, directory);

		const toolEnd = events.find(
			(event) => event.type === "tool_execution_end" && event.toolName === "pi_graph_inspect",
		);
		assert.ok(toolEnd);
		assert.equal(toolEnd.isError, true);
		assert.equal(toolEnd.toolCallId, "contract-tool");
		assert.match(JSON.stringify(toolEnd.result), /pi-graph inspect failed.*checkpoint does not exist/);

		const messageEnd = events.findLast(
			(event) =>
				event.type === "message_end" &&
				typeof event.message === "object" &&
				event.message !== null &&
				(event.message as Record<string, unknown>).role === "assistant",
		);
		assert.ok(messageEnd);
		const message = messageEnd.message as Record<string, unknown>;
		assert.equal(message.provider, "pi-graph-contract");
		assert.equal(message.model, "offline");
		assert.deepEqual(message.content, [{ type: "text", text: "pi-graph-real-cli-contract-ok" }]);
		assert.ok(events.some((event) => event.type === "agent_end"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
