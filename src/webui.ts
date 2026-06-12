/**
 * Shared building blocks for the public HTML pages (homepage and /status):
 * HTML escaping, the common stylesheet, and the page shell (brand header
 * band, section-nav chips, footer). Pages stay self-contained — no client
 * JS, no external resources (fonts/CDNs/images) — so they render identically
 * on locked-down enterprise networks and under strict CSPs.
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

/** Inline padlock mark. Deliberately no xmlns attribute: HTML5 inline SVG
 * does not need it, and the homepage must contain no http(s) URLs at all. */
export const LOCK_MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3h-.5A2.5 2.5 0 0 0 4 12.5v7A2.5 2.5 0 0 0 6.5 22h11a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 17.5 10H17V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Zm3 4a1.9 1.9 0 0 1 1 3.52V19a1 1 0 1 1-2 0v-1.48A1.9 1.9 0 0 1 12 14Z"/></svg>`;

/** Indigo-branded design system: header band + chips + cards + badges.
 * Light/dark via prefers-color-scheme; reduced motion respected. */
export const SHARED_CSS = `
  :root {
    color-scheme: light dark;
    --bg: #f3f4f7;
    --surface: #ffffff;
    --surface-2: #f8f9fb;
    --text: #1b2230;
    --muted: #5b6573;
    --border: #dde1e8;
    --accent: #4f46e5;
    --ok: #15803d; --ok-bg: #e6f6ec; --ok-border: #b3e2c3;
    --bad: #bf2438; --bad-bg: #fdecef; --bad-border: #f5c5cd;
    --chip: rgba(100, 110, 135, 0.14);
    --shadow: 0 1px 2px rgba(22, 26, 45, 0.06);
    --band-text: #f1f2ff;
    --band-muted: #b6bce6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0e15;
      --surface: #141927;
      --surface-2: #1a2030;
      --text: #e6e9f1;
      --muted: #8e96a8;
      --border: #283044;
      --accent: #8d95f9;
      --ok: #4ade80; --ok-bg: rgba(74, 222, 128, 0.12); --ok-border: rgba(74, 222, 128, 0.35);
      --bad: #f87171; --bad-bg: rgba(248, 113, 113, 0.12); --bad-border: rgba(248, 113, 113, 0.35);
      --chip: rgba(125, 135, 165, 0.22);
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
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
  p { margin: 0.5rem 0; }
  ul, ol { padding-left: 1.4rem; margin: 0.5rem 0; }
  li { margin: 0.35rem 0; }

  /* ── Brand header band ─────────────────────────────────────────────── */
  .band {
    background: linear-gradient(130deg, #16142e 0%, #232058 55%, #3d3190 100%);
    color: var(--band-text);
    padding: 1.5rem 1.25rem 2.1rem;
  }
  .band-inner {
    max-width: 64rem; margin: 0 auto;
    display: flex; align-items: flex-end; gap: 1.5rem; flex-wrap: wrap;
  }
  .band-main { flex: 1 1 24rem; }
  .brand { display: flex; align-items: center; gap: 0.45rem; color: var(--band-muted); }
  .brand .mark { width: 1.05rem; height: 1.05rem; color: #a5b4fc; }
  .wordmark {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-weight: 600; font-size: 0.92rem; letter-spacing: 0.03em;
  }
  .band h1 { margin: 0.4rem 0 0.25rem; font-size: 1.65rem; line-height: 1.22; letter-spacing: -0.015em; color: #ffffff; }
  .band .tagline { margin: 0; color: var(--band-muted); font-size: 0.95rem; max-width: 46rem; }
  .band .tagline code { background: rgba(255, 255, 255, 0.13); color: #e4e7ff; }
  .band .tagline strong { color: #fff; }
  .band-aside { display: flex; flex-direction: column; align-items: flex-end; gap: 0.6rem; margin-left: auto; }
  .band .badge.ok { background: #34d27b; border-color: transparent; color: #07230f; }
  .band .badge.bad { background: #fb7185; border-color: transparent; color: #36060f; }
  .band .badge.neutral { background: rgba(255, 255, 255, 0.16); color: var(--band-text); }
  .cta {
    display: inline-block; text-decoration: none; font-weight: 600; font-size: 0.88rem;
    color: #ffffff; background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.28);
    padding: 0.42rem 1rem; border-radius: 10px;
  }
  .cta:hover { background: rgba(255, 255, 255, 0.2); }
  .live { display: inline-flex; align-items: center; gap: 0.45rem; color: var(--band-muted); font-size: 0.8rem; }
  .live-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #4ade80; }
  @keyframes live-pulse {
    0% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.55); }
    70% { box-shadow: 0 0 0 0.45rem rgba(74, 222, 128, 0); }
    100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); }
  }
  .live-dot { animation: live-pulse 2.4s ease-out infinite; }
  @media (prefers-reduced-motion: reduce) { .live-dot { animation: none; } }

  /* ── Section-nav chips (float on the band's bottom edge) ───────────── */
  .chips {
    max-width: 64rem; margin: -1.15rem auto 0; padding: 0 1.25rem;
    display: flex; gap: 0.5rem; flex-wrap: wrap; position: relative;
  }
  .chips a {
    background: var(--surface); border: 1px solid var(--border); color: var(--muted);
    text-decoration: none; font-size: 0.8rem; font-weight: 600;
    padding: 0.28rem 0.8rem; border-radius: 999px; box-shadow: var(--shadow);
    white-space: nowrap;
  }
  .chips a:hover { color: var(--accent); border-color: var(--accent); }

  /* ── Content ───────────────────────────────────────────────────────── */
  .container { max-width: 64rem; margin: 0 auto; padding: 1.5rem 1.25rem 2.5rem; }
  section.card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 1.15rem 1.4rem 1.3rem;
    margin: 1rem 0;
    box-shadow: var(--shadow);
    scroll-margin-top: 1rem;
  }
  section.card > h2 {
    font-size: 1.05rem; margin: 0 0 0.75rem; padding-bottom: 0.55rem;
    border-bottom: 1px solid var(--border);
  }
  .card-head {
    display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.55rem; margin-bottom: 0.9rem;
  }
  .card-head h2 {
    font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--muted); margin: 0;
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
  .badge.overall { font-size: 0.95rem; padding: 0.28em 0.95em; }

  /* ── Footer ────────────────────────────────────────────────────────── */
  .foot { border-top: 1px solid var(--border); margin-top: 2rem; background: var(--surface-2); }
  .foot-inner {
    max-width: 64rem; margin: 0 auto; padding: 1.15rem 1.25rem 2rem;
    color: var(--muted); font-size: 0.85rem;
  }
  .foot nav { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
  .foot nav a { color: var(--muted); }
  .foot nav a:hover { color: var(--accent); }
`;

