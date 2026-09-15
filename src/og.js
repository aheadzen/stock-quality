// Open Graph image generation. Renders a 1200x630 PNG per ticker using
// sharp (SVG markup -> PNG). Cached on disk at data/og-images/<TICKER>.png
// so subsequent crawls are a plain file read. Also generates a generic
// "default" image used as the og:image for the dashboard and for stock
// pages that haven't been evaluated yet.
//
// API:
//   getOrGenerateOgPng(ticker, { company, score, total, evaluatedAt })
//     -> { filePath, png } — returns cached if present, else generates.
//   refreshOgImage(ticker, opts)
//     -> always regenerates and overwrites. Called by the queue after
//        saveFactors to keep the image in sync with the latest evaluation.
//   getOrGenerateDefaultOgPng()
//     -> { filePath, png } — generic branded card. Long-lived cache.
//
// The disk path under data/ is already covered by .gitignore (data/),
// so generated PNGs don't leak into the repo.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const OG_DIR = path.resolve('./data/og-images');
const DEFAULT_FILE = '_default.png';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

function ensureOgDir() {
  if (!fs.existsSync(OG_DIR)) fs.mkdirSync(OG_DIR, { recursive: true });
  return OG_DIR;
}

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Score band → badge color. Matches the SPA's pctClass thresholds.
function scoreColor(score, total) {
  if (!total || score == null) return '#6b7280'; // gray for un-evaluated
  const pct = (score / total) * 100;
  if (pct >= 70) return '#16a34a';
  if (pct >= 40) return '#ca8a04';
  return '#dc2626';
}

// Kind → badge color. Matches the .kind-badge-* palette in the SPA.
function kindColor(kind) {
  if (kind === 'crypto') return '#a21caf';
  if (kind === 'ipo') return '#ca8a04';
  if (kind === 'unlisted') return '#9ca3af';
  return '#16a34a'; // listed
}

function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function tickerFilePath(ticker) {
  return path.join(ensureOgDir(), `${ticker}.png`);
}

function defaultFilePath() {
  return path.join(ensureOgDir(), DEFAULT_FILE);
}

