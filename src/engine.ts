import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	CheckpointConflictError,
	CheckpointDurabilityError,
	CheckpointLeaseError,
	CheckpointValidationError,
	type CheckpointRun,
	type CheckpointStore,
} from "./checkpoint.ts";
import { evaluateCondition } from "./condition.ts";
import type {
	AgentNodeDefinition,
	AgentThreadState,
	CheckpointSnapshot,
	CompiledGraph,
	ExecutionBudget,
	GraphDefinition,
	GraphLimits,
	GraphRunEvent,
	GraphRunOptions,
	GraphRunResult,
	InFlightStep,
	JsonObject,
	NodeDefinition,
	NodeExecutionContext,
	NodeExecutionFailure,
	NodeExecutionResult,
	NodeExecutionSuccess,
	NodeExecutor,
	NodeLimits,
	NodeRunHistory,
	NodeUsage,
	StateWrite,
	UsageLedger,
} from "./types.ts";
import { END } from "./types.ts";
import {
	addUsage,
	applyStateWrites,
	asStringArray,
	deepCloneJson,
	deepMergeObjects,
	emptyUsage,
	errorMessage,
	getPath,
	isJsonObject,
	setPath,
	stateSizeBytes,
	uniqueStrings,
	usageTokens,
} from "./utils.ts";

type ResolvedGraphLimits = Required<
	Pick<
		GraphLimits,
		"maxSteps" | "maxNodeRuns" | "maxConcurrency" | "maxCostUsd" | "maxTokens" | "timeoutMs" | "maxStateBytes" | "maxPromptBytes"
	>
>;

const DEFAULT_LIMITS: ResolvedGraphLimits = {
	maxSteps: 32,
	maxNodeRuns: 128,
	maxConcurrency: 4,
	maxCostUsd: 10,
	maxTokens: 1_000_000,
	timeoutMs: 30 * 60 * 1000,
	maxStateBytes: 2 * 1024 * 1024,
	maxPromptBytes: 256 * 1024,
};

export interface GraphEngineConfig {
	checkpointStore?: CheckpointStore;
	graphSource?: string;
}

interface FailureResolution {
	success?: NodeExecutionSuccess;
	fatal?: NodeExecutionFailure;
	historyStatus: "completed" | "failed" | "interrupted";
	historyError?: string;
}

export class GraphLimitError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "GraphLimitError";
		this.code = code;
	}
}

export class GraphEngine {
	readonly graph: CompiledGraph;
	readonly executor: NodeExecutor;
	readonly checkpointStore: CheckpointStore | undefined;
	readonly graphSource: string | undefined;

	constructor(graph: CompiledGraph, executor: NodeExecutor, config: GraphEngineConfig = {}) {
		this.graph = graph;
		this.executor = executor;
		this.checkpointStore = config.checkpointStore;
		this.graphSource = config.graphSource;
	}

