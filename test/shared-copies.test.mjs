// Fails if a plugin's copy of a shared/ file differs from its source. Fix: node scripts/sync-shared.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COPIES } from "../scripts/sync-shared.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const [src, dests] of Object.entries(COPIES)) {
	for (const d of dests) {
		test(`${d} matches ${src}`, () => {
			assert.equal(readFileSync(path.join(root, d), "utf8"), readFileSync(path.join(root, src), "utf8"), `${d} is out of date — run: node scripts/sync-shared.mjs`);
		});
	}
}