function buildTickerSvg({
  ticker,
  company,
  score,
  total,
  evaluatedAt,
}) {
  const name = company?.name ?? '';
  const kind = company?.kind ?? null;
  const country = company?.country ?? null;
  const tickerSafe = escapeXml(ticker);
  const nameSafe = escapeXml(name || ticker);
  const kindSafe = escapeXml((kind || 'listed').toUpperCase());
  const kBg = kindColor(kind);
  const badgeColor = scoreColor(score, total);
  const scoreText = (typeof score === 'number') ? String(score) : '—';
  const totalText = (typeof total === 'number') ? String(total) : '?';
  const countryBlock =
    country && kind !== 'crypto'
      ? `<g transform="translate(160, 0)">
           <rect width="80" height="40" rx="6" fill="#f1f5f9" stroke="#cbd5e1" />
           <text x="40" y="28" font-size="18" font-weight="600"
                 font-family="monospace" fill="#0f172a" text-anchor="middle">${escapeXml(country)}</text>
         </g>`
      : '';
  const dateLine = formatDate(evaluatedAt);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="#0f172a" />
  <rect width="${OG_WIDTH}" height="6" fill="#2563eb" />

  <g transform="translate(60, 60)">
    <rect width="60" height="60" rx="12" fill="#2563eb" />
    <text x="30" y="42" font-size="32" font-weight="700" font-family="sans-serif" fill="white" text-anchor="middle">IQ</text>
    <text x="80" y="42" font-size="24" font-weight="600" font-family="sans-serif" fill="white">Investment Quality</text>
  </g>

  <text x="60" y="290" font-size="120" font-weight="800" font-family="monospace" fill="white">${tickerSafe}</text>
  <text x="60" y="355" font-size="36" font-weight="500" font-family="sans-serif" fill="#cbd5e1">${nameSafe}</text>

  <g transform="translate(60, 390)">
    <rect width="140" height="40" rx="6" fill="${kBg}" />
    <text x="70" y="28" font-size="18" font-weight="700" font-family="sans-serif" fill="white" text-anchor="middle">${kindSafe}</text>
    ${countryBlock}
  </g>

  <g transform="translate(780, 200)">
    <rect width="340" height="240" rx="16" fill="${badgeColor}" />
    <text x="170" y="140" font-size="72" font-weight="700" font-family="sans-serif" fill="white" text-anchor="middle">${escapeXml(scoreText)}</text>
    <text x="170" y="190" font-size="32" font-weight="500" font-family="sans-serif" fill="white" text-anchor="middle" opacity="0.85">/ ${escapeXml(totalText)}</text>
    <text x="170" y="225" font-size="16" font-weight="600" font-family="sans-serif" fill="white" text-anchor="middle" opacity="0.9" letter-spacing="2">QUALITY SCORE</text>
  </g>

  <text x="60" y="585" font-size="18" font-family="sans-serif" fill="#94a3b8">${escapeXml(dateLine ? `Evaluated ${dateLine}` : '')}</text>
  <text x="1140" y="585" font-size="22" font-weight="600" font-family="sans-serif" fill="white" text-anchor="end">ifintok.com</text>
</svg>`;
}

function buildDefaultSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="#0f172a" />
  <rect width="${OG_WIDTH}" height="6" fill="#2563eb" />

  <g transform="translate(60, 60)">
    <rect width="60" height="60" rx="12" fill="#2563eb" />
    <text x="30" y="42" font-size="32" font-weight="700" font-family="sans-serif" fill="white" text-anchor="middle">IQ</text>
    <text x="80" y="42" font-size="24" font-weight="600" font-family="sans-serif" fill="white">Investment Quality</text>
  </g>

  <text x="60" y="290" font-size="64" font-weight="700" font-family="sans-serif" fill="white">Stock &amp; Crypto</text>
  <text x="60" y="365" font-size="64" font-weight="700" font-family="sans-serif" fill="white">Evaluation Dashboard</text>

  <text x="60" y="455" font-size="26" font-weight="500" font-family="sans-serif" fill="#cbd5e1">25-point business quality checklist.</text>
  <text x="60" y="495" font-size="26" font-weight="500" font-family="sans-serif" fill="#cbd5e1">Public scores. No signup required.</text>

  <text x="60" y="585" font-size="18" font-family="sans-serif" fill="#94a3b8">No signup required · Browse publicly</text>
  <text x="1140" y="585" font-size="22" font-weight="600" font-family="sans-serif" fill="white" text-anchor="end">ifintok.com</text>
</svg>`;
}

async function renderPng(svg) {
  return sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
}

// Lazy: returns cached file if present, else generates and writes it.
// Suitable for the /og/:ticker.png HTTP handler — first crawler pays
// ~150ms, subsequent ones get a flat file read.
export async function getOrGenerateOgPng(ticker, opts = {}) {
  const filePath = tickerFilePath(ticker);
  try {
    const cached = fs.readFileSync(filePath);
    return { filePath, png: cached, cached: true };
  } catch {
    // miss — generate
  }
  const svg = buildTickerSvg({ ticker, ...opts });
  const png = await renderPng(svg);
  fs.writeFileSync(filePath, png);
  return { filePath, png, cached: false };
}

// Eager: always regenerates and overwrites. Called by the queue after
// saveFactors so the next share reflects the latest evaluation.
export async function refreshOgImage(ticker, opts = {}) {
  const filePath = tickerFilePath(ticker);
  const svg = buildTickerSvg({ ticker, ...opts });
  const png = await renderPng(svg);
  fs.writeFileSync(filePath, png);
  return { filePath, png };
}

export async function getOrGenerateDefaultOgPng() {
  const filePath = defaultFilePath();
  try {
    const cached = fs.readFileSync(filePath);
    return { filePath, png: cached, cached: true };
  } catch {
    // miss
  }
  const png = await renderPng(buildDefaultSvg());
  fs.writeFileSync(filePath, png);
  return { filePath, png, cached: false };
}