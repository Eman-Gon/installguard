# InstallGuard agent interface

One project-bound MCP server and CLI expose the same backend to coding clients. The MCP server uses the official TypeScript SDK over stdio; tool results go to stdout and diagnostics to stderr. No model API or model-specific implementation is required.

## Scope and status

Implemented: five MCP tools, matching CLI operations, project context collection, backend settings/approval calls, approved-quote submission using the existing bounded sandbox buyer, durable per-quote ledgers, and free result retrieval. The existing gateway owns the dashboard records and verifies approvals/payment before execution. The interface adds no second dashboard or payment verifier.

Automated tests exercise the official MCP SDK client against the real local gateway, plus CLI parity, OFF/declined/revoked behavior, metadata boundaries, stale context rejection, and ledger replay. Payment in the unit suite is simulated explicitly. These tests are not a live Claude/Cursor/Codex conversation or proof of isolated dependency execution. Individual app compatibility remains unverified until each client is connected and exercised. Existing backend worker limits still apply.

The dependency profile currently targets Linux Node 22.11.0 and package-level checks. It does not run the user's full test suite. The backend determines which packages/checks are supported; inspect its result limitations. This interface never uploads source or environment files. It sends package/version, intended-use goal, module type, Node target, a hashed project ID, and a lockfile digest. A hash identifies context; it does not prove whole-project compatibility.

## Setup

From the InstallGuard checkout:

```sh
npm --prefix client ci --ignore-scripts
npm --prefix agent-interface ci --ignore-scripts
```

Use Node 22.11+ with `--experimental-sqlite`. Start the existing gateway and investigation service using the repository's current instructions. The service must support `node-dependency-v1`; do not enable a host-execution fallback for arbitrary packages.

The launcher uses an inherited `INSTALLGUARD_ACCESS_TOKEN` or reads only that field from InstallGuard's root `.env`. It does not load the target project's `.env` or forward backend credentials into the process environment. `--env-file /private/path` overrides the credential file. No credentials are emitted in generated client configurations.

Generate client configuration using your actual application project, not the InstallGuard checkout:

```sh
node agent-interface/config.mjs --project /absolute/path/to/my-app --client codex
node agent-interface/config.mjs --project /absolute/path/to/my-app --client claude
node agent-interface/config.mjs --project /absolute/path/to/my-app --client cursor
```

These commands only print snippets. They do not change installed applications or existing configuration. Each snippet includes absolute paths to the current Node executable, launcher, and project. Regenerate if you move the checkout or remove that Node installation.

- **Codex:** merge the generated TOML into the applicable Codex `config.toml`, preserving existing entries. Set the tool timeout to 180 seconds as shown. [Official Codex MCP configuration](https://developers.openai.com/codex/mcp).
- **Claude Code:** merge the generated JSON into the application's project `.mcp.json` and accept its normal MCP trust prompt. [Official Claude Code MCP setup](https://code.claude.com/docs/en/mcp).
- **Cursor:** merge the generated JSON into the application's `.cursor/mcp.json`, then reload the client. [Official Cursor MCP setup](https://prod.cursor.com/help/customization/mcp).

Add the instructions from [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md) to the coding client's project instructions (for example the existing `AGENTS.md`, `CLAUDE.md`, or Cursor project rule), without replacing unrelated instructions. Registering tools does not ensure every installation is intercepted. Project rules guide tool use; they are not an OS/package-manager enforcement hook.

The integration is project-bound. Configure a separate server instance for each project. Clients using the same checkout/provider/quote share the default ledger directory. Do not configure a different `--data-directory` just to retry an uncertain charge.

## Tools

| MCP tool | CLI command | Effect |
| --- | --- | --- |
| `installguard_get_settings` | `settings` | Read ON/OFF; default OFF |
| `installguard_set_enabled` | `enable` / `disable` | Change setting at user request; ON does not approve spending |
| `installguard_quote_check` | `quote` | Free quote, visible in dashboard; no payment |
| `installguard_submit_check` | `submit` | Purchase/resume only a backend-approved exact quote |
| `installguard_get_result` | `result` | Free retrieval; never purchases |

There is no approve, install, repair, or arbitrary shell-command tool. In this version, the human approves the exact quote in the local dashboard. A chat response alone is insufficient. The backend currently assumes trusted local processes; a process holding the buyer token and unrestricted shell access is not isolated from the approval API. Do not describe the dashboard headers as proof of human presence or a production wallet policy.

After a free quote is created, the integration automatically requests opening the default browser at `/#approve=QUOTE_ID`. The dashboard highlights that quote at the top after connecting. The response includes `approvalUrl` as a clickable fallback and `browserOpen` (`requested`, `unavailable`, or `disabled`). A successful browser command is not proof the page loaded. No access token is placed in the URL; a newly opened browser page may ask you to connect. Set `INSTALLGUARD_OPEN_BROWSER=0` in the MCP server environment for headless/remote usage. Browser opening happens on the machine running the integration, not necessarily the client machine. Existing MCP processes must be restarted to load this change.

## CLI walkthrough

Run these from the checkout; `--project` points to the app you are building:

```sh
node --experimental-sqlite agent-interface/launch.mjs settings --project /absolute/path/to/my-app
node --experimental-sqlite agent-interface/launch.mjs enable --project /absolute/path/to/my-app
node --experimental-sqlite agent-interface/launch.mjs quote --project /absolute/path/to/my-app --package csv-parse --version 5.6.0 --goal 'Check import compatibility before installation'
```

Present the actual returned price/scope. The quote automatically requests opening its approval page; use `approvalUrl` if no page appears. Connect with the buyer access token if needed, and approve or decline that exact quote. Then use its returned ID:

```sh
node --experimental-sqlite agent-interface/launch.mjs submit --project /absolute/path/to/my-app --quote-id QUOTE_ID
node --experimental-sqlite agent-interface/launch.mjs result --project /absolute/path/to/my-app --quote-id QUOTE_ID
```

Submission may return pending. Keep the same ID and retrieve/resume; never generate another paid request for an uncertain result. A changed module type/lockfile invalidates an unsubmitted quote. Result retrieval remains available after expiry or OFF for work already submitted. Installation requires a separate user decision.

All endpoints are loopback-only and all payments remain localnet/sandbox. No real-money checkout or OS-level installation blocker is implemented.

## Validation

```sh
npm --prefix agent-interface test
```

Tests start ephemeral loopback servers and temporary ledgers, leaving the running application alone. MCP framing and lifecycle are handled by the [official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) according to the [stdio transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
