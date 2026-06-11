import { loadConfig, type AppConfig } from './config.js';
import { JiraClient } from './jira.js';
import { evaluatePullRequest } from './pipeline.js';
import { autoconfigureOrg, ScopeCache } from './rulesets.js';
import type { EvaluationTrigger, LoggerLike, OctokitLike, PullRef } from './types.js';

export interface AppDeps {
  jira?: JiraClient;
  scopeCache?: ScopeCache;
  /** Hook for main.ts to trigger an immediate poll of one installation after
   * ruleset changes. The poller itself is owned by main.ts, never started here. */
  requestInstallationPoll?: (installationId: number) => void;
}

// merge_group.head_ref looks like refs/heads/gh-readonly-queue/<base-branch>/pr-<n>-<sha>.
// The base branch may itself contain "pr-<digits>-" (e.g. feature/pr-9-fix), so the
// PR number must be parsed from the FINAL path segment only, never the first match.
const MERGE_QUEUE_PR_RE = /^pr-(\d+)-/;

interface PrLike {
  number: number;
  head: { sha: string };
  base: { ref: string; sha: string };
}

function pullRefFrom(owner: string, repo: string, pr: PrLike): PullRef {
  return {
    owner,
    repo,
    pullNumber: pr.number,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
  };
}

function repoOf(payload: any): { owner: string; repo: string } {
  return { owner: payload.repository.owner.login, repo: payload.repository.name };
}

export function makeApp(cfg: AppConfig, deps?: AppDeps): (app: any, options?: any) => void {
  return (app: any, _options?: any) => {
    const jira = deps?.jira ?? new JiraClient(cfg, { logger: app.log as LoggerLike });
    const scopeCache = deps?.scopeCache ?? new ScopeCache(cfg.pollIntervalSeconds * 1000);

    const evaluate = async (
      context: any,
      pull: PullRef,
      trigger: EvaluationTrigger,
      opts?: { checkHeadSha?: string },
    ): Promise<void> => {
      await evaluatePullRequest(
        {
          octokit: context.octokit as OctokitLike,
          jira,
          cfg,
          scopeCache,
          log: context.log as LoggerLike,
        },
        pull,
        trigger,
        opts,
      );
    };

    const evaluateFromPayload = async (context: any): Promise<void> => {
      const { owner, repo } = repoOf(context.payload);
      await evaluate(context, pullRefFrom(owner, repo, context.payload.pull_request), 'webhook');
    };

    app.on(
      [
        'pull_request.opened',
        'pull_request.synchronize',
        'pull_request.reopened',
        'pull_request.ready_for_review',
      ],
      evaluateFromPayload,
    );

    app.on('pull_request.edited', async (context: any) => {
      // Only a base retarget can change scope; title/body edits cannot change
      // commit messages.
      if (!context.payload.changes?.base) return;
      await evaluateFromPayload(context);
    });

    const rerequested = async (
      context: any,
      headSha: string,
      payloadPulls: PrLike[],
    ): Promise<void> => {
      const { owner, repo } = repoOf(context.payload);
      let pulls = payloadPulls.map((pr) => pullRefFrom(owner, repo, pr));
      if (pulls.length === 0) {
        // pull_requests[] is empty for fork PRs — resolve them via the commit.
        const res = await context.octokit.request(
          'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
          { owner, repo, commit_sha: headSha },
        );
        const found: PrLike[] = Array.isArray(res.data) ? res.data : [];
        pulls = found.map((pr) => pullRefFrom(owner, repo, pr));
      }
      for (const pull of pulls) {
        await evaluate(context, pull, 'rerequest');
      }
    };

    app.on('check_run.rerequested', async (context: any) => {
      const run = context.payload.check_run;
      if (run.name !== cfg.checkName || run.app?.id !== cfg.appId) return;
      await rerequested(context, run.head_sha, run.pull_requests ?? []);
    });

    app.on('check_suite.rerequested', async (context: any) => {
      const suite = context.payload.check_suite;
      await rerequested(context, suite.head_sha, suite.pull_requests ?? []);
    });

    app.on('repository_ruleset', async (context: any) => {
      const org: string | undefined =
        context.payload.organization?.login ?? context.payload.repository?.owner?.login;
      if (!org) return;
      scopeCache.invalidateOrg(org);
      await autoconfigureOrg(context.octokit as OctokitLike, org, cfg, context.log as LoggerLike);
      const installationId: unknown = context.payload.installation?.id;
      if (typeof installationId === 'number') {
        deps?.requestInstallationPoll?.(installationId);
      }
    });

    app.on('installation.created', async (context: any) => {
      const installation = context.payload.installation;
      if (installation.account?.type !== 'Organization') {
        context.log.warn(
          { evt: 'installation_not_org', account: installation.account?.login },
          'installed on a non-organization account — org rulesets do not exist there, nothing to configure',
        );
        return;
      }
      if (installation.repository_selection === 'selected') {
        context.log.warn(
          {
            evt: 'installation_coverage_warning',
            org: installation.account.login,
            repository_selection: 'selected',
          },
          'app installed on SELECTED repositories only — any prefix ruleset targeting an uncovered repo will require a check no one can post, leaving those PRs permanently unmergeable. Install on All repositories.',
        );
      }
      await autoconfigureOrg(
        context.octokit as OctokitLike,
        installation.account.login,
        cfg,
        context.log as LoggerLike,
      );
    });

    app.on('merge_group.checks_requested', async (context: any) => {
      const mergeGroup = context.payload.merge_group;
      const headRef: string = mergeGroup.head_ref ?? '';
      const lastSegment = headRef.split('/').pop() ?? '';
      const match = MERGE_QUEUE_PR_RE.exec(lastSegment);
      if (!match) {
        context.log.warn(
          { evt: 'merge_group_unparseable', head_ref: mergeGroup.head_ref },
          'cannot parse PR number from merge group head_ref — skipping',
        );
        return;
      }
      const pullNumber = Number(match[1]);
      const { owner, repo } = repoOf(context.payload);
      const res = await context.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo,
        pull_number: pullNumber,
      });
      await evaluate(context, pullRefFrom(owner, repo, res.data as PrLike), 'merge_group', {
        checkHeadSha: mergeGroup.head_sha,
      });
    });
  };
}

let lazyApp: ((app: any, options?: any) => void) | undefined;

/** Probot entrypoint: loads config from process.env on first invocation. */
const appFn = (app: any, options?: any): void => {
  lazyApp ??= makeApp(loadConfig(process.env));
  lazyApp(app, options);
};

export default appFn;
