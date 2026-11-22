// Copies shared/*.mjs into the plugins that use them (plugins install separately and can't import each
// other). Run after editing anything in shared/:  node scripts/sync-shared.mjs
// test/shared-copies.test.mjs fails if a copy differs from its source.
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const COPIES = {
	"shared/commit-content.mjs": ["plugins/guardrails/scripts/commit-content.mjs", "plugins/privacy/scripts/commit-content.mjs"]
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	for (const [src, dests] of Object.entries(COPIES)) {
		for (const d of dests) {
			copyFileSync(path.join(root, src), path.join(root, d));
			console.log(`${src} → ${d}`);
		}
	}
}
