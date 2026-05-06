'use strict';

/**
 * Unit tests for the Verdex GitHub Action telemetry collector.
 *
 * Strategy: mock @actions/core, @actions/github, fs, os, and the http/https
 * modules so no real network calls or file-system reads occur.  Each helper
 * function is tested in isolation; run() is tested for its happy-path and
 * non-fatal error-suppression behaviour.
 */

// ── Module-level mocks (must be before require) ───────────────────────────────

jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  setOutput: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  context: {
    runId: 42,
    workflow: 'CI',
    runNumber: 7,
    ref: 'refs/heads/main',
    sha: 'abc1234',
    repo: { owner: 'acme', repo: 'my-app' },
  },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

jest.mock('os', () => ({
  platform: jest.fn(() => 'linux'),
  arch: jest.fn(() => 'x64'),
  cpus: jest.fn(() => [1, 2, 3, 4]),
  totalmem: jest.fn(() => 8 * 1024 * 1024 * 1024), // 8 GB
}));

// ── Imports ───────────────────────────────────────────────────────────────────

const core = require('@actions/core');
const fs = require('fs');

const {
  buildPayload,
  parseCacheHits,
  readNetworkStats,
} = require('../index');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal fake HTTP response stream. */
function fakeResponse(body, statusCode = 200) {
  const { EventEmitter } = require('events');
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.resume = jest.fn();
  process.nextTick(() => {
    res.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    res.emit('end');
  });
  return res;
}

/** Build a minimal fake HTTP request object. */
function fakeRequest(responseBody = {}) {
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.write = jest.fn();
  req.end = jest.fn(() => {
    process.nextTick(() => {
      const res = fakeResponse(responseBody);
      req.emit('response', res); // not used directly — handled by http.request callback
    });
  });
  req.setTimeout = jest.fn();
  req.destroy = jest.fn();
  return req;
}

// ── parseCacheHits ────────────────────────────────────────────────────────────

describe('parseCacheHits', () => {
  const original = { ...process.env };

  afterEach(() => {
    // Restore env after each test
    Object.keys(process.env).forEach((k) => {
      if (k.startsWith('ACTIONS_CACHE_HIT_')) {delete process.env[k];}
    });
  });

  it('returns an empty object when no ACTIONS_CACHE_HIT_* vars are set', () => {
    expect(parseCacheHits()).toEqual({});
  });

  it('normalises key names to lower-case', () => {
    process.env.ACTIONS_CACHE_HIT_NPM = 'true';
    process.env.ACTIONS_CACHE_HIT_PIP = 'false';
    const result = parseCacheHits();
    expect(result).toEqual({ npm: true, pip: false });
  });

  it('treats any value other than "true" as false', () => {
    process.env.ACTIONS_CACHE_HIT_CARGO = '1';
    expect(parseCacheHits()).toEqual({ cargo: false });
  });

  afterAll(() => {
    // Belt-and-suspenders restore
    Object.assign(process.env, original);
  });
});

// ── readNetworkStats ──────────────────────────────────────────────────────────

describe('readNetworkStats', () => {
  it('returns null when /proc/net/dev does not exist', () => {
    fs.existsSync.mockReturnValue(false);
    expect(readNetworkStats()).toBeNull();
  });

  it('parses bytes_in and bytes_out, skipping loopback', () => {
    fs.existsSync.mockReturnValue(true);
    // Minimal /proc/net/dev format: header × 2, then one lo row, one eth0 row
    const content = [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      '    lo:    1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0',
      '  eth0:  500000    1000    0    0    0     0          0         0   200000     500    0    0    0     0       0          0',
    ].join('\n');
    fs.readFileSync.mockReturnValue(content);

    const result = readNetworkStats();
    expect(result).toEqual({ bytes_in: 500000, bytes_out: 200000 });
  });

  it('returns null when readFileSync throws', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockImplementation(() => { throw new Error('permission denied'); });
    expect(readNetworkStats()).toBeNull();
  });

  it('handles malformed lines gracefully (NaN becomes 0)', () => {
    fs.existsSync.mockReturnValue(true);
    const content = [
      'header1',
      'header2',
      '  eth0:  notanumber  x  x  x  x  x  x  x  notanumber  x  x  x  x  x  x  x',
    ].join('\n');
    fs.readFileSync.mockReturnValue(content);

    const result = readNetworkStats();
    expect(result).toEqual({ bytes_in: 0, bytes_out: 0 });
  });
});

