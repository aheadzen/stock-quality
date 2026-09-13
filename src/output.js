import chalk from 'chalk';

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function fmtScore(score, hasError) {
  if (hasError) return chalk.gray('ERR');
  if (score === 1) return chalk.green('1');
  if (score === 0) return chalk.red('0');
  return chalk.gray('-');
}

function fmtReasoningCell(reasoning, error) {
  if (error) return chalk.gray(truncate(error, 80));
  return truncate(reasoning || '-', 80);
}

function fmtPct(pct) {
  if (pct >= 70) return chalk.green(`${pct.toFixed(1)}%`);
  if (pct >= 40) return chalk.yellow(`${pct.toFixed(1)}%`);
  return chalk.red(`${pct.toFixed(1)}%`);
}

function pad(s, w, align = 'left') {
  const str = String(s);
  const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length >= w) return str;
  const space = ' '.repeat(w - visible.length);
  return align === 'right' ? space + str : str + space;
}

function kindBadge(kind) {
  switch (kind) {
    case 'ipo': return chalk.bgYellow.black.bold(' IPO ');
    case 'unlisted': return chalk.bgGray.white.bold(' UNLISTED ');
    case 'crypto': return chalk.bgMagenta.white.bold(' CRYPTO ');
    case 'listed':
    default: return chalk.bgGreen.white.bold(' LISTED ');
  }
}

function fmtPriceLine(company) {
  if (company.kind === 'unlisted') {
    return chalk.bold('Price:   ') + chalk.gray('Private / unlisted');
  }
  if (typeof company.price !== 'number' || !company.currency) {
    return chalk.bold('Price:   ') + chalk.gray('n/a');
  }
  return chalk.bold('Price:   ') + `${company.price.toLocaleString()} ${company.currency}`;
}

// Compact one-line summary suitable for the default CLI output. Per-question
// detail is hidden — use --verbose (printVerbose) for the table.
export function printSummary(company, results, { source = 'fresh' } = {}) {
  const scored = results.filter((r) => !r.error);
  const sum = scored.reduce((acc, r) => acc + (r.score === 1 ? 1 : 0), 0);
  const total = scored.length;
  const pct = total > 0 ? (sum / total) * 100 : 0;

  const tickerLabel = company.ticker ? ` (${company.ticker})` : '';
  console.log();
  console.log(chalk.bold(`Company: ${company.name}${tickerLabel}`), kindBadge(company.kind || 'listed'));
  if (company.profile) {
    console.log(chalk.gray(truncate(company.profile, 110)));
  }
  console.log(fmtPriceLine(company));
  console.log();

  const scoreColor = pct >= 70 ? chalk.green : pct >= 40 ? chalk.yellow : chalk.red;
  const dateStr = new Date().toISOString().slice(0, 10);
  const sourceTag = source === 'cache' ? chalk.cyan(`cached ${dateStr}`) : chalk.gray(`evaluated ${dateStr}`);
  console.log(
    chalk.bold('Score:   ') +
      scoreColor(`${sum} / ${total}`) +
      chalk.gray(`  (${pct.toFixed(1)}%)  `) +
      sourceTag
  );

  if (results.length - total > 0) {
    console.log(
      chalk.gray(
        `(${results.length - total} question${results.length - total === 1 ? '' : 's'} excluded from total due to errors)`
      )
    );
  }
  console.log();
}

// Verbose table view — kept for CLI users who explicitly ask for it.
export function printVerbose(company, results) {
  console.log();
  const tickerLabel = company.ticker ? ` (${company.ticker})` : '';
  console.log(chalk.bold(`Company: ${company.name}${tickerLabel}`), kindBadge(company.kind || 'listed'));
  if (company.profile) {
    console.log(chalk.gray(truncate(company.profile, 110)));
  }
  console.log(fmtPriceLine(company));
  if (company.exchange) {
    console.log(chalk.bold('Exchange:') + ` ${company.exchange}`);
  }
  if (company.notes) {
    console.log(chalk.gray(truncate(company.notes, 90)));
  }
  console.log();

  const idxW = 4;
  const questionW = 48;
  const scoreW = 7;
  const reasoningW = 80;

  const header =
    pad('#', idxW) +
    ' ' +
    pad('Question', questionW) +
    ' ' +
    pad('Score', scoreW, 'right') +
    ' ' +
    'Reasoning';

  console.log(chalk.bold(header));
  console.log(chalk.gray('-'.repeat(header.replace(/\x1b\[[0-9;]*m/g, '').length)));

  results.forEach((r, i) => {
    const scoreCell = fmtScore(r.score, Boolean(r.error));
    const reasonCell = fmtReasoningCell(r.reasoning, r.error);
    const line =
      pad(i + 1, idxW, 'right') +
      ' ' +
      pad(truncate(r.question, questionW), questionW) +
      ' ' +
      pad(scoreCell, scoreW, 'right') +
      ' ' +
      reasonCell;
    console.log(line);
  });

  console.log();

  const scored = results.filter((r) => !r.error);
  const total = scored.length;
  const sum = scored.reduce((acc, r) => acc + (r.score === 1 ? 1 : 0), 0);
  const pct = total > 0 ? (sum / total) * 100 : 0;

  console.log(
    chalk.bold(
      `Total: ${chalk.cyan(`${sum} / ${total}`)} (${fmtPct(pct)})`
    )
  );
  if (results.length - total > 0) {
    console.log(
      chalk.gray(
        `(${results.length - total} question${results.length - total === 1 ? '' : 's'} excluded from total due to errors)`
      )
    );
  }
  console.log();
}