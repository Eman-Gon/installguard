# Investigation service (Person 2)

## Daytona API worker

The service now supports `INSTALLGUARD_WORKER_MODE=daytona`. It starts the configured existing sandbox, runs the fixed remote runner through Daytona SDK 0.220.0, and saves verified execution evidence in the backend data directory. The API credential stays on the backend. This is a single-process, controlled-fixture prototype; it does not accept arbitrary package uploads or buyer commands.

Set these in ignored `service/.env.local` (keep the file owner-readable only):

```dotenv
DAYTONA_API_KEY=<your-key>
DAYTONA_SANDBOX_ID=3e96d2eb-f19e-4354-84b8-1d3658c4a02e
DAYTONA_API_URL=https://app.daytona.io/api
DAYTONA_PROJECT_DIR=/home/node/installguard
```

From the repository root:

```sh
npm --prefix service ci --ignore-scripts
npm --prefix service run daytona -- sync
npm --prefix service run daytona -- check
npm --prefix service run daytona -- demo
```

`sync` uploads only explicitly listed worker, validation, and fixture files, then rebuilds the Docker image. It never uploads environment files. Stop submitting new jobs while syncing. The existing sandbox must already contain the project directory and Docker installation; this command is not a new-sandbox provisioner. Both sync and execution honor a shared remote lock.

`demo` generates Linux x64 requests, runs both fixtures remotely, verifies expected exit codes and stable execution IDs on replay, and writes `service/data/daytona-demo-requests.json` with results/evidence in the same data directory (unless `INSTALLGUARD_DATA_DIR` overrides it). It disables OSV/model calls for deterministic execution checks. **It does not perform payment.** Do not present its output as payment verification.

To connect the existing gateway, load the shared internal token into both processes and select Daytona explicitly. With shared tokens in root `.env` and Daytona credentials in `service/.env.local`, use separate terminals from the repository root:

```sh
INSTALLGUARD_WORKER_MODE=daytona INSTALLGUARD_OFFLINE=1 \
  node --env-file=.env --env-file=service/.env.local service/server.mjs
```

```sh
INSTALLGUARD_SERVICE_URL=http://127.0.0.1:4311 \
  node --env-file=.env gateway/src/launch.mjs
```

The gateway launcher uses Pay sandbox/localnet. Submit a new Linux x64 request through its existing sandbox-payment workflow, then retrieve `/jobs/:requestId/result` and `/jobs/:requestId/evidence`. The evidence endpoint checks the saved SHA-256 digest and never invokes payment. The UI exposes remote sandbox identity, environment, logs, and timestamps in its evidence section. No public listener or public Daytona preview is enabled by this update.

### Lost responses and reconciliation

The backend persists the execution ID before dispatch. The remote runner reserves that ID with an exclusive file before executing Docker. An existing reservation is never executed again. Remote results are stored in `.daytona/executions/` under the remote project; retrieved evidence is also saved on the backend.

If a response is lost, the job remains `unknown`. Retrieve the old result with:

```sh
npm --prefix service run daytona -- reconcile EXISTING_REQUEST_ID
```

The authenticated service also accepts `POST /jobs/:requestId/reconcile`. The gateway's existing private `POST /reconcile/:requestId` route calls that endpoint and updates its own job; use it when payment went through the gateway. Neither route dispatches another test or payment. Polling the ordinary GET routes remains read-only.

Reconciliation conservatively records OSV/model analysis as unavailable when only remote worker evidence survived. A failed test remains `block`, and a passing test remains `review`.

Do not delete execution records or change request IDs to retry ambiguous work. A killed remote process may leave `.daytona/executions/active.lock`; inspect its execution ID, stored result, and running processes before any manual cleanup. The SDK command has a 110-second bound; startup/model work can exceed the gateway's 120-second response window, so use reconciliation rather than replay after a timeout.

Local automated tests use a fake Daytona transport and real durable records to test duplicates, mismatched evidence, and lost responses. Live API and sandbox-payment verification require a configured key and are separate acceptance checks.

Run from the repository root with Node 22.11.0. This component owns `service/`, `worker/`, and `fixtures/`. It uses the shared request/result schemas in `contracts/`. No external runtime dependencies are required for the service itself.

## Development run

```sh
node --test service/test/*.test.mjs
INSTALLGUARD_WORKER_MODE=local-development node service/demo.mjs
INSTALLGUARD_DEV_MODE=1 INSTALLGUARD_WORKER_MODE=local-development node service/server.mjs
```

Local development mode executes actual `npm ci --ignore-scripts` and Node tests on the host, in a temporary copy of the controlled artifact. It is not isolation or Linux verification. The broken CSV integration fails required-field tests; the corrected integration passes. A local pass stays `inconclusive`/`review` for the requested isolated target. Set `INSTALLGUARD_OFFLINE=1` to skip OSV/Nebius explicitly. Dependency installation can still need npm registry access when its cache is empty.

