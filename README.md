# Verdex CI Energy Monitor

> Know your pipeline's carbon cost.

Verdex scores and grades your CI/CD pipelines for energy efficiency — the
"OpenSSF Scorecard for sustainability." This Action collects lightweight
runtime telemetry after your workflow completes and sends it to the Verdex
API for server-side analysis, scoring, and badge generation.

## Usage

Add the Action to your workflow as a final step or as a standalone job:

```yaml
name: CI

on: [push, pull_request]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm

      - run: npm ci
      - run: npm test

      # Add Verdex as the last step — it runs in the post: hook automatically
      - uses: verdex-dev/verdex-action@v1
        with:
          api-key: ${{ secrets.VERDEX_API_KEY }}
```

The Action runs via the `post:` hook, meaning it executes **after all your
workflow steps complete** without adding latency to your build. It never
blocks your pipeline — failures are logged as warnings and suppressed.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | Yes | — | Repository API key from the Verdex dashboard (Settings → API Keys). Store it as a repository secret. |
| `api-url` | No | `https://api.verdex.dev` | Verdex API base URL. Override for self-hosted Verdex deployments. |
| `collect-network` | No | `true` | Whether to collect network I/O metrics from `/proc/net/dev`. Linux only; skipped silently on macOS and Windows. |

## Outputs

| Output | Description |
|--------|-------------|
| `report-url` | URL to the Verdex analysis report generated from this workflow run. |

## What data is collected?

Verdex collects only CI performance metadata — no source code, no secrets,
no build artifacts:

- **Workflow metadata**: run ID, workflow name, job name, run number, ref, SHA
- **Runner environment**: OS, architecture, CPU count, total memory
- **Cache step outcomes**: whether each `actions/cache` step hit or missed
- **Network I/O totals**: bytes in/out from `/proc/net/dev` (Linux, optional)

All data is transmitted over HTTPS with your repository API key for
authentication. See the [Verdex Privacy Policy](https://verdex.dev/privacy)
for full details.

## Getting your API key

1. Sign up or log in at [verdex.dev](https://verdex.dev)
2. Connect your repository (Settings → Repositories → Connect)
3. Go to Settings → API Keys → Create Key
4. Add the key as a repository secret named `VERDEX_API_KEY`

## Self-hosted deployments

Set `api-url` to your Verdex instance:

```yaml
- uses: verdex-dev/verdex-action@v1
  with:
    api-key: ${{ secrets.VERDEX_API_KEY }}
    api-url: https://verdex.internal.example.com
```

To disable LangSmith tracing in self-hosted environments, ensure
`LANGCHAIN_TRACING_V2` is unset in your Verdex backend configuration.

## Badge

After your first successful run, embed your grade badge in your README:

```markdown
[![CI Energy](https://api.verdex.dev/api/v1/badges/your-org/your-repo.svg)](https://verdex.dev/p/your-org/your-repo)
```

Or use [shields.io](https://shields.io/badges/endpoint-badge):

```markdown
[![CI Energy](https://img.shields.io/endpoint?url=https://api.verdex.dev/api/v1/badges/your-org/your-repo/shields.json)](https://verdex.dev/p/your-org/your-repo)
```

## Development

This repository is the **source of truth** for the Action. The compiled
output is automatically synced to the public
[verdex-dev/verdex-action](https://github.com/verdex-dev/verdex-action)
repository via `sync-action.yml` on every push to `main` that touches
`action/**`. Do not send code PRs to the public repo — submit issues there
and contribute fixes here.

### Local development

```bash
cd action
npm install
npm test          # run Jest unit tests with coverage
npm run lint      # ESLint check
npm run build:dev # build dist/index.js without minification (for inspection)
npm run build     # build minified production bundle
```

### Testing

Tests live in `src/__tests__/index.test.js` and use Jest with module-level
mocks for `@actions/core`, `@actions/github`, `fs`, and `os` so no real
network calls or file-system reads occur.

```
PASS src/__tests__/index.test.js
  parseCacheHits
    ✓ returns an empty object when no ACTIONS_CACHE_HIT_* vars are set
    ✓ normalises key names to lower-case
    ✓ treats any value other than "true" as false
  readNetworkStats
    ✓ returns null when /proc/net/dev does not exist
    ✓ parses bytes_in and bytes_out, skipping loopback
    ✓ returns null when readFileSync throws
    ✓ handles malformed lines gracefully (NaN becomes 0)
  buildPayload
    ✓ includes the correct repository from github context
    ✓ uses RUNNER_OS / RUNNER_ARCH env vars when available
    ✓ falls back to os.platform() / os.arch() when runner vars are absent
    ✓ reports correct cpu_count and total_memory_mb from os module
    ✓ sets network to null when collectNetwork is false
    ✓ sets network to null when /proc/net/dev is absent even if collectNetwork is true
    ✓ includes network stats when collectNetwork is true and /proc/net/dev exists
    ✓ sets job_name to null when GITHUB_JOB is not set
    ✓ uses GITHUB_JOB when set
    ✓ includes a valid ISO-8601 collected_at timestamp
  postTelemetry
    ✓ resolves with parsed JSON response body
    ✓ resolves with empty object when response body is not valid JSON
    ✓ sends X-Verdex-Api-Key header
  run
    ✓ calls core.warning (non-fatal) when api-key is missing
    ✓ sets report-url output when API returns report_url
    ✓ does NOT throw when the API call fails — logs warning instead
```

### Architecture

```
action/
├── src/
│   ├── index.js            ← source (compiled by ncc into dist/)
│   └── __tests__/
│       └── index.test.js   ← Jest unit tests
├── dist/
│   └── index.js            ← compiled bundle (committed, published to public repo)
├── action.yml              ← Action metadata
├── package.json            ← deps + test/lint/build scripts
└── eslint.config.js        ← ESLint flat config
```

## License

MIT — see [LICENSE](../LICENSE) for details.
