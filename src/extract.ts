import type { AppConfig } from './config.js';

type ExtractCfg = Pick<AppConfig, 'keyRegexSource' | 'projectKeys'>;

function allowed(key: string, cfg: ExtractCfg): boolean {
  if (cfg.projectKeys.length === 0) return true;
  const sep = key.lastIndexOf('-');
  return sep > 0 && cfg.projectKeys.includes(key.slice(0, sep));
}

/** Pure: commit messages -> deduped, sorted, uppercased Jira keys. */
export function extractJiraKeys(messages: string[], cfg: ExtractCfg): string[] {
  // Fresh RegExp per call: a shared global regex carries stateful lastIndex.
  const matcher = new RegExp('\\b(?:' + cfg.keyRegexSource + ')\\b', 'g');

  const keys = new Set<string>();
  for (const message of messages) {
    for (const match of message.matchAll(matcher)) {
      keys.add(match[0].toUpperCase());
    }
  }
  return [...keys].filter((key) => allowed(key, cfg)).sort();
}

/** Pure: key -> SHA of the FIRST commit whose message references it (same
 * matching rules as extractJiraKeys). Feeds the verdict table's
 * "Referenced in" column; keys from sha-less entries are simply absent. */
export function extractJiraKeySources(
  entries: Array<{ sha: string | null; message: string }>,
  cfg: ExtractCfg,
): Map<string, string> {
  const matcher = new RegExp('\\b(?:' + cfg.keyRegexSource + ')\\b', 'g');
  const sources = new Map<string, string>();
  for (const { sha, message } of entries) {
    if (sha === null) continue;
    for (const match of message.matchAll(matcher)) {
      const key = match[0].toUpperCase();
      if (!allowed(key, cfg)) continue;
      if (!sources.has(key)) sources.set(key, sha);
    }
  }
  return sources;
}