`service/demo.mjs --generate-only` refreshes manifest/request files without execution. Example requests: `fixtures/csv-broken.request.json` and `fixtures/csv-fixed.request.json`. Use a new request ID after a code change. A stable ID returns its existing result; changed inputs return 409. An interrupted job is not silently rerun.

## Internal HTTP contract

- `POST /investigations`: validates exact identity, synchronously returns the shared result.
- `GET /jobs/:requestId`: returns the result or execution status without execution or charging.
- `GET /evidence/:executionId.json`: returns detailed execution/environment, tool results, and advisory evidence.
- `GET /health`: reports service availability.

Bind is always `127.0.0.1`, default port 4311 (`INSTALLGUARD_SERVICE_PORT` overrides). Require `Authorization: Bearer ...` using `INSTALLGUARD_INTERNAL_TOKEN` outside explicit development. Gateway must forward this internal token. Never expose this upstream directly; authentication is not payment verification. Persistent atomic job/evidence records live in `service/data/` (`INSTALLGUARD_DATA_DIR` overrides). This is a single-process prototype; gateway owns payment reconciliation and production persistence. Do not share a data directory across service processes.

The service does not collect or claim payment. Fixtures are labeled `fixture: true` even when execution is real. Test failures are functional findings, not malware accusations. Passing tests never automatically approve installation.

## Isolated worker

```sh
docker build -f worker/Dockerfile -t installguard-worker:node22.11.0 .
INSTALLGUARD_DEV_MODE=1 node service/server.mjs
```

The Docker image pins Node 22.11.0 and contains the locked npm cache. Each runtime uses the resolved image digest, disables networking, drops capabilities, uses a nonroot user, enforces CPU/memory/process/time limits, and mounts the artifact read-only. Installation uses `npm ci --offline --ignore-scripts` inside temporary storage. Results record actual OS, architecture, Node version, and image identity. Use only these controlled harmless fixtures; this is not a hostile-code sandbox. Docker was unavailable on the initial development host, so this path is implemented but not runtime-verified there.

Artifact identity is the SHA-256 of JSON for sorted `{path,sha256}` entries of the flat controlled fixture directory, excluding `node_modules`; lockfile bytes have their own SHA-256. The worker verifies the copied snapshot before execution. The only package allowed is `csv-parse@5.6.0`, and the only profile is `csv-validation-v1`. Arbitrary shell commands and remote artifacts are rejected.

## Investigation

OSV uses [exact package/version queries](https://google.github.io/osv.dev/post-v1-query/) and permits advisory retrieval only for returned IDs. Evidence records query errors as unavailable, never clean results.

Set `NEBIUS_API_KEY` and `NEBIUS_MODEL` to enable the [Nebius tool-use loop](https://docs.tokenfactory.nebius.com/ai-models-inference/function-calling). It uses the official OpenAI-compatible chat-completions endpoint, at most four inference rounds and three tool calls per round. Tools are allowlisted and cached; a request can execute its test at most once. The harness completes any missing mandatory evidence and derives outcome/policy independently of model prose. No model/credentials were configured or charged during initial verification; live model/tool compatibility remains unverified. Credentials are not forwarded into workers.

## Local Nebius configuration

`service/.env.local` stores the development API key and model. It is ignored by Git and restricted to the file owner. `npm --prefix service start` and `npm --prefix service run demo` load this file automatically; existing shell environment variables take precedence. Existing internal authentication and worker configuration are still required.

For direct commands from the repository root, use `node --env-file=service/.env.local service/server.mjs` (or `service/demo.mjs`). The configured public model is `Qwen/Qwen3-30B-A3B-Instruct-2507`; the Nebius console confirms tool calling and Chat Completions support. No dedicated endpoint is needed. Live inference incurs usage charges and has not yet been tested with this credential.


## Agent workflow and evidence memory (2026-09-30)

The buyer now has a bounded localnet purchase/resume command; see `client/README.md`.
Reviewed package/target/test-file configuration lives in `profiles/registry.json` and is consumed by service validation and local/remote workers. Build a selected profile with `node scripts/build-profile.mjs PROFILE` from the root. Resync remote workers after changes: they now also need `shared/identity.mjs`, `shared/profiles.mjs`, and the registry.

`patterns.sqlite` in the service data directory stores indexed, deduplicated observations and references the immutable raw evidence files. Pattern counts enter model context; suggested explanations remain unpromoted. History errors degrade to current evidence only. Every investigation still runs its required checks. This is memory and retrieval, not model training or a demonstrated accuracy improvement.

Results include separate functional, vulnerability, and environment assessments. Exact-version OSV findings now block installation independently of a functional pass. OSV unavailability remains unknown. Installation failures and timeouts receive specific recommendations rather than CSV-specific repair advice.

Start/test scripts include `--experimental-sqlite` for Node 22.11. Direct invocations of `service/server.mjs` must include that flag. The September 30 real Pay smoke test uses native development execution. Local Docker Desktop currently reports that it cannot start; isolation has not been verified by that test.
