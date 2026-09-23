'use strict';

/**
 * Plot evaluation results as plain SVG.
 *
 * SVG is written directly rather than through a plotting library: it adds no
 * dependency to a repository that must run from a clean checkout, the output is
 * deterministic so a regenerated figure produces an empty diff, and the file is
 * readable text rather than a binary an editor cannot show.
 *
 * Figures are theme-neutral (explicit colours, no reliance on a page
 * background) because they end up in a paper, a report and a browser.
 */

const PALETTE = Object.freeze({
  allow: '#2f7d4f',
  deny: '#b03a2e',
  invalid: '#8a8a8a',
  grid: '#d8d8d8',
  axis: '#444444',
  text: '#222222',
  series: ['#2c5f8a', '#b8752a', '#4a7c59', '#7d4f8a', '#8a2f4f'],
});

const escape = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const round = (n) => Math.round(n * 100) / 100;

function frame({ width, height, margin, title, children }) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${margin.left}" y="24" font-size="15" font-weight="600" fill="${PALETTE.text}">${escape(title)}</text>`,
    ...children,
    '</svg>',
  ].join('\n');
}

/**
 * Grouped bars: one group per set, one bar per model.
 * `value` reads the metric; `max` fixes the scale so figures are comparable.
 */
function groupedBars({ title, groups, series, value, yLabel, max = 1, width = 820, height = 400 }) {
  const margin = { top: 50, right: 170, bottom: 82, left: 60 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const groupWidth = plotWidth / groups.length;
  const barWidth = Math.min(38, (groupWidth - 14) / series.length);
  const y = (v) => margin.top + plotHeight - (Math.max(0, Math.min(max, v)) / max) * plotHeight;
  const children = [];

  for (let t = 0; t <= 5; t += 1) {
    const v = (max / 5) * t;
    const yy = y(v);
    children.push(`<line x1="${margin.left}" y1="${round(yy)}" x2="${margin.left + plotWidth}" y2="${round(yy)}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
    children.push(`<text x="${margin.left - 8}" y="${round(yy + 4)}" font-size="11" text-anchor="end" fill="${PALETTE.axis}">${round(v)}</text>`);
  }
  children.push(`<text x="14" y="${margin.top + plotHeight / 2}" font-size="12" fill="${PALETTE.axis}" transform="rotate(-90 14 ${margin.top + plotHeight / 2})" text-anchor="middle">${escape(yLabel)}</text>`);

  groups.forEach((group, gi) => {
    const groupX = margin.left + gi * groupWidth;
    series.forEach((entry, si) => {
      const v = value(entry, group);
      if (v === null || v === undefined) return;
      const x = groupX + (groupWidth - series.length * barWidth) / 2 + si * barWidth;
      const top = y(v);
      const colour = entry.colour || PALETTE.series[si % PALETTE.series.length];
      children.push(`<rect x="${round(x)}" y="${round(top)}" width="${round(barWidth - 3)}" height="${round(margin.top + plotHeight - top)}" fill="${colour}"/>`);
      children.push(`<text x="${round(x + (barWidth - 3) / 2)}" y="${round(top - 4)}" font-size="9" text-anchor="middle" fill="${PALETTE.axis}">${round(v)}</text>`);
    });
    // Set labels are long; wrap them onto two lines rather than truncating.
    const [head, ...tail] = String(group).split('-');
    children.push(`<text x="${round(groupX + groupWidth / 2)}" y="${margin.top + plotHeight + 16}" font-size="10" text-anchor="middle" fill="${PALETTE.axis}">${escape(head)}</text>`);
    if (tail.length) {
      children.push(`<text x="${round(groupX + groupWidth / 2)}" y="${margin.top + plotHeight + 29}" font-size="10" text-anchor="middle" fill="${PALETTE.axis}">${escape(tail.join('-'))}</text>`);
    }
  });

  series.forEach((entry, si) => {
    const yy = margin.top + si * 20;
    const colour = entry.colour || PALETTE.series[si % PALETTE.series.length];
    children.push(`<rect x="${width - margin.right + 14}" y="${yy}" width="12" height="12" fill="${colour}"/>`);
    children.push(`<text x="${width - margin.right + 32}" y="${yy + 11}" font-size="11" fill="${PALETTE.text}">${escape(entry.label)}</text>`);
  });
  children.push(`<line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="${PALETTE.axis}" stroke-width="1"/>`);
  return frame({ width, height, margin, title, children });
}

/** A latency distribution as median / p95 / p99 bars per model. */
function latencyChart({ title, series, width = 560, height = 340 }) {
  const points = [['median', 'median'], ['p95', 'p95'], ['p99', 'p99']];
  const max = Math.max(1, ...series.flatMap((s) => points.map(([, k]) => s.latency[k] || 0))) * 1.15;
  return groupedBars({
    title,
    groups: points.map(([label]) => label),
    series,
    value: (entry, group) => entry.latency[group],
    yLabel: 'milliseconds',
    max,
    width,
    height,
  });
}

/** Confusion as a 2x2 heat grid, with the unsafe cell called out. */
function confusionGrid({ title, matrix, invalid, width = 420, height = 300 }) {
  const cells = [
    ['true ALLOW', 'pred ALLOW', matrix.ALLOW.ALLOW, PALETTE.allow],
    ['true ALLOW', 'pred DENY', matrix.ALLOW.DENY, PALETTE.invalid],
    ['true DENY', 'pred ALLOW', matrix.DENY.ALLOW, PALETTE.deny],
    ['true DENY', 'pred DENY', matrix.DENY.DENY, PALETTE.allow],
  ];
  const total = Math.max(1, cells.reduce((n, c) => n + c[2], 0));
  const children = [];
  const x0 = 130;
  const y0 = 70;
  const size = 110;
  cells.forEach(([row, col, count, colour], i) => {
    const cx = x0 + (i % 2) * size;
    const cy = y0 + Math.floor(i / 2) * size;
    const intensity = 0.15 + 0.75 * (count / total);
    children.push(`<rect x="${cx}" y="${cy}" width="${size - 4}" height="${size - 4}" fill="${colour}" fill-opacity="${round(intensity)}"/>`);
    children.push(`<text x="${cx + (size - 4) / 2}" y="${cy + size / 2}" font-size="20" font-weight="600" text-anchor="middle" fill="${PALETTE.text}">${count}</text>`);
    if (row === 'true DENY' && col === 'pred ALLOW' && count > 0) {
      children.push(`<text x="${cx + (size - 4) / 2}" y="${cy + size / 2 + 18}" font-size="9" text-anchor="middle" fill="${PALETTE.deny}">false ALLOW</text>`);
    }
  });
  children.push(`<text x="${x0 + size / 2}" y="${y0 - 10}" font-size="11" text-anchor="middle" fill="${PALETTE.axis}">predicted ALLOW</text>`);
  children.push(`<text x="${x0 + size + size / 2}" y="${y0 - 10}" font-size="11" text-anchor="middle" fill="${PALETTE.axis}">predicted DENY</text>`);
  children.push(`<text x="${x0 - 10}" y="${y0 + size / 2}" font-size="11" text-anchor="end" fill="${PALETTE.axis}">true ALLOW</text>`);
  children.push(`<text x="${x0 - 10}" y="${y0 + size + size / 2}" font-size="11" text-anchor="end" fill="${PALETTE.axis}">true DENY</text>`);
  children.push(`<text x="20" y="${y0 + 2 * size + 26}" font-size="11" fill="${PALETTE.axis}">${invalid} response(s) were not schema-valid and are excluded from this matrix.</text>`);
  return frame({ width, height, margin: { left: 20 }, title, children });
}

/** Validation loss against training progress, for checkpoint selection. */
function lossCurve({ title, points, width = 640, height = 340 }) {
  const margin = { top: 50, right: 30, bottom: 60, left: 62 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxIter = Math.max(...points.map((p) => p.iteration), 1);
  const maxLoss = Math.max(...points.map((p) => p.loss)) * 1.1;
  const x = (i) => margin.left + (i / maxIter) * plotWidth;
  const y = (l) => margin.top + plotHeight - (l / maxLoss) * plotHeight;
  const children = [];
  for (let t = 0; t <= 4; t += 1) {
    const v = (maxLoss / 4) * t;
    children.push(`<line x1="${margin.left}" y1="${round(y(v))}" x2="${margin.left + plotWidth}" y2="${round(y(v))}" stroke="${PALETTE.grid}"/>`);
    children.push(`<text x="${margin.left - 8}" y="${round(y(v) + 4)}" font-size="11" text-anchor="end" fill="${PALETTE.axis}">${round(v)}</text>`);
  }
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(x(p.iteration))} ${round(y(p.loss))}`).join(' ');
  children.push(`<path d="${path}" fill="none" stroke="${PALETTE.series[0]}" stroke-width="2"/>`);
  for (const p of points) {
    children.push(`<circle cx="${round(x(p.iteration))}" cy="${round(y(p.loss))}" r="3.5" fill="${PALETTE.series[0]}"/>`);
    children.push(`<text x="${round(x(p.iteration))}" y="${round(y(p.loss) - 9)}" font-size="9" text-anchor="middle" fill="${PALETTE.axis}">${round(p.loss)}</text>`);
  }
  const best = points.reduce((a, b) => (b.loss < a.loss ? b : a), points[0]);
  children.push(`<circle cx="${round(x(best.iteration))}" cy="${round(y(best.loss))}" r="6" fill="none" stroke="${PALETTE.deny}" stroke-width="2"/>`);
  children.push(`<text x="${round(x(best.iteration))}" y="${margin.top + plotHeight + 34}" font-size="10" text-anchor="middle" fill="${PALETTE.deny}">best</text>`);
  children.push(`<line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="${PALETTE.axis}"/>`);
  children.push(`<text x="${margin.left + plotWidth / 2}" y="${height - 16}" font-size="12" text-anchor="middle" fill="${PALETTE.axis}">training iteration (micro-batches)</text>`);
  children.push(`<text x="16" y="${margin.top + plotHeight / 2}" font-size="12" fill="${PALETTE.axis}" transform="rotate(-90 16 ${margin.top + plotHeight / 2})" text-anchor="middle">validation loss</text>`);
  return frame({ width, height, margin, title, children });
}

module.exports = { PALETTE, confusionGrid, groupedBars, latencyChart, lossCurve };
