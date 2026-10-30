import { WEBNRG_BASE } from './client.js';
import type { WebnrgPage, WebnrgSummary } from './run.js';

/**
 * The webNRG section of an issue comment. URLs come from the issue and error
 * text from a third party, so both go into code spans that cannot break the
 * table, ping anyone or inject markdown.
 */

const code = (t: string, max = 120) => {
  const flat = t.replace(/[\r\n]+/g, ' ').replace(/`/g, "'").replace(/\|/g, '\\|');
  return '`' + (flat.length > max ? flat.slice(0, max - 1) + '…' : flat) + '`';
};
const num = (v: number | undefined, digits: number, unit: string) => (v === undefined ? '—' : `${v.toFixed(digits)} ${unit}`);
const day = (iso: string | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '');

function row(p: WebnrgPage): string {
  const links = [`[webNRG](${p.detailsUrl})`, ...(p.statsUrl ? [`[run](${p.statsUrl})`] : [])].join(' · ');
  const m = p.metrics;
  if ((p.status === 'reused' || p.status === 'measured') && m) {
    const when = p.status === 'reused' ? `${day(p.measuredAt)} (reused)` : day(p.measuredAt) || 'this scan';
    const grades = [m.renderingGrade ? `rendering ${m.renderingGrade}` : '', m.transferGrade ? `transfer ${m.transferGrade}` : '']
      .filter(Boolean)
      .join(', ');
    return `| ${code(p.page)} | ${num(m.cpuEnergyMwh, 2, 'mWh')} | ${num(m.cpuPowerW, 2, 'W')} | ${num(m.transferKb, 0, 'kB')} | ${grades || '—'} | ${when} | ${links} |`;
  }
  const what =
    p.status === 'submitted'
      ? `_requested${p.jobId !== undefined ? ` (job ${p.jobId})` : ''}; results to follow_`
      : p.status === 'not-requested'
        ? '_no webNRG result in the last 30 days_'
        : `_failed: ${code(p.error ?? 'unknown error', 160)}_`;
  return `| ${code(p.page)} | ${what} | | | | | ${links} |`;
}

export function webnrgMarkdown(summary: WebnrgSummary, opts: { followUp?: boolean; title?: string } = {}): string {
  if (summary.pages.length === 0) return '';
  const pending = summary.pages.some((p) => p.status === 'submitted');
  const lines = [
    opts.title ?? '**Lab check: webNRG**',
    '',
    '| Page | Rendering energy | CPU power | Transfer | webNRG grades | Measured | Links |',
    '| --- | ---: | ---: | ---: | --- | --- | --- |',
    ...summary.pages.map(row),
    '',
    `Lab figures from [webNRG](${WEBNRG_BASE}/) on Green Coding's Green Metrics Tool cluster: Firefox on a ` +
      'dedicated machine, CPU package energy for the page load plus 5 s idle, through a warm cache' +
      (summary.machine ? ` (${code(summary.machine, 80)})` : '') +
      ". They are shown beside this scan's figures, never added to them or divided by them. " +
      'Every webNRG result is public.',
  ];
  if (pending) {
    lines.push(
      opts.followUp
        ? 'Requested measurements usually take 5–30 minutes; a follow-up comment will add them here.'
        : 'Requested measurements usually take 5–30 minutes; follow the webNRG links for the results.',
    );
  }
  return lines.join('\n');
}
