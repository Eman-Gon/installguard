# InstallGuard: Daytona API Sandbox Execution Plan

Status: implementation added locally. Adapter, durable remote runner, reconciliation, evidence endpoint, UI evidence, and setup commands are implemented. The API key is configured in ignored backend configuration. Live Daytona API and sandbox-payment verification remain pending source-sync approval. See `service/README.md` for runnable commands.

## Objective

Let an agent purchase a controlled dependency test, have InstallGuard execute it remotely through the Daytona API, and retrieve durable evidence without paying or executing again on an ordinary retry.

For the submission, reuse the existing Daytona sandbox and the verified Docker worker. Support only `csv-broken` and `csv-fixed`. A passing test remains a review decision, not a general package-safety guarantee.

## Existing foundation

- Daytona sandbox: `3e96d2eb-f19e-4354-84b8-1d3658c4a02e`
- Remote project directory: `/home/node/installguard`
- Verified runtime: Linux x64, Node `22.11.0`
- Worker image: `installguard-worker:node22.11.0`
- Restart helper: `/home/node/installguard/daytona-start.sh`
- Sandbox previews are private; idle auto-stop is 15 minutes.
- The previous sandbox verification passed the client build, 23 tests, and both Docker fixture checks. Rerun verification after this update.
- The code currently has no Daytona API adapter. The sandbox source is a copied snapshot, not an automatic Git sync.

## Architecture

```text
Buyer agent
    |
    v
Existing gateway and sandbox payment verification
    |
    v
InstallGuard service and durable job records
    |
    v
Daytona API adapter (backend only)
    |
    v
Existing Daytona sandbox -> fixed remote runner -> Docker worker
    |
    v
Structured result -> backend evidence storage -> buyer and timeline UI
```

Keep the gateway and service outside the execution sandbox for this milestone, such as on the existing development machine. The service owns the Daytona credential and coordinates remote work. The Docker worker receives only the validated test inputs.

## Configuration

Add these names to `.env.example`, and load actual values through the service's existing environment configuration:

```dotenv
INSTALLGUARD_WORKER_MODE=daytona
DAYTONA_API_KEY=
DAYTONA_SANDBOX_ID=3e96d2eb-f19e-4354-84b8-1d3658c4a02e
DAYTONA_PROJECT_DIR=/home/node/installguard
```

The key must stay in ignored backend configuration. Do not put it in browser JavaScript, request payloads, remote commands, worker environments, logs, or evidence. Add the official Daytona SDK as a service dependency and pin the tested version in its lockfile.

## File-by-file changes

| File | Planned change |
| --- | --- |
| `service/daytona-worker.mjs` — new | Connect to the configured sandbox, start it if stopped, verify readiness, dispatch the fixed runner, and retrieve structured results. |
| `service/package.json` and lockfile | Add the tested Daytona SDK dependency. Keep the adapter under `service/` so dependency resolution works. |
| `worker/remote-entry.mjs` — new | Validate controlled input, reserve an execution ID atomically, invoke `runWorker(reference, 'docker', request)`, and persist the result. |
| `service/jobs.mjs` | Select the Daytona adapter explicitly, persist remote identifiers, serialize remote investigations, and support result reconciliation. |
| `service/investigator.mjs` | Preserve ambiguous remote execution as `unknown`; prevent model or deterministic fallback from dispatching it again. |
| `worker/run.mjs` | Reject unsupported worker modes explicitly. Preserve existing Docker isolation settings and artifact checks. |
| `gateway/src/server.mjs` | Keep payment behavior intact; expose validated remote evidence or a bounded evidence summary for the existing job. |
| `web/index.html` | Display remote execution status, environment, exit code, and evidence alongside payment status. |
| `.env.example` and `service/README.md` | Document configuration, preflight, demo commands, and reconciliation. |
| `service/test/` and `gateway/test/` | Add targeted adapter, retry, timeout, evidence, and contract tests. |

## Execution method

1. Validate the request and preserve the gateway's existing payment boundary.
2. Look up the existing request before applying the one-job capacity limit. Return a stored result when available; reject the same ID with different inputs.
3. Create a backend execution record before dispatch. Save its execution ID, sandbox ID, request digest, and dispatch state.
4. Start the configured sandbox if necessary. Verify the expected project files, Docker availability, worker image, and actual runtime.
5. Send validated structured input to a fixed runner. Do not interpolate buyer-provided commands, paths, goals, or package strings into a shell command.
6. The remote runner atomically reserves the execution ID, binds it to the request digest, and records its state before starting Docker. An existing reservation must not launch another run.
7. Verify remote fixture and lockfile digests against the approved request. Invoke the existing Docker worker with the full expected request.
8. Persist the remote result atomically, including bounded logs, actual environment, image digest, and timestamps.
9. Retrieve and validate the result on the backend. Save evidence locally before reporting completion.
10. Serve subsequent result requests from stored records. Leave the shared sandbox's idle auto-stop enabled; do not stop it while a job is active.

