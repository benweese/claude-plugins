# benweese Claude Code plugins

[![Validate plugins](https://github.com/benweese/claude-plugins/actions/workflows/validate.yml/badge.svg)](https://github.com/benweese/claude-plugins/actions/workflows/validate.yml)

A [Claude Code](https://claude.com/claude-code) plugin marketplace named **`benweese`**. Each plugin installs on its own as `<plugin>@benweese`.

**[Docs site](https://code.benweese.com/claude-plugins/)** · By **[Ben Weese](https://benweese.com/)**

## Plugins

| Plugin | Version | What it does |
| ------ | ------- | ------------ |
| [qa](plugins/qa/README.md) | 1.5.1 | Plan, generate, run and heal Playwright API and UI tests in TypeScript, with a human review step between plan and code; review tests against the original request; accessibility and component testing agents |
| [docs](plugins/docs/README.md) | 0.2.0 | `/docs sweep` (README, `CLAUDE.md`, JSDoc) and `/docs phase N` (end-of-phase docs update + PR) |
| [workflow](plugins/workflow/README.md) | 0.3.1 | `/board` for GitHub Projects (configured per repo), a lint check, and opt-in session rules |
| [guardrails](plugins/guardrails/README.md) | 0.1.3 | Blocks committing secrets (on by default); opt-in protected files, a confirm step for destructive commands, lint after edit |
| [privacy](plugins/privacy/README.md) | 0.1.2 | `/privacy-scan`, a reviewer agent, an opt-in commit blocker and a plain-git hook for personal data |
| [accessibility](plugins/accessibility/README.md) | 0.1.1 | `/a11y` (axe scan with plain-English fixes), an a11y-reviewer agent and a contrast calculator |

What changed: the [marketplace changelog](CHANGELOG.md) and each plugin's own CHANGELOG. Planned: more for `docs` and `workflow`. See [docs/marketplace-plan.md](docs/marketplace-plan.md).

## Install

From a terminal, in the repo you want the plugin in (one step; Claude Code 2.1.275 or later):

```bash
claude plugin install qa --marketplace benweese/claude-plugins
```

Or add the marketplace once, then install any plugin from it:

```bash
claude plugin marketplace add benweese/claude-plugins
claude plugin install qa@benweese
claude plugin install docs@benweese
claude plugin install workflow@benweese
claude plugin install guardrails@benweese
claude plugin install privacy@benweese
claude plugin install accessibility@benweese
```

Add `--scope project` to record a plugin in the repo's `.claude/settings.json` for everyone who opens it. Where your client has the `/plugin` command, `/plugin install <plugin> --marketplace benweese/claude-plugins` does the same.

**Plugins load when a session starts.** Start a new Claude Code session after installing (in VS Code: **Developer: Reload Window**).

**Upgrading from `playwright-qa-agents@playwright-ai-qa-agents` (0.x):** that plugin is now `qa@benweese` 1.0.0. See the [qa changelog](plugins/qa/CHANGELOG.md).

## Hooks are opt-in per project

Claude Code runs a plugin's hooks in every project where the plugin is enabled. So every hook in these plugins reads the project's own config (`.claude/<plugin>.json`) first and does nothing unless that project opts in. A missing or invalid config means **off**. The one exception is the `guardrails` secret blocker, which is on once you install `guardrails` (projects can opt out). Details are in the [marketplace plan](docs/marketplace-plan.md).

## Repo layout

```
.claude-plugin/marketplace.json   the "benweese" marketplace: one entry per plugin (source ./plugins/<name>)
plugins/<name>/                   one plugin each: .claude-plugin/plugin.json, README, CHANGELOG, agents/ skills/ hooks/
examples/sample-app/              a tiny app the plugins test themselves against (no dependencies)
docs/marketplace-plan.md          what's planned, the config files and the hook rules
shared/                           code more than one plugin needs, copied into each by scripts/sync-shared.mjs
scripts/                          docs site build, sync-shared.mjs
.github/workflows/                CI (below) and the docs site
CHANGELOG.md                      marketplace-level changes (each plugin has its own)
```

## CI

| Workflow | Runs | What it checks |
| -------- | ---- | -------------- |
| `validate.yml` | every push and PR | the marketplace and every plugin (`claude plugin validate --strict`), plugin vs marketplace versions, the README table, the commons templates, every plugin's tests (with a real Playwright + axe run) |
| `gitleaks.yml` | every push and PR | secrets in the whole git history (the gitleaks CLI in a container) |
| `actionlint.yml` | when workflows change | the workflow files (actionlint in a container) |
| `codeql.yml` | PRs, pushes to `main`, weekly | code scanning: JavaScript/TypeScript and the workflows |
| `pages.yml` | pushes to `main` that change docs | publishes the [docs site](https://code.benweese.com/claude-plugins/) |
| `release.yml` | a pushed `<plugin>--v<version>` tag; or by hand (one tag, or every `--v` tag without a release) | publishes a GitHub release for a signed tag that passes the checks below, with that version's CHANGELOG section as the notes; never creates a tag |
| `claude-review.yml` | the owner's ready (non-draft) PRs | Claude reviews the PR (comments only; never pushes). Not on fork PRs |
| `claude.yml` | `@claude` in the owner's comments | Claude answers or reviews (can't push) |
| `skill-eval.yml` | **only** the `eval` label on a PR, or started by hand | grades the changed skills (or one named skill) against their `evals/` cases, one skill per job, pass mark 80% |

The repo allows only GitHub-owned actions plus an allow list (`anthropics/claude-code-action@*` and the `oven-sh/setup-bun@*` it runs inside, `skill-bench/skill-eval-action` at one exact SHA), so third-party tools run with `docker run` from images pinned by tag + digest in `.github/docker/<tool>/Dockerfile`. Every action is pinned to a commit SHA. Tests fail on an unpinned or disallowed `uses:` or an unpinned image, and Dependabot keeps the action pins and image digests current.

## Development

```bash
claude plugin validate .                         # the marketplace
claude plugin validate plugins/<name> --strict   # one plugin
node examples/sample-app/server.mjs              # the sample app on http://localhost:4321
node --test plugins/*/test/*.test.mjs test/*.test.mjs examples/sample-app/server.test.mjs   # all tests
node scripts/sync-shared.mjs                     # after editing shared/ (a test fails if copies differ)
```

**Releasing a plugin:**
1. In a PR, bump `version` in `plugins/<name>/.claude-plugin/plugin.json`, in its entry in `.claude-plugin/marketplace.json` and in the table above (CI fails if they differ), and add a `## [<version>] - <date>` section to its `CHANGELOG.md`.
2. Merge the PR. **Merge first, then tag.** A tag on a commit that isn't on `main` yet fails with "tagged commit is not on main", and nothing retries it. After merging, you'd have to start **Release plugins** by hand with that tag.
3. On an up-to-date `main`, run `cd plugins/<name> && claude plugin tag --dry-run`. If it looks right, run `claude plugin tag --push`. That creates and pushes a **signed annotated** `<name>--v<version>` tag, the format [Claude Code's dependency resolution](https://code.claude.com/docs/en/plugin-dependencies) reads. It needs a working GPG or SSH signing setup (`tag.gpgSign = true`), with the key added to your GitHub account as a **signing** key.
4. The pushed tag runs `release.yml`, which publishes the release. It never creates a tag. For each tag, in this order:
   1. **Already released?** If that version has a release (under `<name>--v<version>` or the old `<name>-v<version>`), it's skipped.
   2. **On main?** The tagged commit must be on `main` (an ancestor of `origin/main`). Otherwise: "tagged commit is not on main".
   3. **Signed?** The tag must be annotated, with a signature GitHub reports as verified. Otherwise: "lightweight tag", "annotated but unsigned", or "signature not verified by GitHub (<reason>)".
   4. **Versions match?** At the tagged commit, `plugin.json` and the `marketplace.json` entry must both say the tag's version.
   5. **Release notes?** At the tagged commit, the plugin's `CHANGELOG.md` must have a `## [<version>]` section. Its body becomes the release notes. A version with a pre-release part (`1.0.0-beta.1`) is published as a pre-release.

**Trust model.** The workflow checks out `main` and runs **main's** `release.mjs`, which reads the tagged commit with `git show`. That fixes a stale script in an old tag. It doesn't protect against a malicious tag: on a tag push, GitHub reads the *workflow file* from the tagged commit, so whoever can push a `*--v*` tag controls what runs. The real protection is repository rulesets:
- a **tag ruleset** on `refs/tags/*--v*` that restricts creating, updating and deleting those tags to the repo admin (the maintainer)
- the **branch ruleset** on `main`: pull requests required, no force pushes, no deletion

The release check accepts any signing key GitHub verifies for the tagger. There's no allowlist of taggers or keys, because with the tag ruleset only the maintainer can create these tags. Rulesets can't tell the maintainer apart from tools running with the maintainer's own credentials, Claude Code included.

**Push tags one at a time.** `claude plugin tag --push` pushes one tag. GitHub doesn't start tag-push runs when more than 3 tags are pushed at once, and older pending runs in a shared concurrency group get cancelled; the workflow uses one group per tag. If a tag was missed, the empty-tag catch-up below releases it.

**After the first real tag push** on this flow, check that the push-triggered **Release plugins** run released it. If it didn't, start the workflow by hand with that tag.

A failed check means no release for that tag, with the reason in the workflow log. To re-run a tag, or to catch up every `--v` tag without a release, start **Release plugins** by hand. Preview locally with `node scripts/release.mjs --dry-run` (add `--tag <name>--v<version>` for one tag). Old tags and releases are left as they are.

**Skill evals:** each skill has 3–5 cases in `skills/<skill>/evals/*.yaml` ([format](https://github.com/skill-bench/skill-eval-action#eval-case-format)), including one that shouldn't trigger it. They run on the Anthropic API, so they **cost money** (a few cents per case, paid from a dedicated key with a low spend limit): add the `eval` label to a PR to grade the skills it changes, or run **Skill Eval** by hand for one skill (`<plugin>/<skill>`). They never run automatically. Playwright's vendored `qa:playwright-cli` has no evals.

## History

This repo was **benweese/playwright-ai-qa-agents** until 2026-11-22, when it became **benweese/claude-plugins** (it holds a whole marketplace now, not one Playwright plugin). GitHub redirects the old name for git (clone, fetch, push) and the web, so old clones and marketplace installs keep working; the old docs-site pages redirect from code.benweese.com/playwright-ai-qa-agents/ to code.benweese.com/claude-plugins/. To point an old clone at the new name: `git remote set-url origin git@github.com:benweese/claude-plugins.git`.

**Never create a repo named playwright-ai-qa-agents under benweese — it breaks GitHub's redirect for old clones and marketplace installs.**

## License

MIT. The `qa` plugin bundles Playwright's `playwright-cli` skill, Apache-2.0, from Microsoft's `@playwright/cli`.
