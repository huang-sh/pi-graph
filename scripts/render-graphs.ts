/**
 * Render every example graph to an SVG diagram under docs/images/.
 *
 * Reads each examples/<name>.json, turns it into Mermaid source via the same
 * `generateMermaid()` used by `/pi-graph visualize`, and renders it with the
 * `@mermaid-js/mermaid-cli` (mmdc) dev dependency.
 *
 * Idempotent: a content hash of each graph's Mermaid source is kept in
 * docs/images/.render-cache.json. A graph is re-rendered ONLY when its source
 * changed. This matters because mmdc/dagre edge geometry is not byte-stable, so
 * blindly re-rendering unchanged graphs would create spurious diffs. On first
 * run, existing committed SVGs are trusted and only the cache is seeded.
 *
 * Usage:  npm run render:graphs
 *
 * Output: docs/images/<name>.svg  (committed; regenerate after editing graphs)
 *
 * This is a docs-only dev script. It is not part of the runtime and adds no
 * runtime dependency; mermaid-cli lives in devDependencies.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateMermaid } from "../src/extension.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const examplesDir = join(root, "examples");
const outDir = join(root, "docs", "images");
const cacheFile = join(outDir, ".render-cache.json");
const mmdc = join(root, "node_modules", ".bin", "mmdc");

const GRAPHS = [
	"research-review",
	"idea-tournament",
	"coding-review",
	"shared-handoff",
	"science-research",
	"science-research-auto",
];

// Transparent background so diagrams read on both light and dark surfaces.
const mermaidConfig = {
	theme: "default",
	flowchart: { curve: "linear", nodeSpacing: 45, rankSpacing: 55, useMaxWidth: false },
} as const;

// Chromium often needs --no-sandbox in containers/CI; harmless elsewhere.
const puppeteerConfig = { args: ["--no-sandbox", "--disable-setuid-sandbox"] } as const;

function loadCache(): Record<string, string> {
	if (!existsSync(cacheFile)) return {};
	try {
		const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
		return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
	} catch {
		return {};
	}
}

mkdirSync(outDir, { recursive: true });
const cache = loadCache();
let cacheDirty = false;

const tmp = mkdtempSync(join(tmpdir(), "pi-graph-render-"));
const configFile = join(tmp, "mermaid.json");
const puppeteerFile = join(tmp, "puppeteer.json");
writeFileSync(configFile, JSON.stringify(mermaidConfig));
writeFileSync(puppeteerFile, JSON.stringify(puppeteerConfig));

try {
	for (const name of GRAPHS) {
		const def = JSON.parse(readFileSync(join(examplesDir, `${name}.json`), "utf8"));
		const source = generateMermaid(def);
		const hash = createHash("sha256").update(source).digest("hex");
		const svgFile = join(outDir, `${name}.svg`);

		if (cache[name] === hash) {
			process.stdout.write(`${name}: unchanged, skipped\n`);
			continue;
		}
		// First time we see this graph but a committed SVG already exists: trust it
		// and just record the hash, so we don't re-render (mmdc output is not
		// byte-stable) a diagram whose source hasn't actually changed since the SVG
		// was last committed.
		if (cache[name] === undefined && existsSync(svgFile)) {
			cache[name] = hash;
			cacheDirty = true;
			process.stdout.write(`${name}: seeded cache (kept existing SVG)\n`);
			continue;
		}

		const mmdFile = join(tmp, `${name}.mmd`);
		writeFileSync(mmdFile, source);
		process.stdout.write(`rendering ${name} ... `);
		execFileSync(mmdc, ["-i", mmdFile, "-o", svgFile, "-b", "transparent", "-c", configFile, "--puppeteerConfigFile", puppeteerFile], { stdio: "inherit" });
		cache[name] = hash;
		cacheDirty = true;
	}
	if (cacheDirty) writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + "\n");
	process.stdout.write(`done\n`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