## Retry and failure behavior

| Situation | Required behavior |
| --- | --- |
| Same request is submitted again | Return its existing job/result; no new charge or execution. |
| Same request ID has different inputs | Reject with a conflict. |
| Connection drops after dispatch may have happened | Mark execution `unknown`; retrieve the existing remote record before considering further action. |
| Backend restarts during execution | Reconcile using the saved sandbox and execution identifiers. |
| Remote reservation exists without a final result | Keep the outcome pending or unknown; do not automatically rerun. |
| Fixture digest or target environment does not match | Report inconclusive or reject; do not claim the requested target was verified. |
| Test exits nonzero | Record completed execution with a failed test finding; distinguish this from infrastructure failure. |
| Daytona configuration is missing | Return a clear configuration error; do not silently fall back to local execution. |

The gateway currently allows 120 seconds for its service request. Account for sandbox startup, worker execution, and optional model calls explicitly. If the response deadline expires, preserve the job for polling/reconciliation instead of triggering another run.

This is a single-service-process prototype with one remote investigation at a time. Duplicate protection is not a claim of universal exactly-once execution across arbitrary crashes or multiple service instances.

## Evidence and UI

Reuse the existing strict result schema where possible. Store detailed execution information in the evidence document referenced by that result:

- Provider: Daytona, plus sandbox and execution identifiers
- Request, artifact, and lockfile digests
- Actual OS, architecture, Node version, and Docker image digest
- Start and finish timestamps
- Installation and test exit codes, bounded logs, and limitations

If a top-level result field is necessary, update the TypeScript schema, generated JSON schemas, gateway validation, and client tests together. Do not add fields that strict validators will reject.

Show a timeline of payment confirmation, remote execution, test completion, and evidence availability. A gateway evidence endpoint must resolve only evidence belonging to the recorded job, not arbitrary paths or URLs supplied by a request.

Label payments as sandbox/localnet and inputs as controlled fixtures. Preserve `fixture: true`; passing tests must not automatically produce an installation `allow` decision.

## Two-hour implementation schedule

| Time | Deliverable |
| --- | --- |
| 0–15 minutes | Configure the SDK and credential; verify sandbox startup and worker readiness. |
| 15–50 minutes | Implement the adapter and fixed remote runner; run both fixtures through the API. |
| 50–75 minutes | Add durable dispatch records, serialization, and unknown-outcome reconciliation. |
| 75–90 minutes | Expose saved remote evidence and show it in the existing UI. |
| 90–105 minutes | Verify the full sandbox-payment flow, retries, and a lost-response scenario. |
| 105–120 minutes | Freeze changes, document commands, commit/push without secrets, and record a backup demo. |

If time runs short, prioritize correct remote execution, retrievable evidence, and duplicate protection over UI polish. Do not present an unfinished payment integration as verified.

## Acceptance checklist

- [ ] The service uses Daytona's API to execute the worker, without manual browser commands.
- [ ] Demo requests target the observed Linux x64 environment rather than a stale arm64 fixture request.
- [ ] `csv-broken` fails and `csv-fixed` passes remotely.
- [ ] Both results include validated artifact identity and actual execution environment.
- [ ] Sandbox payment triggers exactly one dispatch in the normal demo flow.
- [ ] Repeating a request returns the same execution ID and does not create another payment or run.
- [ ] A lost response leaves an unknown outcome that can be reconciled without re-execution.
- [ ] Invalid modes, mismatched digests, and malformed remote results fail closed.
- [ ] Results and evidence remain readable when the Daytona sandbox is stopped.
- [ ] Existing build/tests and new targeted tests pass.
- [ ] Credentials are absent from source control, browser responses, and evidence.
- [ ] A reproducible demo command and backup recording are ready.

## Deferred work

Fresh sandboxes per investigation, arbitrary package uploads, multiple runtimes, unattended real-money purchases, automatic repairs, and multi-tenant production deployment are outside this update.

## Submission description

> InstallGuard lets agents purchase controlled dependency tests executed remotely through Daytona, with retrievable evidence and duplicate-request protection.

## Official references

- [Daytona TypeScript SDK](https://www.daytona.io/docs/en/typescript-sdk/daytona/)
- [Sandbox lifecycle API](https://www.daytona.io/docs/en/typescript-sdk/sandbox/)
- [Sandbox documentation](https://www.daytona.io/docs/en/sandboxes/)

Verify exact SDK method signatures against the installed version during implementation.
