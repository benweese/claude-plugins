// "Is this module the script Node was asked to run?" — shared by every plugin's hook scripts and bin tools.
// SOURCE OF TRUTH: shared/is-main.mjs in the plugins repo. It is copied byte-for-byte into each plugin's
// scripts/ folder by `node scripts/sync-shared.mjs` (plugins install separately, so they can't import each
// other). A test fails if a copy differs: edit the source, then run the sync script.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the calling module is the script being run, even through a symlinked path: process.argv[1] keeps a
 * symlink as typed (and path.resolve doesn't follow it), while import.meta.url is the resolved file, so both are
 * compared by real path. Callers pass their own URL — `if (isMain(process.argv[1], import.meta.url)) …` — because
 * a default here would be this file's URL, not the caller's. Missing or unresolvable arguments → false.
 * @param {string | undefined} argv1 process.argv[1]
 * @param {string | undefined} selfUrl the caller's import.meta.url
 * @return {boolean}
 */
export function isMain(argv1, selfUrl) {
	if (!argv1 || !selfUrl) return false;
	try {
		return realpathSync(argv1) === realpathSync(fileURLToPath(selfUrl));
	} catch {
		return false;
	}
}
