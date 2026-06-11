import type { AppConfig } from './config.js';

/** Pure: commit messages -> deduped, sorted, uppercased Jira keys. */
export function extractJiraKeys(
  messages: string[],
  cfg: Pick<AppConfig, 'keyRegexSource' | 'projectKeys'>,
): string[] {
  // Fresh RegExp per call: a shared global regex carries stateful lastIndex.
  const matcher = new RegExp('\\b(?:' + cfg.keyRegexSource + ')\\b', 'g');

  const keys = new Set<string>();
  for (const message of messages) {
    for (const match of message.matchAll(matcher)) {
      keys.add(match[0].toUpperCase());
    }
  }

  let result = [...keys];
  if (cfg.projectKeys.length > 0) {
    const allow = new Set(cfg.projectKeys);
    result = result.filter((key) => {
      const sep = key.lastIndexOf('-');
      return sep > 0 && allow.has(key.slice(0, sep));
    });
  }
  return result.sort();
}
