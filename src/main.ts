import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { pino } from 'pino';
import { Probot, Server } from 'probot';
import type { AppConfig } from './config.js';
import { ConfigError, loadConfig } from './config.js';
import { renderHomepage } from './homepage.js';
import { makeApp } from './index.js';
import { JiraClient } from './jira.js';
import { createPoller } from './poller.js';
import { ScopeCache } from './rulesets.js';
import type { LoggerLike } from './types.js';
import { JiraAuthError, JiraUnavailableError } from './types.js';

const PROBE_RETRY_MS = 60_000;

export interface Readiness {
  ready: boolean;
  reason: string;
}

/** Map a probe failure to a GENERIC category string for the /readyz body.
 * The HTTP server is publicly reachable (homepage + webhooks), so the body
 * must never embed err.message — it carries the internal Jira hostname/IP
 * (e.g. "getaddrinfo ENOTFOUND jira.internal.corp"). Full detail goes to
 * the logs only. */
export function probeFailureReason(err: unknown): string {
  if (err instanceof JiraAuthError) {
    return 'Jira authentication failed — check JIRA_* credentials';
  }
  if (err instanceof JiraUnavailableError) {
    return `Jira unavailable (${err.kind})`;
  }
  return 'Jira probe failed';
}

/** Build the startup Jira probe loop. Exported for tests; `scheduleRetry` is
 * injectable so retry policy can be asserted without timers. Policy:
 * - success: readiness flips ready, no further runs;
 * - JiraAuthError: STOP — no retry is scheduled. A bad login cannot
 *   self-heal, and repeated 401s trip Jira Server's CAPTCHA lockout. The
 *   readiness reason persists until the operator fixes JIRA_* and restarts;
 * - any other failure: retry (default every PROBE_RETRY_MS). */
export function makeStartupProbe(deps: {
  probe: () => Promise<void>;
  readiness: Readiness;
  log: LoggerLike;
  scheduleRetry?: (run: () => void) => void;
}): () => Promise<void> {
  const scheduleRetry =
    deps.scheduleRetry ?? ((run: () => void): void => void setTimeout(run, PROBE_RETRY_MS).unref());
  const run = async (): Promise<void> => {
    try {
      await deps.probe();
      deps.readiness.ready = true;
      deps.readiness.reason = '';
      deps.log.info({ evt: 'jira_probe_ok' }, 'Jira probe succeeded — ready');
      return;
    } catch (err) {
      deps.readiness.ready = false;
      // /readyz gets only the generic category; err.message (which embeds the
      // Jira URL/host) stays in the logs.
      deps.readiness.reason = probeFailureReason(err);
      if (err instanceof JiraAuthError) {
        deps.log.error(
          { evt: 'jira_auth_failed', err: err.message },
          'Jira rejected credentials — fix JIRA_* configuration and restart',
        );
        return;
      }
      if (err instanceof JiraUnavailableError) {
        deps.log.warn(
          { evt: 'jira_probe_failed', kind: err.kind, err: err.message },
          'Jira probe failed — will retry',
        );
      } else {
        deps.log.warn(
          { evt: 'jira_probe_failed', err: (err as Error).message },
          'Jira probe failed — will retry',
        );
      }
      scheduleRetry(() => void run());
    }
  };
  return run;
}

/** fetch wrapper enforcing a per-request timeout on every GitHub API call.
 * Octokit sets no timeout of its own; without this, a connection silently
 * dropped by an enterprise proxy/firewall hangs the poll cycle forever and
 * the cycle mutex then blocks every future cycle. Exported for tests. */
export function makeTimeoutFetch(
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal as AbortSignal, timeout])
      : timeout;
    return fetchImpl(input, { ...init, signal });
  };
}

function resolvePrivateKey(cfg: AppConfig): string {
  let pem: string;
  if (cfg.privateKeyPath) {
    try {
      pem = readFileSync(cfg.privateKeyPath, 'utf8');
    } catch (err) {
      throw new Error(
        `Cannot read private key from PRIVATE_KEY_PATH "${cfg.privateKeyPath}": ${(err as Error).message}`,
      );
    }
  } else {
    pem = cfg.privateKey ?? '';
  }
  if (!pem.includes('BEGIN')) {
    const decoded = Buffer.from(pem, 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) pem = decoded;
  }
  return pem;
}

