import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAndCompileGraph } from "../src/compile.ts";

const examplesDir = new URL("../examples/", import.meta.url);
const names = (await readdir(examplesDir)).filter((name) => name.endsWith(".json")).sort();
let warnings = 0;
for (const name of names) {
	const raw = JSON.parse(await readFile(new URL(name, examplesDir), "utf8")) as unknown;
	const graph = parseAndCompileGraph(raw, join("examples", name));
	const graphWarnings = graph.diagnostics.filter((item) => item.level === "warning");
	warnings += graphWarnings.length;
	console.log(`${name}: valid (${Object.keys(graph.definition.nodes).length} nodes, ${graphWarnings.length} warnings)`);
	for (const warning of graphWarnings) console.log(`  ${warning.code}: ${warning.message}`);
}
console.log(`Validated ${names.length} examples with ${warnings} warnings.`);
