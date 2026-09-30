# InstallGuard agent buyer

An agent can prepare an artifact-bound request, buy a controlled investigation within a local authorization policy, retrieve evidence, repair its project, and submit a changed artifact under a new request ID. The shipped payment adapter supports **MPP fixed-price Solana USDC on localnet**, through a loopback InstallGuard provider. It cannot purchase on mainnet or select arbitrary paid URLs.

## Start

Use Node 22.11+ and Pay 0.26.0 (the tested native version). From the repository root, set `INSTALLGUARD_ACCESS_TOKEN` to a private random value of at least 24 characters and start the gateway as described in `gateway/README.md`. Keep the same buyer token in the client environment. Do not use the private gate token as the buyer token.

From `client/`:

```sh
npm run --silent cli -- prepare \
  --project ../fixtures/csv-broken --reference csv-broken \
  --lockfile ../fixtures/csv-broken/package-lock.json \
  --package csv-parse --version 5.6.0 --node 22.11.0 \
  --profile csv-validation-v1 \
  --goal 'Reject missing required CSV fields' --id investigation-001 > request.json

npm run --silent cli -- agent \
  --request request.json --policy examples/policy.json \
  --project ../fixtures/csv-broken \
  --lockfile ../fixtures/csv-broken/package-lock.json \
  --provider http://127.0.0.1:4312 --ledger .installguard/budget
```

The example policy is a template, not authorization: set its ID, expiry, allowed profiles/providers, and limits to the user's approved values. Amounts are USDC atomic units: 10000 = 0.01 USDC. One authorization uses one persistent ledger path. Never rotate the path or policy to bypass an exhausted allowance.

`agent` obtains a quote, reserves allowance, validates the actual MPP challenge, invokes `pay --sandbox`, saves the receipt, and polls for results. The bridge rejects changed prices, networks, assets, redirects, payloads, repeated payment challenges, and repeated paid submissions. A temporary request file preserves the body across Pay's initial request and paid retry. Cleanup terminates the subprocess group. No mainnet wallet or real funds are used.

## Resume and reconcile

Repeat the same `agent` command after interruption. Existing reservations do not invoke Pay again or obtain a replacement quote. The client reads the bound job, reconciles available receipt evidence, requests retrieval of an unknown worker execution, and polls for results. This can happen after authorization expiry because it does not purchase anything. Missing evidence leaves the allowance reserved.

A bounded polling timeout returns pending; run the same command again. To read only:

```sh
npm run --silent cli -- result --request request.json \
  --policy examples/policy.json --provider http://127.0.0.1:4312
```

`investigate` remains a non-paying compatibility command; HTTP 402 returns payment-required. `--result` reads an explicitly labeled contract fixture.

## Budget durability

The ledger is stored at `<ledger>.sqlite`. SQLite transactions coordinate writers and release locks after process death; pending, unknown, and confirmed entries all consume allowance. A successful receipt remains recorded even if result validation fails. Existing JSON ledgers are imported on first use, preserving their reservations. Stop all old clients before migration. A leftover legacy `.lock` requires explicit reconciliation; it is never deleted based merely on age.

This is a single-user application policy, not an OS security boundary against an agent/process that can rewrite the policy, delete the ledger, or directly invoke the wallet. Production unattended spending requires an independently enforced wallet/service policy. The shipped adapter deliberately stays on localnet.

## Profiles, findings, and memory

Authenticated `GET /profiles` lists reviewed profiles. The registry is `profiles/registry.json`. New controlled fixture directories and their reviewed tests are registered there; callers cannot provide arbitrary shell commands. Build a profile's offline dependency cache with `node scripts/build-profile.mjs PROFILE` from the root. New profiles need testing and review; changing `status` is an operator action, not something model output can promote.

The service records structured observations in `service/data/patterns.sqlite` with package, version, target, profile, artifact, outcome, versioned failure signature, advisory IDs, evidence references/digests, and suggested model explanation. Prior occurrence and distinct-artifact counts enter model context and result history. History cannot suppress required tests or approve installation. Replayed execution IDs do not increase counts. This is retrieval-based memory, not trained-model learning or proof of improved accuracy.

Results separate functional outcome, vulnerability status, and verified environment. Functional failures and reported exact-version vulnerabilities block; other outcomes remain review. Installation failures and timeouts do not get a fabricated CSV diagnosis. Model explanations are suggestions. Only reviewed controlled CSV fixtures are shipped today; arbitrary uploads and automatic profile promotion are unsupported.

## Agent repair loop

Use logs and advisory history to propose a focused implementation change, preserve the reviewed baseline tests, then prepare a new artifact digest and request ID. The agent may purchase that verification within the same allowance. It must not rerun or repurchase an ambiguous request under another ID. The CLI is the execution/purchase tool; the caller's coding agent performs source edits. It does not autonomously invent or promote new profiles, train model weights, deploy code, or enable mainnet purchases.

## Verify

From the repository root:

```sh
npm --prefix client run build
node --experimental-sqlite --import ./client/node_modules/tsx/dist/loader.mjs --test client/test/*.test.ts
node --experimental-sqlite --test gateway/test/*.test.mjs service/test/*.test.mjs
node --experimental-sqlite --import ./client/node_modules/tsx/dist/loader.mjs scripts/sandbox-smoke.mjs
```

The smoke test uses real Pay localnet payments and real native fixture tests; it checks receipts, fail/pass behavior, and replay identity. It explicitly reports that native tests do not establish Linux isolation. No Nebius/OSV calls or mainnet payments occur. Docker Desktop must work before `node scripts/build-profile.mjs` and isolated verification can succeed.

Contracts are generated with `node --import ./client/node_modules/tsx/dist/loader.mjs client/src/export-contracts.ts`. All components share `shared/identity.mjs`.