	async run(options: GraphRunOptions = {}): Promise<GraphRunResult> {
		const limits = resolveLimits(this.graph.definition.limits);
		const checkpointRequested = options.checkpoint ?? true;
		if (options.runId && !checkpointRequested) throw new Error("Cannot resume with checkpoint: false");
		const checkpointEnabled = checkpointRequested && this.checkpointStore !== undefined;
		const invocationStartedAt = Date.now();
		let baseActiveTimeMs = 0;
		let checkpointRun: CheckpointRun | undefined;
		let resumeInterruptNodeId: string | undefined;
		try {
			let snapshot: CheckpointSnapshot;
			if (options.runId) {
				if (!this.checkpointStore) throw new Error("Cannot resume without a checkpoint store");
				checkpointRun = await this.checkpointStore.open({ mode: "resume", runId: options.runId });
				snapshot = checkpointRun.snapshot;
				baseActiveTimeMs = snapshot.activeTimeMs;
				this.assertCheckpointGraph(snapshot, options.forceGraphVersion ?? false);
				if (snapshot.status === "completed") return resultFromSnapshot(snapshot, this.graph.definition);
				if (snapshot.interrupt && options.resumeValue === undefined) return resultFromSnapshot(snapshot, this.graph.definition);
				resumeInterruptNodeId = snapshot.interrupt?.nodeId;
				snapshot.interrupt = undefined;
				snapshot.status = "running";
				snapshot.error = undefined;
				snapshot.endedAt = undefined;
				snapshot.updatedAt = nowIso();
			} else {
				snapshot = this.createSnapshot(options.input ?? {});
				if (checkpointEnabled && this.checkpointStore) {
					checkpointRun = await this.checkpointStore.open({ mode: "create", snapshot });
				}
			}

			const runOptions = checkpointRun
				? { ...options, signal: options.signal ? AbortSignal.any([options.signal, checkpointRun.signal]) : checkpointRun.signal }
				: options;
			const budget = new GraphBudget(snapshot.usage, limits);

			try {
				this.assertStateWithinPolicy(snapshot.state, limits);
				await this.emit(runOptions, {
					type: "graph_start",
					runId: snapshot.runId,
					timestamp: nowIso(),
					step: snapshot.step,
					status: "running",
					usage: copyUsage(snapshot.usage),
				});
				await this.save(snapshot, checkpointRun, runOptions, baseActiveTimeMs, invocationStartedAt);

				while (true) {
					this.assertRunActive(snapshot, runOptions.signal, limits, baseActiveTimeMs, invocationStartedAt);
					budget.assertGraphWithinLimits();

					if (!snapshot.inFlight) {
						const scheduled = uniqueStrings(snapshot.pending.filter((nodeId) => nodeId !== END));
						if (scheduled.length === 0) {
							return await this.finish(
								snapshot,
								"completed",
								undefined,
								checkpointRun,
								runOptions,
								baseActiveTimeMs,
								invocationStartedAt,
							);
						}
						if (snapshot.step >= limits.maxSteps) {
							throw new GraphLimitError("MAX_STEPS", `Graph exceeded maxSteps (${limits.maxSteps})`);
						}
						snapshot.step += 1;
						snapshot.pending = [];
						snapshot.inFlight = {
							step: snapshot.step,
							scheduled,
							unresolved: [...scheduled],
							completed: {},
						};
						this.prepareThreadStates(snapshot, scheduled);
						await this.emit(runOptions, {
							type: "step_start",
							runId: snapshot.runId,
							timestamp: nowIso(),
							step: snapshot.step,
							scheduled: [...scheduled],
							message: scheduled.join(", "),
						});
						await this.save(snapshot, checkpointRun, runOptions, baseActiveTimeMs, invocationStartedAt);
					}

					const stepResult = await this.executeInFlight(
						snapshot,
						resumeInterruptNodeId,
						budget,
						limits,
						runOptions,
						checkpointRun,
						baseActiveTimeMs,
						invocationStartedAt,
					);
					resumeInterruptNodeId = undefined;
					if (stepResult) return stepResult;
				}
			} catch (error) {
				if (isCheckpointControlError(error)) throw error;
				if (checkpointRun?.signal.aborted) {
					throw checkpointRun.signal.reason ?? new CheckpointLeaseError("RUN_LEASE_LOST", `Lease for ${snapshot.runId} was lost`);
				}
				const status = runOptions.signal?.aborted ? "cancelled" : "failed";
				return await this.finish(
					snapshot,
					status,
					errorMessage(error),
					checkpointRun,
					runOptions,
					baseActiveTimeMs,
					invocationStartedAt,
					false,
				);
			}
		} finally {
			await closeCheckpointRun(checkpointRun);
		}
	}

