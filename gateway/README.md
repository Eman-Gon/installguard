# InstallGuard gateway

A single-user authenticated gateway connects the buyer, Pay localnet, and the investigation service. All listeners bind to loopback. This is not a multi-tenant hosted product.

## Start

Set a separate private `INSTALLGUARD_ACCESS_TOKEN` of at least 24 characters in the gateway and buyer environment. The launcher creates `INSTALLGUARD_GATE_TOKEN` if omitted; this private fulfillment token is never needed by the buyer or browser.

```sh
INSTALLGUARD_SERVICE_URL=http://127.0.0.1:4311 npm --prefix gateway run demo
```

The service must already be running. Set matching `INSTALLGUARD_INTERNAL_TOKEN` for its authentication. Without a service URL the gateway explicitly returns a fixture with no execution. `INSTALLGUARD_PUBLIC_URL` defaults to `http://127.0.0.1:4312` and must match the buyer's provider policy.

Open the local dashboard and enter the buyer access token. It is kept only in page memory, not the URL or browser storage. Every data route requires `x-installguard-token`. The dashboard shell itself is public and contains no job data.

## API

| Route | Behavior |
| --- | --- |
| GET `/profiles` | Reviewed package/profile metadata |
| POST `/quotes` | Free quote bound to validated artifact/request identity, 0.01 localnet USDC, five-minute expiry |
| POST `/investigations` | Validates the controlled artifact before forwarding Pay challenges or proof |
| GET `/jobs` | Authenticated timeline including receipt evidence |
| GET `/jobs/:id` | Bound payment/execution record |
| GET `/jobs/:id/result` | Result or HTTP 202 pending |
| GET `/jobs/:id/evidence` | Verified evidence bytes |
| POST `/jobs/:id/reconcile` | Retrieve an existing worker result; cannot charge or dispatch a new worker |

Use the client `agent` command for purchasing, not direct Pay calls: it enforces the actual challenge against the reserved budget. The private Pay port (1402) and fulfillment port (4313) must remain inaccessible to buyers in a hosted deployment. The current local setup assumes trusted processes on the host.

## Payment and recovery

A payment-looking header means an attempt, not payment success. Only the authenticated Pay gateway can confirm fulfillment. The gateway records protocol receipt headers when supplied. The client requires a successful receipt associated with the challenge; this still trusts the configured Pay verifier and provider, not a separate chain-verification implementation.

Ordinary duplicate requests return existing state without contacting Pay. Changed input under an existing ID and reused payment proofs are rejected. Restarted pending charges and running executions become unknown. Reconciliation reads existing evidence only; ambiguous charges are never automatically retried or refunded.

The quote and YAML currently both specify 10000 atomic units of USDC. If pricing changes, update both; the buyer rejects any mismatch. Separate service/gateway stores retain their operational roles; the service owns the queryable pattern history.

## Verification

```sh
node --experimental-sqlite --test gateway/test/*.test.mjs
node --experimental-sqlite --import ./client/node_modules/tsx/dist/loader.mjs scripts/sandbox-smoke.mjs
```

Run from the repository root. Unit tests mock the payment verifier; the smoke script starts a real Pay 0.26.0 localnet gateway, buys both controlled investigations, verifies receipts and replay identity, and cleans up temporary processes/data. Worker execution in that smoke script is explicitly native development mode, not isolated Docker. Existing `evidence/` captures are historical rehearsal evidence, not evidence for every subsequent revision.