// ── buildPayload ──────────────────────────────────────────────────────────────

describe('buildPayload', () => {
  const savedEnv = {};

  beforeEach(() => {
    // Clear relevant env vars
    ['GITHUB_JOB', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_NAME'].forEach((k) => {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    });
    fs.existsSync.mockReturnValue(false); // no /proc/net/dev
  });

  afterEach(() => {
    Object.entries(savedEnv).forEach(([k, v]) => {
      if (v === undefined) {delete process.env[k];}
      else {process.env[k] = v;}
    });
  });

  it('includes the correct repository from github context', () => {
    const payload = buildPayload(false);
    expect(payload.repository).toBe('acme/my-app');
  });

  it('uses RUNNER_OS / RUNNER_ARCH env vars when available', () => {
    process.env.RUNNER_OS = 'Linux';
    process.env.RUNNER_ARCH = 'ARM64';
    const payload = buildPayload(false);
    expect(payload.runner.os).toBe('Linux');
    expect(payload.runner.arch).toBe('ARM64');
  });

  it('falls back to os.platform() / os.arch() when runner vars are absent', () => {
    const payload = buildPayload(false);
    expect(payload.runner.os).toBe('linux');
    expect(payload.runner.arch).toBe('x64');
  });

  it('reports correct cpu_count and total_memory_mb from os module', () => {
    const payload = buildPayload(false);
    expect(payload.runner.cpu_count).toBe(4);
    expect(payload.runner.total_memory_mb).toBe(8192);
  });

  it('sets network to null when collectNetwork is false', () => {
    const payload = buildPayload(false);
    expect(payload.network).toBeNull();
  });

  it('sets network to null when /proc/net/dev is absent even if collectNetwork is true', () => {
    fs.existsSync.mockReturnValue(false);
    const payload = buildPayload(true);
    expect(payload.network).toBeNull();
  });

  it('includes network stats when collectNetwork is true and /proc/net/dev exists', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(
      ['h1', 'h2', '  eth0:  100  0  0  0  0  0  0  0  200  0  0  0  0  0  0  0'].join('\n')
    );
    const payload = buildPayload(true);
    expect(payload.network).toEqual({ bytes_in: 100, bytes_out: 200 });
  });

  it('sets job_name to null when GITHUB_JOB is not set', () => {
    const payload = buildPayload(false);
    expect(payload.job_name).toBeNull();
  });

  it('uses GITHUB_JOB when set', () => {
    process.env.GITHUB_JOB = 'build';
    const payload = buildPayload(false);
    expect(payload.job_name).toBe('build');
  });

  it('includes a valid ISO-8601 collected_at timestamp', () => {
    const payload = buildPayload(false);
    expect(() => new Date(payload.timing.collected_at)).not.toThrow();
    expect(payload.timing.collected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── postTelemetry ─────────────────────────────────────────────────────────────

describe('postTelemetry', () => {
  let mockHttps;

  beforeEach(() => {
    mockHttps = { request: jest.fn() };
    jest.doMock('https', () => mockHttps);
  });

  it('resolves with parsed JSON response body', async () => {
    const responseBody = { report_url: 'https://verdex.dev/r/123' };
    const req = fakeRequest();
    mockHttps.request.mockImplementation((options, callback) => {
      const res = fakeResponse(responseBody);
      callback(res);
      return req;
    });

    // Re-require after mock is set so the module picks up the mocked https
    jest.resetModules();
    jest.doMock('https', () => mockHttps);
    jest.doMock('@actions/core', () => core);
    const { postTelemetry: pt } = require('../index');

    const result = await pt('https://api.verdex.dev', 'test-key', { foo: 'bar' });
    expect(result).toEqual(responseBody);
  });

  it('resolves with empty object when response body is not valid JSON', async () => {
    const req = fakeRequest();
    mockHttps.request.mockImplementation((options, callback) => {
      const res = fakeResponse('not-json');
      callback(res);
      return req;
    });

    jest.resetModules();
    jest.doMock('https', () => mockHttps);
    jest.doMock('@actions/core', () => core);
    const { postTelemetry: pt } = require('../index');

    const result = await pt('https://api.verdex.dev', 'test-key', {});
    expect(result).toEqual({});
  });

  it('sends X-Verdex-Api-Key header', async () => {
    const req = fakeRequest();
    let capturedOptions;
    mockHttps.request.mockImplementation((options, callback) => {
      capturedOptions = options;
      const res = fakeResponse({});
      callback(res);
      return req;
    });

    jest.resetModules();
    jest.doMock('https', () => mockHttps);
    jest.doMock('@actions/core', () => core);
    const { postTelemetry: pt } = require('../index');

    await pt('https://api.verdex.dev', 'my-secret-key', {});
    expect(capturedOptions.headers['X-Verdex-Api-Key']).toBe('my-secret-key');
  });
});

// ── run() — integration-style ─────────────────────────────────────────────────

describe('run', () => {
  beforeEach(() => {
    jest.resetModules();
    // Re-apply mocks after resetModules (doMock avoids hoisting restrictions)
    jest.doMock('@actions/core', () => core);
    jest.doMock('@actions/github', () => ({
      context: {
        runId: 1,
        workflow: 'CI',
        runNumber: 1,
        ref: 'refs/heads/main',
        sha: 'deadbeef',
        repo: { owner: 'test', repo: 'repo' },
      },
    }));
    jest.doMock('fs', () => fs);
    fs.existsSync.mockReturnValue(false);
    core.getInput.mockReset();
    core.warning.mockReset();
    core.setOutput.mockReset();
    core.info.mockReset();
  });

  it('calls core.warning (non-fatal) when api-key is missing', async () => {
    core.getInput.mockImplementation((name, opts) => {
      if (opts && opts.required) {throw new Error('Input required and not supplied: api-key');}
      return '';
    });

    const { run: r } = require('../index');
    await r();

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Verdex telemetry failed (non-fatal)')
    );
  });

  it('sets report-url output when API returns report_url', async () => {
    core.getInput.mockImplementation((name) => {
      if (name === 'api-key') {return 'test-key';}
      if (name === 'api-url') {return 'http://localhost:9999';}
      if (name === 'collect-network') {return 'false';}
      return '';
    });

    const mockHttp = { request: jest.fn() };
    jest.doMock('http', () => mockHttp);

    const req = fakeRequest({ report_url: 'https://verdex.dev/r/42' });
    mockHttp.request.mockImplementation((options, callback) => {
      callback(fakeResponse({ report_url: 'https://verdex.dev/r/42' }));
      return req;
    });

    const { run: r } = require('../index');
    await r();

    expect(core.setOutput).toHaveBeenCalledWith('report-url', 'https://verdex.dev/r/42');
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('https://verdex.dev/r/42')
    );
  });

  it('does NOT throw when the API call fails — logs warning instead', async () => {
    core.getInput.mockImplementation((name) => {
      if (name === 'api-key') {return 'test-key';}
      if (name === 'api-url') {return 'https://api.verdex.dev';}
      if (name === 'collect-network') {return 'false';}
      return '';
    });

    // Override https to simulate a network error
    const mockHttpsError = {
      request: jest.fn((_options, _callback) => {
        const req = fakeRequest();
        req.end = jest.fn(() => req.emit('error', new Error('ECONNREFUSED')));
        return req;
      }),
    };
    jest.doMock('https', () => mockHttpsError);

    const { run: r } = require('../index');
    await expect(r()).resolves.not.toThrow();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Verdex telemetry failed (non-fatal)')
    );
  });
});