	private async executeInFlight(
		snapshot: CheckpointSnapshot,
		resumeInterruptNodeId: string | undefined,
		budget: GraphBudget,
		limits: ResolvedGraphLimits,
		options: GraphRunOptions,
		checkpointRun: CheckpointRun | undefined,
		baseActiveTimeMs: number,
		invocationStartedAt: number,
	): Promise<GraphRunResult | undefined> {
		const inFlight = snapshot.inFlight;
		if (!inFlight) throw new Error("Missing in-flight step");
		const threadsChanged = this.prepareThreadStates(snapshot, inFlight.scheduled);
		this.assertNoConcurrentThreadContexts(inFlight.scheduled);
		if (threadsChanged) {
			await this.save(snapshot, checkpointRun, options, baseActiveTimeMs, invocationStartedAt);
		}
		const unresolved = [...inFlight.unresolved];
		const results = await mapWithConcurrencyLimit(unresolved, limits.maxConcurrency, async (nodeId) => {
			const node = this.graph.definition.nodes[nodeId];
			const result = node
				? await this.executeNodeWithRetry(
						snapshot,
						nodeId,
						node,
						resumeInterruptNodeId,
						budget,
						limits,
						options,
						baseActiveTimeMs,
						invocationStartedAt,
					)
				: failureResult(`Unknown scheduled node ${nodeId}`, "UNKNOWN_NODE", false, 1, nowIso(), nowIso());
			await this.emit(options, {
				type: "node_settled",
				runId: snapshot.runId,
				timestamp: nowIso(),
				step: snapshot.step,
				nodeId,
				attempt: result.attempts,
				status:
					options.signal?.aborted
						? "cancelled"
						: result.kind === "success"
							? "completed"
							: result.kind === "interrupt"
								? "interrupted"
								: "failed",
				message:
					result.kind === "failure"
						? result.error
						: result.kind === "interrupt"
							? result.interrupt.prompt
							: undefined,
				usage: copyUsage(budget.usage),
			});
			return result;
		});
		// Some executors report an abort as a normal failure result. Re-check the
		// run signal before classifying node results so external cancellation is
		// persisted as `cancelled`, while a lost checkpoint lease is still
		// propagated by the outer control-error boundary.
		this.assertRunActive(snapshot, options.signal, limits, baseActiveTimeMs, invocationStartedAt);

		const fatalFailures: Array<{ nodeId: string; failure: NodeExecutionFailure }> = [];
		const interrupts: Array<{ nodeId: string; result: Extract<NodeExecutionResult, { kind: "interrupt" }> }> = [];
		snapshot.usage = copyUsage(budget.usage);

		for (let index = 0; index < unresolved.length; index++) {
			const nodeId = unresolved[index];
			const result = results[index];
			const node = this.graph.definition.nodes[nodeId];
			if (!node) continue;

			if (result.kind === "interrupt") {
				interrupts.push({ nodeId, result });
				this.appendHistory(snapshot, nodeId, result, "interrupted");
				await this.emit(options, {
					type: "node_end",
					runId: snapshot.runId,
					timestamp: nowIso(),
					step: snapshot.step,
					nodeId,
					status: "interrupted",
				});
				continue;
			}

			const resolution = result.kind === "failure" ? resolveFailure(nodeId, node, result) : successResolution(result);
			if (resolution.success) {
				inFlight.completed[nodeId] = resolution.success;
				inFlight.unresolved = inFlight.unresolved.filter((item) => item !== nodeId);
				this.appendHistory(
					snapshot,
					nodeId,
					resolution.success,
					resolution.historyStatus,
					resolution.historyError,
				);
				await this.emit(options, {
					type: "node_end",
					runId: snapshot.runId,
					timestamp: nowIso(),
					step: snapshot.step,
					nodeId,
					status: resolution.historyStatus,
					message: resolution.historyError,
					usage: copyUsage(snapshot.usage),
				});
				await this.save(snapshot, checkpointRun, options, baseActiveTimeMs, invocationStartedAt);
			} else if (resolution.fatal) {
				fatalFailures.push({ nodeId, failure: resolution.fatal });
				this.appendHistory(snapshot, nodeId, resolution.fatal, "failed", resolution.fatal.error);
				await this.emit(options, {
					type: "node_end",
					runId: snapshot.runId,
					timestamp: nowIso(),
					step: snapshot.step,
					nodeId,
					status: "failed",
					message: resolution.fatal.error,
					usage: copyUsage(snapshot.usage),
				});
			}
		}

		snapshot.usage = copyUsage(budget.usage);

		if (fatalFailures.length > 0) {
			const error = fatalFailures.map((item) => `${item.nodeId}: ${item.failure.error}`).join("; ");
			return await this.finish(
				snapshot,
				"failed",
				error,
				checkpointRun,
				options,
				baseActiveTimeMs,
				invocationStartedAt,
				false,
			);
		}

		if (interrupts.length > 0) {
			const first = inFlight.scheduled
				.map((nodeId) => interrupts.find((item) => item.nodeId === nodeId))
				.find((item) => item !== undefined);
			if (!first) throw new Error("Interrupt result disappeared");
			snapshot.status = "interrupted";
			snapshot.interrupt = first.result.interrupt;
			snapshot.error = undefined;
			snapshot.updatedAt = nowIso();
			await this.emit(options, {
				type: "interrupt",
				runId: snapshot.runId,
				timestamp: nowIso(),
				step: snapshot.step,
				nodeId: first.nodeId,
				status: "interrupted",
				message: first.result.interrupt.prompt,
			});
			await this.save(snapshot, checkpointRun, options, baseActiveTimeMs, invocationStartedAt);
			await this.emit(options, {
				type: "graph_end",
				runId: snapshot.runId,
				timestamp: nowIso(),
				step: snapshot.step,
				status: "interrupted",
				usage: copyUsage(snapshot.usage),
			});
			return resultFromSnapshot(snapshot, this.graph.definition);
		}

		await this.commitStep(snapshot, inFlight, limits);
		await this.emit(options, {
			type: "step_end",
			runId: snapshot.runId,
			timestamp: nowIso(),
			step: snapshot.step,
			status: "completed",
			usage: copyUsage(snapshot.usage),
		});
		await this.save(snapshot, checkpointRun, options, baseActiveTimeMs, invocationStartedAt);
		return undefined;
	}