export interface PageNavItem {
  href: string;
  label: string;
}

/** Common page shell: brand band, optional nav chips, content, footer.
 * All string inputs are trusted HTML composed by the caller — dynamic data
 * must be escaped before it reaches here. */
export function renderPage(opts: {
  title: string;
  heading: string;
  tagline: string;
  headerAside?: string;
  nav?: PageNavItem[];
  extraHead?: string;
  extraCss?: string;
  body: string;
  footerExtra?: string;
}): string {
  const chips =
    opts.nav && opts.nav.length > 0
      ? `<nav class="chips">${opts.nav
          .map((n) => `<a href="${escapeHtml(n.href)}">${escapeHtml(n.label)}</a>`)
          .join('')}</nav>`
      : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.extraHead ?? ''}<title>${escapeHtml(opts.title)}</title>
<style>${SHARED_CSS}${opts.extraCss ?? ''}</style>
</head>
<body>
<header class="band">
<div class="band-inner">
<div class="band-main">
<div class="brand">${LOCK_MARK}<span class="wordmark">${APP_NAME}</span></div>
<h1>${opts.heading}</h1>
<p class="tagline">${opts.tagline}</p>
</div>
${opts.headerAside ? `<div class="band-aside">${opts.headerAside}</div>` : ''}
</div>
</header>
${chips}
<main class="container">
${opts.body}
</main>
<footer class="foot">
<div class="foot-inner">
<nav>
<a href="/">Guidelines</a>
<a href="/status">Status</a>
<a href="/status.json">Status JSON</a>
<a href="/healthz">healthz</a>
<a href="/readyz">readyz</a>
</nav>
${opts.footerExtra ?? ''}
<p>Served by ${APP_NAME} — self-contained page: no scripts, no external resources.</p>
</div>
</footer>
</body>
</html>
`;
}
