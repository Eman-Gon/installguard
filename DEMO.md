# InstallGuard demo

Run these commands from the repository root with Node 22.11+.

Start the local demo in one terminal:

```sh
node --experimental-sqlite scripts/demo-start.mjs
```

Open http://127.0.0.1:4312 and enter `INSTALLGUARD_ACCESS_TOKEN` from the ignored root `.env` file. To copy just that token on macOS:

```sh
node --env-file=.env -e 'process.stdout.write(process.env.INSTALLGUARD_ACCESS_TOKEN)' | pbcopy
```

Run the walkthrough in another terminal:

```sh
node --experimental-sqlite --import ./client/node_modules/tsx/dist/loader.mjs scripts/demo-run.mjs
```

The walkthrough purchases two controlled investigations with a total allowance of 0.02 sandbox USDC: broken CSV validation fails, and the corrected fixture passes. It checks replay identity. It demonstrates predefined before/after fixtures, not an autonomous coding agent. Native execution does not verify Linux isolation; a passing result remains review.

The request IDs, one-day authorization, ledger, and results persist under `gateway/data/demo/`. Repeating the command resumes or retrieves those same requests without another purchase. Do not delete those records to retry an ambiguous payment or execution.

Default execution is local and offline for model/advisory analysis. Sandbox payments still require Pay's sandbox network. Stop the server with Ctrl-C.

For an explicitly authorized live Daytona/Nebius run, stop the local server first and start with:

```sh
DEMO_WORKER_MODE=daytona DEMO_OFFLINE=0 node --experimental-sqlite scripts/demo-start.mjs
```

Live mode sends controlled requests to Daytona and investigation context/logs to Nebius, which may incur inference charges. Existing completed request IDs retain their original execution; switching modes does not rerun them. Use a separately reviewed request and authorization for a new live investigation.