	private async executeNodeWithRetry(
		snapshot: CheckpointSnapshot,
		nodeId: string,
		node: NodeDefinition,
		resumeInterruptNodeId: string | undefined,
		budget: GraphBudget,
		limits: ResolvedGraphLimits,
		options: GraphRunOptions,
		baseActiveTimeMs: number,
		invocationStartedAt: number,
	): Promise<NodeExecutionResult> {
		const maxAttempts = Math.max(1, node.retry?.maxAttempts ?? 1);
		const initialBackoff = Math.max(0, node.retry?.backoffMs ?? 0);
		const multiplier = Math.max(1, node.retry?.backoffMultiplier ?? 2);
		const aggregate: NodeUsage = emptyUsage();
		const startedAt = nowIso();
		let lastFailure: NodeExecutionFailure | undefined;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				this.assertRunActive(snapshot, options.signal, limits, baseActiveTimeMs, invocationStartedAt);
				if (snapshot.nodeRuns >= limits.maxNodeRuns) {
					throw new GraphLimitError("MAX_NODE_RUNS", `Graph exceeded maxNodeRuns (${limits.maxNodeRuns})`);
				}
				snapshot.nodeRuns += 1;
				await this.emit(options, {
					type: "node_start",
					runId: snapshot.runId,
					timestamp: nowIso(),
					step: snapshot.step,
					nodeId,
					attempt,
				});

				const scopedBudget = new ScopedExecutionBudget(budget, nodeId, node.limits);
				const activeTime = baseActiveTimeMs + Math.max(0, Date.now() - invocationStartedAt);
				const remainingGraphTime = Math.max(1, limits.timeoutMs - activeTime);
				const timeoutController = new AbortController();
				let graphTimedOut = false;
				const timeout = setTimeout(() => {
					graphTimedOut = true;
					timeoutController.abort();
				}, remainingGraphTime);
				const forwardAbort = () => timeoutController.abort();
				if (options.signal?.aborted) forwardAbort();
				else options.signal?.addEventListener("abort", forwardAbort, { once: true });
				const context: NodeExecutionContext = {
					runId: snapshot.runId,
					step: snapshot.step,
					nodeId,
					state: deepCloneJson(snapshot.state),
					graph: this.graph,
					thread: this.threadForNode(snapshot, nodeId, node),
					resumeValue: resumeInterruptNodeId === nodeId ? options.resumeValue : undefined,
					signal: timeoutController.signal,
					budget: scopedBudget,
					onEvent: options.onEvent,
				};
				let result: NodeExecutionResult;
				try {
					result = await this.executor.execute(node, context);
				} finally {
					if (context.thread) {
						context.thread.invocationCount += 1;
						context.thread.lastNodeId = nodeId;
						context.thread.updatedAt = nowIso();
						context.thread.nodes = uniqueStrings([...context.thread.nodes, nodeId]);
					}
					clearTimeout(timeout);
					options.signal?.removeEventListener("abort", forwardAbort);
				}
				if (graphTimedOut) throw new GraphLimitError("TIMEOUT", `Graph exceeded timeoutMs (${limits.timeoutMs})`);
				try {
					scopedBudget.reconcile(result.usage);
				} finally {
					mergeNodeUsage(aggregate, scopedBudget.usage);
				}
				scopedBudget.assertWithinLimits(nodeId, scopedBudget.usage, node.limits);

				if (result.kind === "success") {
					return { ...result, attempts: attempt, usage: withModel(aggregate, result.usage.model), startedAt, endedAt: nowIso() };
				}
				if (result.kind === "interrupt") {
					return { ...result, attempts: attempt, usage: withModel(aggregate, result.usage.model), startedAt, endedAt: nowIso() };
				}
				lastFailure = {
					...result,
					attempts: attempt,
					usage: withModel(aggregate, result.usage.model),
					startedAt,
					endedAt: nowIso(),
				};
			} catch (error) {
				const retryable = !(error instanceof GraphLimitError) && !options.signal?.aborted;
				lastFailure = failureResult(
					errorMessage(error),
					error instanceof GraphLimitError ? error.code : "EXECUTION_ERROR",
					retryable,
					attempt,
					startedAt,
					nowIso(),
					aggregate,
				);
			}

