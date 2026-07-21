import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { GraphValidationError, parseAndCompileGraph } from "./compile.ts";
import type { Diagnostic, GraphDiscoveryResult, GraphScope, GraphSource } from "./types.ts";
import { errorMessage } from "./utils.ts";

export interface GraphDiscoveryOptions {
	cwd: string;
	agentDir: string;
	configDirName: string;
	scope?: GraphScope;
	projectTrusted: boolean;
}

export function discoverGraphs(options: GraphDiscoveryOptions): GraphDiscoveryResult {
	const scope = options.scope ?? "both";
	const diagnostics: Diagnostic[] = [];
	const userDir = join(options.agentDir, "graphs");
	const projectGraphsDir = findNearestProjectGraphsDir(options.cwd, options.configDirName);
	const userGraphs = scope === "project" ? [] : loadGraphsFromDir(userDir, "user", diagnostics);
	let projectGraphs: GraphSource[] = [];

	if (scope !== "user" && projectGraphsDir) {
		if (!options.projectTrusted) {
			diagnostics.push({
				level: "warning",
				code: "PROJECT_GRAPH_UNTRUSTED",
				message: `Project graphs at ${projectGraphsDir} were ignored because the project is not trusted`,
				path: projectGraphsDir,
			});
		} else {
			projectGraphs = loadGraphsFromDir(projectGraphsDir, "project", diagnostics);
		}
	}

	const graphMap = new Map<string, GraphSource>();
	for (const graph of userGraphs) graphMap.set(graph.name, graph);
	for (const graph of projectGraphs) graphMap.set(graph.name, graph);
	return {
		graphs: [...graphMap.values()].sort((left, right) => left.name.localeCompare(right.name)),
		projectGraphsDir,
		diagnostics,
	};
}

export function findGraph(discovery: GraphDiscoveryResult, name: string): GraphSource {
	const graph = discovery.graphs.find((item) => item.name === name);
	if (graph) return graph;
	const available = discovery.graphs.map((item) => item.name).join(", ") || "none";
	throw new Error(`Unknown graph ${JSON.stringify(name)}. Available graphs: ${available}`);
}

function loadGraphsFromDir(dir: string, scope: "user" | "project", diagnostics: Diagnostic[]): GraphSource[] {
	if (!existsSync(dir)) return [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		diagnostics.push({ level: "error", code: "GRAPH_DIR_READ", message: errorMessage(error), path: dir });
		return [];
	}
	const graphs: GraphSource[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.name.endsWith(".json")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = join(dir, entry.name);
		try {
			const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
			const compiled = parseAndCompileGraph(raw, filePath);
			graphs.push({
				name: compiled.definition.name,
				description: compiled.definition.description,
				filePath,
				scope,
				definition: compiled.definition,
				hash: compiled.hash,
				diagnostics: compiled.diagnostics,
			});
		} catch (error) {
			if (error instanceof GraphValidationError) {
				for (const item of error.diagnostics) diagnostics.push({ ...item, path: item.path ? `${filePath}:${item.path}` : filePath });
			} else {
				diagnostics.push({ level: "error", code: "GRAPH_FILE", message: errorMessage(error), path: filePath });
			}
		}
	}
	return graphs;
}

function findNearestProjectGraphsDir(cwd: string, configDirName: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = join(current, configDirName, "graphs");
		if (isDirectory(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
