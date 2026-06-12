/**
 * Shared building blocks for the public HTML pages (homepage and /status):
 * HTML escaping and the common stylesheet. Pages stay self-contained — no
 * client JS, no external resources (fonts/CDNs/images) — so they render
 * identically on locked-down enterprise networks and under strict CSPs.
 */

/** Display name of the app on its public pages. Check names are configurable
 * (CHECK_NAME / COMMENT_CHECK_NAME); the app's own identity is not. */
export const APP_NAME = 'merge-lock';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Light/dark palette + base layout shared by every page. Tokens follow the
 * GitHub Primer hues so the pages feel native next to github.com/GHES. */
export const SHARED_CSS = `
  :root {
    color-scheme: light dark;
    --bg: #f6f8fa;
    --surface: #ffffff;
    --text: #1f2328;
    --muted: #59636e;
    --border: #d1d9e0;
    --accent: #0969da;
    --ok: #1a7f37; --ok-bg: #dafbe1; --ok-border: #aceebb;
    --bad: #cf222e; --bad-bg: #ffebe9; --bad-border: #ffcecb;
    --chip: rgba(110, 118, 129, 0.18);
    --shadow: 0 1px 2px rgba(31, 35, 40, 0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --surface: #151b23;
      --text: #e6edf3;
      --muted: #9198a1;
      --border: #2f353d;
      --accent: #4493f8;
      --ok: #3fb950; --ok-bg: rgba(46, 160, 67, 0.16); --ok-border: rgba(46, 160, 67, 0.4);
      --bad: #f85149; --bad-bg: rgba(248, 81, 73, 0.14); --bad-border: rgba(248, 81, 73, 0.4);
      --chip: rgba(110, 118, 129, 0.28);
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    max-width: 46rem;
    margin: 0 auto;
    padding: 2.5rem 1.25rem 4rem;
    line-height: 1.6;
  }
  a { color: var(--accent); }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.92em;
    background: var(--chip);
    padding: 0.1em 0.4em;
    border-radius: 6px;
  }
  h1 {
    font-size: 1.45rem;
    line-height: 1.3;
    letter-spacing: -0.01em;
    margin: 0 0 0.4rem;
  }
  h1 code { font-size: 0.95em; }
  .subtitle { color: var(--muted); margin: 0 0 1.5rem; }
  section.card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.1rem 1.4rem 1.25rem;
    margin: 0.9rem 0;
    box-shadow: var(--shadow);
  }
  section.card > h2 {
    font-size: 1.02rem;
    margin: 0 0 0.8rem;
    padding-bottom: 0.55rem;
    border-bottom: 1px solid var(--border);
  }
  .muted { color: var(--muted); font-size: 0.92em; }
  .badge {
    display: inline-block;
    padding: 0.1em 0.7em;
    border-radius: 999px;
    font-weight: 600;
    font-size: 0.85em;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .badge.ok { color: var(--ok); background: var(--ok-bg); border-color: var(--ok-border); }
  .badge.bad { color: var(--bad); background: var(--bad-bg); border-color: var(--bad-border); }
  .badge.neutral { color: var(--muted); background: var(--chip); }
  li { margin: 0.35rem 0; }
  ul, ol { padding-left: 1.4rem; margin: 0.5rem 0; }
  p { margin: 0.5rem 0; }
`;