			if (!lastFailure.retryable || attempt >= maxAttempts) return lastFailure;
			const backoff = Math.round(initialBackoff * multiplier ** (attempt - 1));
			await this.emit(options, {
				type: "node_retry",
				runId: snapshot.runId,
				timestamp: nowIso(),
				step: snapshot.step,
				nodeId,
				attempt: attempt + 1,
				message: lastFailure.error,
			});
			if (backoff > 0) await delay(backoff, undefined, { signal: options.signal });
		}

		return lastFailure ?? failureResult("Node failed without a result", "UNKNOWN", false, maxAttempts, startedAt, nowIso(), aggregate);
	}

	private async commitStep(snapshot: CheckpointSnapshot, inFlight: InFlightStep, limits: ResolvedGraphLimits): Promise<void> {
		const orderedResults = inFlight.scheduled.map((nodeId) => {
			const result = inFlight.completed[nodeId];
			if (!result) throw new Error(`Step ${inFlight.step} is missing result for ${nodeId}`);
			return { nodeId, result };
		});
		const writes: StateWrite[] = orderedResults.flatMap((item) => item.result.writes);
		snapshot.state = applyStateWrites(snapshot.state, writes, this.graph.reducers);
		this.pruneSharedMessageChannels(snapshot.state);
		this.assertStateWithinPolicy(snapshot.state, limits);

		for (const nodeId of inFlight.scheduled) snapshot.completionCounts[nodeId] = (snapshot.completionCounts[nodeId] ?? 0) + 1;
		const next: string[] = [];
		for (const { nodeId, result } of orderedResults) {
			if (result.next !== undefined) {
				next.push(...result.next);
				continue;
			}
			const route = this.graph.routesByNode.get(nodeId);
			if (route) {
				const selected = route.cases.find((item) => evaluateCondition(item.when, snapshot.state));
				if (selected) next.push(...asStringArray(selected.to));
				else if (route.default !== undefined) next.push(...asStringArray(route.default));
			}
			for (const edge of this.graph.staticEdges) {
				if (!edge.barrier && edge.from[0] === nodeId) next.push(...edge.to);
			}
		}

		for (const edge of this.graph.staticEdges.filter((item) => item.barrier)) {
			const consumed = snapshot.barrierConsumed[edge.id] ?? {};
			if (edge.from.every((source) => (snapshot.completionCounts[source] ?? 0) > (consumed[source] ?? 0))) {
				for (const source of edge.from) consumed[source] = (consumed[source] ?? 0) + 1;
				snapshot.barrierConsumed[edge.id] = consumed;
				next.push(...edge.to);
			}
		}

		snapshot.pending = uniqueStrings(next.filter((nodeId) => nodeId !== END));
		snapshot.inFlight = undefined;
		snapshot.interrupt = undefined;
		snapshot.status = "running";
		snapshot.error = undefined;
		snapshot.updatedAt = nowIso();
	}

	private pruneSharedMessageChannels(state: JsonObject): void {
		const limits = new Map<string, number>();
		for (const node of Object.values(this.graph.definition.nodes)) {
			if (node.type !== "agent" || (node.context?.mode ?? "isolated") !== "shared") continue;
			if ((node.context?.capture ?? "compact") === "none") continue;
			const maxStoredMessages = node.context?.maxStoredMessages;
			if (maxStoredMessages === undefined) continue;
			const path = node.context?.messagesPath ?? "messages";
			const current = limits.get(path);
			limits.set(path, current === undefined ? maxStoredMessages : Math.min(current, maxStoredMessages));
		}

		for (const [path, maxStoredMessages] of limits) {
			const value = getPath(state, path);
			if (value === undefined) continue;
			if (!Array.isArray(value)) {
				throw new GraphLimitError("SHARED_CONTEXT_INVALID", `Shared messages state at ${path} must be an array`);
			}
			if (value.length > maxStoredMessages) {
				setPath(state, path, deepCloneJson(value.slice(-maxStoredMessages)));
			}
		}
	}

	private assertStateWithinPolicy(state: JsonObject, limits: ResolvedGraphLimits): void {
		const stateBytes = stateSizeBytes(state);
		if (stateBytes > limits.maxStateBytes) {
			throw new GraphLimitError("MAX_STATE_BYTES", `Graph state is ${stateBytes} bytes; maxStateBytes is ${limits.maxStateBytes}`);
		}
		const policy = this.graph.definition.statePolicy;
		for (const [path, pathPolicy] of Object.entries(policy?.paths ?? {})) {
			if (pathPolicy.maxBytes === undefined) continue;
			const value = getPath(state, path);
			if (value === undefined) continue;
			const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
			if (bytes > pathPolicy.maxBytes) {
				throw new GraphLimitError(
					"MAX_STATE_PATH_BYTES",
					`Graph state path ${path} is ${bytes} bytes; configured maxBytes is ${pathPolicy.maxBytes}`,
				);
			}
		}
	}

	private prepareThreadStates(snapshot: CheckpointSnapshot, nodeIds: string[]): boolean {
		snapshot.threads ??= {};
		let changed = false;
		for (const nodeId of nodeIds) {
			const node = this.graph.definition.nodes[nodeId];
			if (!isThreadNode(node)) continue;
			const key = node.context?.threadKey ?? nodeId;
			const existing = snapshot.threads[key];
			if (existing) {
				if (!Number.isInteger(existing.invocationCount) || existing.invocationCount < 0) {
					existing.invocationCount = 0;
					changed = true;
				}
				const nodes = uniqueStrings([...existing.nodes, nodeId]);
				if (nodes.length !== existing.nodes.length) {
					existing.nodes = nodes;
					existing.updatedAt = nowIso();
					changed = true;
				}
				continue;
			}
			const timestamp = nowIso();
			snapshot.threads[key] = {
				key,
				sessionId: randomUUID(),
				createdAt: timestamp,
				updatedAt: timestamp,
				nodes: [nodeId],
				invocationCount: 0,
			};
			changed = true;
		}
		return changed;
	}

	private assertNoConcurrentThreadContexts(nodeIds: string[]): void {
		const byKey = new Map<string, string[]>();
		for (const nodeId of nodeIds) {
			const node = this.graph.definition.nodes[nodeId];
			if (!isThreadNode(node)) continue;
			const key = node.context?.threadKey ?? nodeId;
			const nodes = byKey.get(key) ?? [];
			nodes.push(nodeId);
			byKey.set(key, nodes);
		}
		for (const [key, nodes] of byKey) {
			if (nodes.length > 1) {
				throw new Error(
					`Thread context ${JSON.stringify(key)} is scheduled concurrently by ${nodes.join(", ")} in step ${nodeIds.join(", ")}.`,
				);
			}
		}
	}

	private threadForNode(
		snapshot: CheckpointSnapshot,
		nodeId: string,
		node: NodeDefinition,
	): AgentThreadState | undefined {
		if (!isThreadNode(node)) return undefined;
		const key = node.context?.threadKey ?? nodeId;
		const thread = snapshot.threads?.[key];
		if (!thread) throw new Error(`Missing durable thread state for ${JSON.stringify(key)}`);
		return thread;
	}

	private createSnapshot(input: JsonObject): CheckpointSnapshot {
		const timestamp = nowIso();
		const initial = deepMergeObjects(this.graph.definition.initialState ?? {}, { input: deepCloneJson(input) });
		return {
			version: 2,
			runId: randomUUID(),
			graphName: this.graph.definition.name,
			graphHash: this.graph.hash,
			graphSource: this.graphSource,
			status: "running",
			createdAt: timestamp,
			updatedAt: timestamp,
			startedAt: timestamp,
			activeTimeMs: 0,
			step: 0,
			nodeRuns: 0,
			state: initial,
			pending: uniqueStrings(asStringArray(this.graph.definition.entry).filter((nodeId) => nodeId !== END)),
			completionCounts: {},
			barrierConsumed: {},
			usage: emptyUsage(),
			history: [],
			threads: {},
		};
	}

	private assertCheckpointGraph(snapshot: CheckpointSnapshot, force: boolean): void {
		if (snapshot.graphName !== this.graph.definition.name) {
			throw new Error(`Checkpoint graph is ${snapshot.graphName}, not ${this.graph.definition.name}`);
		}
		if (snapshot.graphHash !== this.graph.hash && !force) {
			throw new Error(
				`Graph definition changed since checkpoint ${snapshot.runId}. Re-run with forceGraphVersion only after reviewing idempotency and state compatibility.`,
			);
		}
	}

	private assertRunActive(
		snapshot: CheckpointSnapshot,
		signal: AbortSignal | undefined,
		limits: ResolvedGraphLimits,
		baseActiveTimeMs: number,
		invocationStartedAt: number,
	): void {
		if (signal?.aborted) throw new Error("Graph run aborted");
		const active = baseActiveTimeMs + Math.max(0, Date.now() - invocationStartedAt);
		if (active > limits.timeoutMs) throw new GraphLimitError("TIMEOUT", `Graph exceeded timeoutMs (${limits.timeoutMs})`);
		if (snapshot.nodeRuns > limits.maxNodeRuns) throw new GraphLimitError("MAX_NODE_RUNS", `Graph exceeded maxNodeRuns (${limits.maxNodeRuns})`);
	}

	private appendHistory(
		snapshot: CheckpointSnapshot,
		nodeId: string,
		result: NodeExecutionResult,
		status: NodeRunHistory["status"],
		error?: string,
	): void {
		snapshot.history.push({
			step: snapshot.step,
			nodeId,
			status,
			attempts: result.attempts,
			startedAt: result.startedAt,
			endedAt: result.endedAt,
			usage: result.usage,
			error,
		});
	}

	private async finish(
		snapshot: CheckpointSnapshot,
		status: "completed" | "failed" | "cancelled",
		error: string | undefined,
		checkpointRun: CheckpointRun | undefined,
		options: GraphRunOptions,
		baseActiveTimeMs: number,
		invocationStartedAt: number,
		clearInFlight = true,
	): Promise<GraphRunResult> {
		snapshot.status = status;
		snapshot.error = error;
		snapshot.endedAt = nowIso();
		snapshot.updatedAt = snapshot.endedAt;
		if (status === "completed" || clearInFlight) {
			snapshot.inFlight = undefined;
			snapshot.pending = status === "completed" ? [] : snapshot.pending;
		}
		if (status !== "completed") snapshot.interrupt = undefined;
		await this.save(snapshot, checkpointRun, options, baseActiveTimeMs, invocationStartedAt);
		await this.emit(options, {
			type: "graph_end",
			runId: snapshot.runId,
			timestamp: nowIso(),
			step: snapshot.step,
			status,
			message: error,
			usage: copyUsage(snapshot.usage),
		});
		return resultFromSnapshot(snapshot, this.graph.definition);
	}

	private async save(
		snapshot: CheckpointSnapshot,
		checkpointRun: CheckpointRun | undefined,
		options: GraphRunOptions,
		baseActiveTimeMs: number,
		invocationStartedAt: number,
	): Promise<void> {
		snapshot.activeTimeMs = baseActiveTimeMs + Math.max(0, Date.now() - invocationStartedAt);
		snapshot.updatedAt = nowIso();
		if (!checkpointRun) return;
		await checkpointRun.commit(snapshot);
		await this.emit(options, {
			type: "checkpoint",
			runId: snapshot.runId,
			timestamp: nowIso(),
			step: snapshot.step,
			status: snapshot.status,
		});
	}

	private async emit(options: GraphRunOptions, event: GraphRunEvent): Promise<void> {
		if (!options.onEvent) return;
		try {
			await options.onEvent(event);
		} catch {
			// Observability callbacks are non-critical and must not alter graph control flow.
		}
	}
}

