/**
 * Verdex CI Energy Monitor — post-step telemetry collector.
 *
 * Runs in the `post:` entry point of action.yml, after all workflow steps
 * complete.  Collects lightweight metrics and POSTs them to the Verdex API
 * for server-side analysis and energy scoring.
 *
 * No business logic lives here — all analysis happens server-side.
 * This file is compiled with `ncc` into dist/index.js before publishing.
 */

// internal: The block below contains internal implementation details.
// Only the compiled dist/index.js is published to the public action repo.

const core = require('@actions/core');
const github = require('@actions/github');
const https = require('https');
const fs = require('fs');
const os = require('os');

async function run() {
  try {
    const apiKey = core.getInput('api-key', { required: true });
    const apiUrl = core.getInput('api-url') || 'https://api.verdex.dev';
    const collectNetwork = core.getInput('collect-network') !== 'false';

    const payload = buildPayload(collectNetwork);

    core.debug(`Sending telemetry to ${apiUrl}`);
    const result = await postTelemetry(apiUrl, apiKey, payload);

    if (result.report_url) {
      core.setOutput('report-url', result.report_url);
      core.info(`Verdex report: ${result.report_url}`);
    }
  } catch (error) {
    // Telemetry failures must never break the build — log as warning only.
    core.warning(`Verdex telemetry failed (non-fatal): ${error.message}`);
  }
}

function buildPayload(collectNetwork) {
  const ctx = github.context;

  const payload = {
    workflow_run_id: ctx.runId,
    workflow_name: ctx.workflow,
    job_name: process.env.GITHUB_JOB || null,
    run_number: ctx.runNumber,
    ref: ctx.ref,
    sha: ctx.sha,
    repository: ctx.repo.owner + '/' + ctx.repo.repo,
    runner: {
      os: process.env.RUNNER_OS || os.platform(),
      arch: process.env.RUNNER_ARCH || os.arch(),
      name: process.env.RUNNER_NAME || null,
      cpu_count: os.cpus().length,
      total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
    },
    timing: {
      // Step-level timing is not available in post: hooks; job-level timing
      // is derived server-side from the GitHub API using the workflow_run_id.
      collected_at: new Date().toISOString(),
    },
    cache_hits: parseCacheHits(),
    network: collectNetwork ? readNetworkStats() : null,
  };

  return payload;
}

function parseCacheHits() {
  // GitHub Actions sets ACTIONS_CACHE_HIT_* env vars for cache steps.
  const hits = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith('ACTIONS_CACHE_HIT_')) {
      const stepName = key.replace('ACTIONS_CACHE_HIT_', '').toLowerCase();
      hits[stepName] = val === 'true';
    }
  }
  return hits;
}

function readNetworkStats() {
  // /proc/net/dev is Linux-only; silently skip on macOS/Windows.
  const procPath = '/proc/net/dev';
  if (!fs.existsSync(procPath)) {return null;}

  try {
    const raw = fs.readFileSync(procPath, 'utf8');
    const lines = raw.trim().split('\n').slice(2); // skip header lines
    let bytesIn = 0;
    let bytesOut = 0;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const iface = parts[0].replace(':', '');
      if (iface === 'lo') {continue;} // skip loopback
      bytesIn += parseInt(parts[1], 10) || 0;
      bytesOut += parseInt(parts[9], 10) || 0;
    }
    return { bytes_in: bytesIn, bytes_out: bytesOut };
  } catch {
    return null;
  }
}

function postTelemetry(apiUrl, apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL('/api/v1/telemetry/ingest', apiUrl);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Verdex-Api-Key': apiKey,
        'User-Agent': 'verdex-action/1.0',
      },
    };

    const protocol = url.protocol === 'http:' ? require('http') : https;
    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({});
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Verdex API request timed out'));
    });
    req.write(body);
    req.end();
  });
}

// Export for unit testing; guard against accidental execution when required.
module.exports = { run, buildPayload, parseCacheHits, readNetworkStats, postTelemetry };

if (require.main === module) {
  run();
}