export function makeRoutesHandler(cfg: AppConfig, readiness: Readiness) {
  const homepage = renderHomepage(cfg);
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET') return false;
    const pathname = (req.url ?? '').split('?')[0];
    switch (pathname) {
      case '/':
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
        });
        res.end(homepage);
        return true;
      case '/healthz':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return true;
      case '/readyz':
        if (readiness.ready) {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('ok');
        } else {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(readiness.reason.replace(/\s*\n\s*/g, ' '));
        }
        return true;
      default:
        return false;
    }
  };
}

async function main(): Promise<void> {
  let cfg: AppConfig;
  let privateKey: string;
  try {
    cfg = loadConfig(process.env);
    privateKey = resolvePrivateKey(cfg);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof Error) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const log = pino({
    level: cfg.logLevel,
    ...(cfg.logFormat === 'pretty' ? { transport: { target: 'pino-pretty' } } : {}),
  });

  // First substantive log line: which GitHub API this process will talk to.
  // "GHE_HOST set but app still calls api.github.com" is always an env-not-
  // reaching-the-container problem — this line settles it instantly.
  log.info(
    { evt: 'github_api_base', url: cfg.githubBaseUrl ?? 'https://api.github.com' },
    cfg.githubBaseUrl
      ? `GitHub API target: ${cfg.githubBaseUrl}`
      : 'GitHub API target: https://api.github.com — set GHE_HOST if this should be a GitHub Enterprise Server instance',
  );

  const jira = new JiraClient(cfg, { logger: log });
  const scopeCache = new ScopeCache(Math.max(60, cfg.pollIntervalSeconds) * 1000);
  const readiness: Readiness = { ready: false, reason: 'startup probe pending' };

  // The poller is created only after server.start() (it needs the running
  // app), but webhook handlers are wired at load time — forward through a
  // late-bound reference.
  let poller: ReturnType<typeof createPoller> | undefined;
  const requestInstallationPoll = (installationId: number): void => {
    poller?.pollInstallation(installationId);
  };

  const server = new Server({
    Probot: Probot.defaults({
      appId: cfg.appId,
      privateKey,
      secret: cfg.webhookSecret,
      logLevel: cfg.logLevel as never,
      logFormat: cfg.logFormat,
      // GitHub Enterprise Server: without this every API call goes to
      // api.github.com regardless of GHE_HOST in the environment.
      baseUrl: cfg.githubBaseUrl,
      request: { fetch: makeTimeoutFetch(cfg.githubTimeoutMs) },
    }),
    port: cfg.port,
    host: cfg.host,
    log,
  });

  let probotRef: Probot | undefined;
  await server.load((app, options) => {
    probotRef = app;
    options.addHandler(makeRoutesHandler(cfg, readiness));
    return makeApp(cfg, { jira, scopeCache, requestInstallationPoll })(app, options);
  });

  await server.start();
  log.info({ evt: 'started', port: cfg.port }, 'jira-merge-lock listening');

  void makeStartupProbe({ probe: () => jira.probe(), readiness, log })();

  poller = createPoller({
    auth: (installationId?: number) => {
      if (!probotRef) throw new Error('Probot instance not initialized');
      return probotRef.auth(installationId);
    },
    cfg,
    jira,
    scopeCache,
    log,
  });
  // Unconditional: start() always runs one immediate cycle (the startup
  // drift-repair / auto-configure trigger depends on this) and only schedules
  // recurring ticks when pollIntervalSeconds > 0.
  poller.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ evt: 'shutdown', signal }, 'shutting down');
    poller?.stop();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Only boot when run as the entry script (`node lib/main.js`) — tests import
// this module for makeRoutesHandler/probeFailureReason and must not start a
// server (or hit process.exit on their env).
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