class GraphBudget implements ExecutionBudget {
	readonly usage: UsageLedger;
	private readonly limits: ResolvedGraphLimits;

	constructor(initial: UsageLedger, limits: ResolvedGraphLimits) {
		this.usage = copyUsage(initial);
		this.limits = limits;
	}

	report(delta: Partial<UsageLedger>): void {
		addUsage(this.usage, delta);
		this.assertGraphWithinLimits();
	}

	assertWithinLimits(_nodeId: string, _nodeUsage: UsageLedger, _nodeLimits?: NodeLimits): void {
		this.assertGraphWithinLimits();
	}

	assertGraphWithinLimits(): void {
		if (this.usage.costUsd > this.limits.maxCostUsd) {
			throw new GraphLimitError("MAX_COST", `Graph cost $${this.usage.costUsd.toFixed(4)} exceeded maxCostUsd $${this.limits.maxCostUsd}`);
		}
		const tokens = usageTokens(this.usage);
		if (tokens > this.limits.maxTokens) {
			throw new GraphLimitError("MAX_TOKENS", `Graph used ${tokens} tokens; maxTokens is ${this.limits.maxTokens}`);
		}
	}
}

class ScopedExecutionBudget implements ExecutionBudget {
	readonly usage: UsageLedger;
	private readonly parent: GraphBudget;
	private readonly nodeId: string;
	private readonly nodeLimits: NodeLimits | undefined;

