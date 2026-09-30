# Optional agent dependency checks

The existing payment client, ledger, gateway, evidence store and dashboard are reused. The new profile is `node-dependency-v1`. Existing CSV fixtures remain regression examples, not the agent interface.

## Start

From the repository root, start the persistent service/gateway (only one instance):

```sh
npm_config_cache=/private/tmp/installguard-npm-cache node --experimental-sqlite scripts/demo-start.mjs
```

The dependency profile always uses Docker even when the old fixture demo uses local-development. Install Docker and prepare its fixed Node image before a paid check:

```sh
docker pull node:22.11.0-slim
```

The worker resolves the installed image to its content digest and records it; the tag is not silently pulled during a check. If Docker/image is unavailable, no dependency code runs on the host and results say unknown. Model calls are disabled for this profile. The default demo has OSV offline; use `DEMO_OFFLINE=0` on the launcher to enable public exact-version OSV queries (no model calls for this profile).

## Agent tools

The parallel `agent-interface/` adapter is compatible with these backend routes and uses the official MCP SDK. Prefer its project-bound configuration generator (`node agent-interface/config.mjs --project /absolute/path/to/app --client codex`, or `claude` / `cursor`) and [setup instructions](agent-interface/README.md). The direct client below is also available for backend tests and CLI use. Do not configure both adapters for the same agent; they expose the same service under different tool names.

Configure a stdio MCP server using the installed Node executable, with these arguments (substitute your checkout path):

```json
{
  "command": "node",
  "args": ["--experimental-sqlite", "--import", "/Users/emanschool/installguard/client/node_modules/tsx/dist/loader.mjs", "/Users/emanschool/installguard/client/src/integration.mjs", "mcp"]
}
```

Load `skills/installguard/SKILL.md` as the integration instructions. Configuration is provided, not automatically installed into Claude or Codex. The server implements newline-delimited stdio MCP initialize, ping, tools/list and tools/call; it has no approval or installation tool.

Tools:

- `installguard_settings({project, enabled?})`: persistent per-project setting, default OFF. Project ID is a hash of canonical local path; the actual path is not transmitted. The local gateway database owns settings. OFF revokes unsubmitted approvals, rejects new quote/submission calls, and preserves history. Already-submitted payments may complete.
- `installguard_quote({project, package, version})`: free quote, exact sandbox amount/expiry, scope and dashboard approval link.
- `installguard_submit({project, quoteId})`: requires the server's human decision for that quote, verifies unchanged context, reuses the existing fixed-price buyer and ledger, returns payment/result plus dashboard URL.
- `installguard_result({project, quoteId})`: reads existing payment evidence and result even while OFF; never purchases.

Equivalent CLI, from the repository root:

```sh
node --experimental-sqlite --import ./client/node_modules/tsx/dist/loader.mjs client/src/integration.mjs settings --project /absolute/path/to/project --enabled on
node --experimental-sqlite --import ./client/node_modules/tsx/dist/loader.mjs client/src/integration.mjs quote --project /absolute/path/to/project --package csv-parse --version 5.6.0
```

Ask the returned question. The human opens the approval URL, connects with `INSTALLGUARD_ACCESS_TOKEN`, and clicks Approve or Decline. Approval is for the check only. Once approved:

```sh
node --experimental-sqlite --import ./client/node_modules/tsx/dist/loader.mjs client/src/integration.mjs submit --project /absolute/path/to/project --quoteId QUOTE_ID
node --experimental-sqlite --import ./client/node_modules/tsx/dist/loader.mjs client/src/integration.mjs result --project /absolute/path/to/project --quoteId QUOTE_ID
```

A conversational yes is not an authenticated approval receipt. The human dashboard click is intentionally required. Report tool output in the conversation, then ask separately about installation. No package install tool is supplied.

## Context and checks

Only a project ID, module type, Node target and lockfile SHA-256 are submitted. `package.json` is read locally for module type; the package lock is hashed locally. No source, scripts, project dependency lists, environment files, npm credentials or absolute project paths go to workers. This limited context does not establish application compatibility. The supported runtime is explicitly Node 22.11.0, not inferred compatibility with every project engine.

Public npm metadata and a single tarball are fetched by the backend from registry.npmjs.org, with redirects denied, response limits, and SHA-512 integrity verification. Packages with dependencies, peers, optional or bundled dependencies are unsupported. The tarball is not extracted or executed on the host. Docker has no network, a read-only root, dropped capabilities, no-new-privileges, a nonroot user, CPU/memory/PID/tmpfs and time bounds. Installation ignores lifecycle scripts; a subprocess attempts import or require according to project module type. No project files or secrets are mounted. Containers are removed after the run.

Installation, import compatibility and vulnerability status are separate. Unavailable checks are unknown; no automatic install permission is returned. OSV queries cover the proposed exact version only, not the entire dependency graph. Arbitrary hostile-code containment is not guaranteed by ordinary containers.

## Authorization boundary

The gateway stores the exact request, quote, human decision and per-project setting. Direct dependency submissions without approval fail before contacting Pay. The client uses that same quote instead of fetching a replacement and limits its persistent ledger to the quoted amount. The actual MPP challenge must match. Unknown/pending payments retain allowance, duplicate jobs do not contact Pay, and new quotes for the same unresolved dependency are refused. UI approval requires authenticated access and same-origin POST; tools do not expose approval.

This is a trusted single-user local integration, not an OS security boundary against a malicious agent that can read credentials, forge browser requests, rewrite the database, or directly invoke the wallet. Installation interception is not implemented. The user must opt into this skill/tool workflow.

## Verified acceptance status

`node --experimental-sqlite --import ./client/node_modules/tsx/dist/loader.mjs scripts/dependency-smoke.mjs` exercises OFF, decline, exact-quote approval, real localnet payment, shared dashboard records and duplicate protection using temporary servers. Its approval is explicitly simulated by the test; it is not a live coding-agent conversation. On a host without Docker the actual checks return unknown. Completing a live isolated acceptance run requires working Docker, the prepared image, a connected coding client, and a human quote approval.
