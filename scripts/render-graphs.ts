/**
 * Render every example graph to an SVG diagram under docs/images/.
 *
 * Reads each examples/<name>.json, turns it into Mermaid source via the same
 * `generateMermaid()` used by `/pi-graph visualize`, and renders it with the
 * `@mermaid-js/mermaid-cli` (mmdc) dev dependency.
 *
 * Usage:  npm run render:graphs
 *
 * Output: docs/images/<name>.svg  (committed; regenerate after editing graphs)
 *
 * This is a docs-only dev script. It is not part of the runtime and adds no
 * runtime dependency; mermaid-cli lives in devDependencies.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateMermaid } from "../src/extension.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const examplesDir = join(root, "examples");
const outDir = join(root, "docs", "images");
const mmdc = join(root, "node_modules", ".bin", "mmdc");

const GRAPHS = [
	"research-review",
	"idea-tournament",
	"coding-review",
	"shared-handoff",
	"science-research",
];

// Transparent background so diagrams read on both light and dark surfaces.
const mermaidConfig = {
	theme: "default",
	flowchart: { curve: "linear", nodeSpacing: 45, rankSpacing: 55, useMaxWidth: false },
} as const;

// Chromium often needs --no-sandbox in containers/CI; harmless elsewhere.
const puppeteerConfig = { args: ["--no-sandbox", "--disable-setuid-sandbox"] } as const;

mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "pi-graph-render-"));
const configFile = join(tmp, "mermaid.json");
const puppeteerFile = join(tmp, "puppeteer.json");
writeFileSync(configFile, JSON.stringify(mermaidConfig));
writeFileSync(puppeteerFile, JSON.stringify(puppeteerConfig));

try {
	for (const name of GRAPHS) {
		const def = JSON.parse(readFileSync(join(examplesDir, `${name}.json`), "utf8"));
		const source = generateMermaid(def);
		const mmdFile = join(tmp, `${name}.mmd`);
		const svgFile = join(outDir, `${name}.svg`);
		writeFileSync(mmdFile, source);
		process.stdout.write(`rendering ${name} ... `);
		execFileSync(mmdc, ["-i", mmdFile, "-o", svgFile, "-b", "transparent", "-c", configFile, "--puppeteerConfigFile", puppeteerFile], { stdio: "inherit" });
	}
	process.stdout.write(`\ndone: ${GRAPHS.length} SVGs written to ${outDir}\n`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
