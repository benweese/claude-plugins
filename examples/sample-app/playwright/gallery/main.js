// The story gallery for Playwright's built-in `mount` fixture, to its gallery contract (see Playwright's
// playwright-component-testing skill, references/gallery-spec.md). No bundler: story modules are listed here.
// Story id: path under src/ without .story.js, plus the export name (components/BookList/LoadFailed); a unique suffix
// (BookList/LoadFailed) works too.
const stories = {
	"components/BookList": () => import("../../src/components/BookList.story.js")
};

async function resolve(storyId) {
	const sep = storyId.lastIndexOf("/");
	const [path, name] = [storyId.slice(0, sep), storyId.slice(sep + 1)];
	const key = Object.keys(stories).find((k) => k === path || k.endsWith(`/${path}`));
	const mod = key && (await stories[key]());
	return mod?.[name] ?? mod?.default;
}

const root = document.getElementById("root");
let current = null;

window.mount = async ({ story, props } = {}) => {
	const Story = await resolve(story);
	if (!Story) throw new Error(`Unknown story: ${story}`);
	current = story;
	root.replaceChildren(Story(props ?? {})); // plain DOM: an update re-renders (no framework state to keep)
};

window.unmount = async () => {
	root.replaceChildren();
	current = null;
};
void current;