	constructor(parent: GraphBudget, nodeId: string, nodeLimits: NodeLimits | undefined) {
		this.parent = parent;
		this.nodeId = nodeId;
		this.nodeLimits = nodeLimits;
		this.usage = emptyUsage();
	}

	report(delta: Partial<UsageLedger>): void {
		addUsage(this.usage, delta);
		this.parent.report(delta);
		this.assertWithinLimits(this.nodeId, this.usage, this.nodeLimits);
	}

	assertWithinLimits(nodeId: string, nodeUsage: UsageLedger, nodeLimits = this.nodeLimits): void {
		this.parent.assertGraphWithinLimits();
		if (nodeLimits?.maxCostUsd !== undefined && nodeUsage.costUsd > nodeLimits.maxCostUsd) {
			throw new GraphLimitError(
				"NODE_MAX_COST",
				`Node ${nodeId} cost $${nodeUsage.costUsd.toFixed(4)} exceeded maxCostUsd $${nodeLimits.maxCostUsd}`,
			);
		}
		const tokens = usageTokens(nodeUsage);
		if (nodeLimits?.maxTokens !== undefined && tokens > nodeLimits.maxTokens) {
			throw new GraphLimitError("NODE_MAX_TOKENS", `Node ${nodeId} used ${tokens} tokens; maxTokens is ${nodeLimits.maxTokens}`);
		}
		if (nodeLimits?.maxTurns !== undefined && nodeUsage.turns > nodeLimits.maxTurns) {
			throw new GraphLimitError("NODE_MAX_TURNS", `Node ${nodeId} used ${nodeUsage.turns} turns; maxTurns is ${nodeLimits.maxTurns}`);
		}
	}

	reconcile(expected: UsageLedger): void {
		const delta: Partial<UsageLedger> = {};
		for (const key of usageKeys()) {
			const missing = expected[key] - this.usage[key];
			if (missing > 0) delta[key] = missing;
		}
		this.report(delta);
	}
}

function isThreadNode(node: NodeDefinition | undefined): node is AgentNodeDefinition {
	return node?.type === "agent" && (node.context?.mode ?? "isolated") === "thread";
}

function resolveFailure(nodeId: string, node: NodeDefinition, failure: NodeExecutionFailure): FailureResolution {
	const strategy = node.onError?.strategy ?? "fail";
	if (strategy === "fail") return { fatal: failure, historyStatus: "failed", historyError: failure.error };
	const errorValue: JsonObject = {
		message: failure.error,
		code: failure.code ?? "NODE_FAILED",
		retryable: failure.retryable,
		attempts: failure.attempts,
	};
	const outputPath = node.onError?.output ?? `errors.${nodeId}`;
	return {
		success: {
			kind: "success",
			writes: [{ path: outputPath, value: errorValue, nodeId }],
			output: errorValue,
			usage: failure.usage,
			next: strategy === "route" && node.onError?.to !== undefined ? asStringArray(node.onError.to) : undefined,
			attempts: failure.attempts,
			startedAt: failure.startedAt,
			endedAt: failure.endedAt,
		},
		historyStatus: "failed",
		historyError: failure.error,
	};
}

function successResolution(success: NodeExecutionSuccess): FailureResolution {
	return { success, historyStatus: "completed" };
}

function failureResult(
	error: string,
	code: string,
	retryable: boolean,
	attempts: number,
	startedAt: string,
	endedAt: string,
	usage: NodeUsage = emptyUsage(),
): NodeExecutionFailure {
	return { kind: "failure", error, code, retryable, usage, attempts, startedAt, endedAt };
}

function resolveLimits(configured: GraphLimits | undefined): ResolvedGraphLimits {
	return {
		maxSteps: configured?.maxSteps ?? DEFAULT_LIMITS.maxSteps,
		maxNodeRuns: configured?.maxNodeRuns ?? DEFAULT_LIMITS.maxNodeRuns,
		maxConcurrency: configured?.maxConcurrency ?? DEFAULT_LIMITS.maxConcurrency,
		maxCostUsd: configured?.maxCostUsd ?? DEFAULT_LIMITS.maxCostUsd,
		maxTokens: configured?.maxTokens ?? DEFAULT_LIMITS.maxTokens,
		timeoutMs: configured?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
		maxStateBytes: configured?.maxStateBytes ?? DEFAULT_LIMITS.maxStateBytes,
		maxPromptBytes: configured?.maxPromptBytes ?? DEFAULT_LIMITS.maxPromptBytes,
	};
}

function mergeNodeUsage(target: NodeUsage, source: NodeUsage): void {
	addUsage(target, source);
	if (source.model) target.model = source.model;
}

function withModel(usage: NodeUsage, model: string | undefined): NodeUsage {
	return { ...copyUsage(usage), model: model ?? usage.model };
}

function copyUsage(usage: UsageLedger): UsageLedger {
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		turns: usage.turns,
		costUsd: usage.costUsd,
	};
}

function usageKeys(): Array<keyof UsageLedger> {
	return ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "turns", "costUsd"];
}

function resultFromSnapshot(snapshot: CheckpointSnapshot, definition: GraphDefinition): GraphRunResult {
	const resultPolicy = definition.result;
	const includeState = resultPolicy?.includeState ?? false;
	return {
		runId: snapshot.runId,
		status: snapshot.status,
		state: deepCloneJson(snapshot.state),
		result: projectResult(snapshot.state, resultPolicy?.paths),
		stateBytes: stateSizeBytes(snapshot.state),
		includeState,
		resultMaxBytes: resultPolicy?.maxBytes ?? 16 * 1024,
		usage: copyUsage(snapshot.usage),
		step: snapshot.step,
		nodeRuns: snapshot.nodeRuns,
		interrupt: snapshot.interrupt,
		error: snapshot.error,
	};
}

function projectResult(state: JsonObject, configuredPaths: string[] | undefined): JsonObject | undefined {
	const paths = configuredPaths ?? defaultResultPaths(state);
	if (paths.length === 0) return undefined;
	const projected: JsonObject = {};
	for (const path of paths) {
		const value = getPath(state, path);
		if (value === undefined) continue;
		setPath(projected, path, deepCloneJson(value));
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function defaultResultPaths(state: JsonObject): string[] {
	if (getPath(state, "result") !== undefined) return ["result"];
	if (getPath(state, "report") !== undefined) return ["report"];
	const outputs = getPath(state, "outputs");
	if (isJsonObject(outputs) && Object.keys(outputs).length === 1) return ["outputs"];
	return [];
}

function isCheckpointControlError(error: unknown): boolean {
	return (
		error instanceof CheckpointLeaseError ||
		error instanceof CheckpointConflictError ||
		error instanceof CheckpointDurabilityError ||
		error instanceof CheckpointValidationError
	);
}

async function closeCheckpointRun(checkpointRun: CheckpointRun | undefined): Promise<void> {
	try {
		await checkpointRun?.close();
	} catch {
		// Lease release is best-effort; expiry remains the recovery path. Cleanup must not
		// replace a committed result or the primary execution/control error.
	}
}

async function mapWithConcurrencyLimit<TInput, TOutput>(
	items: TInput[],
	concurrency: number,
	execute: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<TOutput>(items.length);
	let nextIndex = 0;
	let failure: { error: unknown } | undefined;
	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			if (failure) return;
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) return;
			try {
				results[index] = await execute(items[index], index);
			} catch (error) {
				failure ??= { error };
				return;
			}
		}
	});
	await Promise.all(workers);
	if (failure) throw failure.error;
	return results;
}

function nowIso(): string {
	return new Date().toISOString();
}
