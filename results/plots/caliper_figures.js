'use strict';
/**
 * Generate paper-ready SVG figures from retained Hyperledger Caliper outputs.
 *
 * This script is deliberately strict: it only plots real retained measurement
 * artifacts (`caliper-summary.json` or an HTML report that contains the same
 * benchmark summary table). It does not invent values and exits non-zero if a
 * requested figure has no usable data yet.
 *
 * Figures produced:
 *   - read-performance.svg
 *   - write-performance.svg
 *   - increasing-load.svg
 *   - mixed-workload.svg
 *   - endurance.svg
 *
 * Output directory:
 *   results/plots/caliper-figures/
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSummaryTableHtml } = require('../../benchmarks/caliper/scripts/run-benchmark');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(REPO_ROOT, 'experiments', 'runs');
const OUTPUT_DIR = path.join(__dirname, 'caliper-figures');

const TESTS = [
  {
    key: 'read-performance',
    config: 'read-performance.yaml',
    title: 'Read Performance',
    subtitle: 'Single measurement round; top panel compares offered rate and achieved throughput.',
    fileName: 'caliper-read-performance.svg',
    kind: 'single',
  },
  {
    key: 'write-performance',
    config: 'write-performance.yaml',
    title: 'Write Performance',
    subtitle: 'Single measurement round; top panel compares offered rate and achieved throughput.',
    fileName: 'caliper-write-performance.svg',
    kind: 'single',
  },
  {
    key: 'increasing-load',
    config: 'increasing-load.yaml',
    title: 'Increasing Load',
    subtitle: 'Each point is a step in the offered-load sweep; the dashed line is the ideal y=x reference.',
    fileName: 'caliper-increasing-load.svg',
    kind: 'sweep',
  },
  {
    key: 'mixed-workload',
    config: 'mixed-workload.yaml',
    title: 'Mixed Workload',
    subtitle: 'Deterministic 70/30 read/write schedule; warm-up rows are excluded from the plot.',
    fileName: 'caliper-mixed-workload.svg',
    kind: 'single',
  },
  {
    key: 'endurance',
    config: 'endurance.yaml',
    title: 'Endurance',
    subtitle: 'Long-duration 70/30 schedule; summary plot stays faithful to the retained Caliper summary rows.',
    fileName: 'caliper-endurance.svg',
    kind: 'single',
  },
];

function rel(filePath) {
  return path.relative(REPO_ROOT, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDateTime(iso) {
  if (!iso) return 'unknown time';
  return iso.slice(5, 16).replace('T', ' ');
}

function shortRunLabel(manifest) {
  const suffix = manifest.runId ? manifest.runId.replace(/^.*_caliper_/, '') : 'run';
  return `${suffix} @ ${formatDateTime(manifest.startedAtUtc)}`;
}

function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / (10 ** exponent);
  let niceFraction = 1;
  if (fraction > 1 && fraction <= 2) niceFraction = 2;
  else if (fraction > 2 && fraction <= 5) niceFraction = 5;
  else if (fraction > 5) niceFraction = 10;
  return niceFraction * (10 ** exponent);
}

function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return 'n/a';
  return Number(value).toFixed(digits);
}

function fmtTps(value) {
  return fmt(value, 1);
}

function fmtMs(seconds) {
  if (!Number.isFinite(seconds)) return 'n/a';
  return `${fmt(seconds * 1000, 1)} ms`;
}

function inferPhase(manifest, row) {
  if (row.phase) return row.phase;
  if (row.label && /warmup/i.test(row.label)) return 'warmup';
  if (manifest && manifest.benchmarkConfig === 'smoke.yaml') return 'connectivity';
  return 'measurement';
}

function loadPerformanceRows(runDir, manifest) {
  let rows = null;
  const summaryName = manifest.performanceSummary || null;
  if (summaryName) {
    const summaryPath = path.join(runDir, summaryName);
    if (fs.existsSync(summaryPath)) {
      rows = readJson(summaryPath).rounds;
    }
  }

  if (!rows) {
    const reportName = manifest.report || 'caliper-report.html';
    const reportPath = path.join(runDir, reportName);
    if (fs.existsSync(reportPath)) {
      rows = parseSummaryTableHtml(fs.readFileSync(reportPath, 'utf8'));
    }
  }

  if (!rows) return null;

  return rows.map((row) => ({
    ...row,
    phase: inferPhase(manifest, row),
  }));
}

function loadRunsForTest(test) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.includes('_caliper_'))
    .map((entry) => path.join(RUNS_DIR, entry.name))
    .map((runDir) => {
      const manifestPath = path.join(runDir, 'run-manifest.json');
      if (!fs.existsSync(manifestPath)) return null;
      const manifest = readJson(manifestPath);
      if (manifest.status !== 'completed') return null;
      if (manifest.benchmarkConfig !== test.config) return null;
      const rows = loadPerformanceRows(runDir, manifest);
      if (!rows || rows.length === 0) return null;
      return {
        runDir,
        manifest,
        rows,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aTime = new Date(a.manifest.startedAtUtc || 0).getTime();
      const bTime = new Date(b.manifest.startedAtUtc || 0).getTime();
      return aTime - bTime;
    });
}

function measurementRows(run, test) {
  if (test.kind === 'sweep') {
    return run.rows.filter((row) => row.phase !== 'warmup');
  }
  return run.rows.filter((row) => row.phase === 'measurement');
}

function project(seriesCount, index, width) {
  if (seriesCount <= 1) return width / 2;
  return width * (index / (seriesCount - 1));
}

function buildSvgDocument(title, subtitle, body, width = 980, height = 720) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title>${escapeXml(title)}</title>
  <desc>${escapeXml(subtitle)}</desc>
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
  ${body}
</svg>
`;
}

function axisTicks(maxValue, tickCount = 5) {
  const ceiling = niceCeiling(maxValue);
  const step = niceCeiling(ceiling / tickCount);
  const ticks = [];
  for (let value = 0; value <= ceiling + step * 0.5; value += step) {
    ticks.push(Math.min(value, ceiling));
  }
  return { ceiling, ticks };
}

function panelFrame(x, y, w, h, title, subtitle) {
  return `
  <g transform="translate(${x},${y})">
    <rect x="0" y="0" width="${w}" height="${h}" rx="16" fill="#fbfcfe" stroke="#d7dee9"/>
    <text x="24" y="34" fill="#132238" font-family="Times New Roman, Times, serif" font-size="24" font-weight="700">${escapeXml(title)}</text>
    <text x="24" y="58" fill="#516174" font-family="Times New Roman, Times, serif" font-size="14">${escapeXml(subtitle)}</text>
  </g>`;
}

function axisLabel(x, y, text, opts = {}) {
  const anchor = opts.anchor || 'middle';
  const rotate = opts.rotate ? ` transform="rotate(${opts.rotate} ${x} ${y})"` : '';
  return `<text x="${x}" y="${y}" fill="${opts.fill || '#31465c'}" font-family="Times New Roman, Times, serif" font-size="${opts.size || 12}" text-anchor="${anchor}"${rotate}>${escapeXml(text)}</text>`;
}

function legendItem(x, y, label, color, dash = false) {
  return `
  <g transform="translate(${x},${y})">
    <rect x="0" y="6" width="14" height="14" rx="3" fill="${color}" ${dash ? 'stroke-dasharray="4 3"' : ''}/>
    <text x="22" y="18" fill="#31465c" font-family="Times New Roman, Times, serif" font-size="13">${escapeXml(label)}</text>
  </g>`;
}

function renderGroupedBars({ x, y, w, h, categories, series, unitLabel, maxValue, valueFormatter }) {
  const left = 64;
  const right = 24;
  const top = 36;
  const bottom = 62;
  const plotX = x + left;
  const plotY = y + top;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const { ceiling, ticks } = axisTicks(maxValue);
  const groupWidth = plotW / Math.max(categories.length, 1);
  const seriesGap = 6;
  const barWidth = Math.min(42, Math.max(10, (groupWidth - (series.length - 1) * seriesGap) / Math.max(series.length, 1) - 10));
  const totalBarWidth = barWidth * series.length + seriesGap * (series.length - 1);
  const scaleY = (value) => plotY + plotH - ((value / ceiling) * plotH);
  let out = '';

  for (const tick of ticks) {
    const yy = scaleY(tick);
    out += `<line x1="${plotX}" y1="${yy}" x2="${plotX + plotW}" y2="${yy}" stroke="#dfe5ef" stroke-width="1"/>`;
    out += axisLabel(plotX - 10, yy + 4, fmt(tick, tick >= 100 ? 0 : 1), { anchor: 'end', size: 12, fill: '#57697d' });
  }

  out += axisLabel(plotX + plotW / 2, y + h - 18, unitLabel, { size: 13, fill: '#516174' });

  categories.forEach((category, categoryIndex) => {
    const groupCenter = plotX + groupWidth * categoryIndex + groupWidth / 2;
    const startX = groupCenter - totalBarWidth / 2;
    series.forEach((entry, seriesIndex) => {
      const value = entry.values[categoryIndex];
      if (!Number.isFinite(value)) return;
      const barX = startX + seriesIndex * (barWidth + seriesGap);
      const barY = scaleY(value);
      const barHeight = plotY + plotH - barY;
      out += `<rect x="${barX.toFixed(2)}" y="${barY.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="6" fill="${entry.color}"/>`;
      if (barHeight > 16) {
        out += axisLabel(barX + barWidth / 2, barY - 6, valueFormatter(value), { size: 11, fill: '#31465c' });
      }
    });
    out += axisLabel(groupCenter, y + h - 30, category, { size: 12, fill: '#31465c' });
  });

  out += `<line x1="${plotX}" y1="${plotY + plotH}" x2="${plotX + plotW}" y2="${plotY + plotH}" stroke="#8fa0b5" stroke-width="1.2"/>`;
  out += `<line x1="${plotX}" y1="${plotY}" x2="${plotX}" y2="${plotY + plotH}" stroke="#8fa0b5" stroke-width="1.2"/>`;

  let legendX = plotX + plotW - 20;
  const legendY = y + 14;
  const legendItems = series.slice().reverse();
  legendItems.forEach((entry) => {
    const itemWidth = Math.max(92, entry.label.length * 7 + 34);
    legendX -= itemWidth;
    out += legendItem(legendX, legendY, entry.label, entry.color);
    legendX -= 10;
  });

  return out;
}

function renderLineChart({ x, y, w, h, series, unitLabel, yMax, xDomain, xFormatter, xLabelOffset = 0, showIdealLine = false }) {
  const left = 68;
  const right = 22;
  const top = 40;
  const bottom = 58;
  const plotX = x + left;
  const plotY = y + top;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const { ceiling, ticks } = axisTicks(yMax);
  const minX = xDomain[0];
  const maxX = xDomain[xDomain.length - 1];
  const xScale = (value) => {
    if (maxX === minX) return plotX + plotW / 2;
    return plotX + ((value - minX) / (maxX - minX)) * plotW;
  };
  const yScale = (value) => plotY + plotH - ((value / ceiling) * plotH);
  let out = '';

  for (const tick of ticks) {
    const yy = yScale(tick);
    out += `<line x1="${plotX}" y1="${yy}" x2="${plotX + plotW}" y2="${yy}" stroke="#dfe5ef" stroke-width="1"/>`;
    out += axisLabel(plotX - 10, yy + 4, fmt(tick, tick >= 100 ? 0 : 1), { anchor: 'end', size: 12, fill: '#57697d' });
  }

  const xTicks = xDomain;
  xTicks.forEach((value) => {
    const xx = xScale(value);
    out += `<line x1="${xx}" y1="${plotY}" x2="${xx}" y2="${plotY + plotH}" stroke="#eef2f7" stroke-width="1"/>`;
    out += axisLabel(xx, y + h - 28 + xLabelOffset, xFormatter(value), { size: 12, fill: '#31465c' });
  });

  out += axisLabel(plotX + plotW / 2, y + h - 14, unitLabel, { size: 13, fill: '#516174' });
  out += `<line x1="${plotX}" y1="${plotY + plotH}" x2="${plotX + plotW}" y2="${plotY + plotH}" stroke="#8fa0b5" stroke-width="1.2"/>`;
  out += `<line x1="${plotX}" y1="${plotY}" x2="${plotX}" y2="${plotY + plotH}" stroke="#8fa0b5" stroke-width="1.2"/>`;

  if (showIdealLine) {
    const idealStart = xDomain[0];
    const idealEnd = xDomain[xDomain.length - 1];
    out += `<line x1="${xScale(idealStart)}" y1="${yScale(idealStart)}" x2="${xScale(idealEnd)}" y2="${yScale(idealEnd)}" stroke="#9ca8b8" stroke-width="2.2" stroke-dasharray="8 6"/>`;
  }

  series.forEach((entry) => {
    const points = entry.points
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .sort((a, b) => a.x - b.x);
    if (points.length === 0) return;
    const d = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xScale(point.x).toFixed(2)} ${yScale(point.y).toFixed(2)}`).join(' ');
    out += `<path d="${d}" fill="none" stroke="${entry.color}" stroke-width="2.8"/>`;
    points.forEach((point) => {
      const xx = xScale(point.x);
      const yy = yScale(point.y);
      out += `<circle cx="${xx.toFixed(2)}" cy="${yy.toFixed(2)}" r="4.2" fill="${entry.color}" stroke="#ffffff" stroke-width="1.3"/>`;
      if (entry.showValues) {
        out += axisLabel(xx, yy - 9, entry.valueFormatter(point.y), { size: 11, fill: '#31465c' });
      }
    });
  });

  let legendX = plotX + plotW - 18;
  const legendY = y + 14;
  const legendEntries = [];
  if (showIdealLine) {
    legendEntries.push({ label: 'Ideal throughput', color: '#9ca8b8', dash: true });
  }
  series.forEach((entry) => {
    legendEntries.push({ label: entry.label, color: entry.color });
  });
  legendEntries.reverse().forEach((entry) => {
    const itemWidth = Math.max(108, entry.label.length * 7 + 34);
    legendX -= itemWidth;
    out += legendItem(legendX, legendY, entry.label, entry.color, Boolean(entry.dash));
    legendX -= 10;
  });

  return out;
}

function buildSingleRunFigure(test, runs) {
  const categories = runs.map((run) => shortRunLabel(run.manifest));
  const throughputSeries = [
    {
      label: 'Offered TPS',
      color: '#5B8FF9',
      values: runs.map((run) => measurementRows(run, test)[0].observedSendRateTps),
    },
    {
      label: 'Throughput TPS',
      color: '#61DDAA',
      values: runs.map((run) => measurementRows(run, test)[0].throughputTps),
    },
  ];
  const latencySeries = [
    {
      label: 'Min latency',
      color: '#8D8D8D',
      values: runs.map((run) => measurementRows(run, test)[0].latencyMinSeconds * 1000),
    },
    {
      label: 'Avg latency',
      color: '#F6BD16',
      values: runs.map((run) => measurementRows(run, test)[0].latencyAverageSeconds * 1000),
    },
    {
      label: 'Max latency',
      color: '#E8684A',
      values: runs.map((run) => measurementRows(run, test)[0].latencyMaxSeconds * 1000),
    },
  ];
  const throughputMax = Math.max(...throughputSeries.flatMap((series) => series.values), 1);
  const latencyMax = Math.max(...latencySeries.flatMap((series) => series.values), 1);

  const topPanel = renderGroupedBars({
    x: 26,
    y: 96,
    w: 928,
    h: 238,
    categories,
    series: throughputSeries,
    unitLabel: 'TPS',
    maxValue: throughputMax * 1.25,
    valueFormatter: fmtTps,
  });
  const bottomPanel = renderGroupedBars({
    x: 26,
    y: 378,
    w: 928,
    h: 238,
    categories,
    series: latencySeries,
    unitLabel: 'Latency (ms)',
    maxValue: latencyMax * 1.25,
    valueFormatter: (value) => `${fmt(value, 1)}`,
  });

  const runCount = runs.length;
  const summaryLine = `${runCount} retained run${runCount === 1 ? '' : 's'}; measurement rows only.`;
  const body = `
  ${panelFrame(20, 76, 940, 260, `${test.title} - Throughput`, `${summaryLine} Offered rate and achieved throughput are in TPS.`)}
  ${topPanel}
  ${panelFrame(20, 358, 940, 260, `${test.title} - Latency`, `${summaryLine} Latency is shown in milliseconds.`)}
  ${bottomPanel}
  <text x="34" y="688" fill="#6b778c" font-family="Times New Roman, Times, serif" font-size="13">
    Source artifacts: ${escapeXml(runs.map((run) => rel(run.runDir)).join(', '))}
  </text>`;

  return buildSvgDocument(test.title, test.subtitle, body);
}

function buildSweepFigure(test, runs) {
  const allRows = runs.flatMap((run) => measurementRows(run, test).map((row) => ({
    ...row,
    runLabel: shortRunLabel(run.manifest),
    runId: run.manifest.runId,
  })));
  const runLabels = [...new Set(allRows.map((row) => row.runLabel))];
  const stepValues = [...new Set(allRows.map((row) => row.observedSendRateTps))].sort((a, b) => a - b);
  const runGroups = runLabels.map((runLabel, index) => {
    const rows = allRows.filter((row) => row.runLabel === runLabel).sort((a, b) => a.observedSendRateTps - b.observedSendRateTps);
    const throughputPoints = rows.map((row) => ({ x: row.observedSendRateTps, y: row.throughputTps }));
    const latencyPoints = rows.map((row) => ({
      x: row.observedSendRateTps,
      min: row.latencyMinSeconds * 1000,
      avg: row.latencyAverageSeconds * 1000,
      max: row.latencyMaxSeconds * 1000,
    }));
    return {
      label: runLabel,
      color: ['#5B8FF9', '#61DDAA', '#F6BD16', '#E8684A', '#6F60D6'][index % 5],
      throughputPoints,
      latencyPoints,
    };
  });
  const throughputMax = Math.max(...allRows.flatMap((row) => [row.observedSendRateTps, row.throughputTps]), 1);
  const latencyMax = Math.max(...allRows.flatMap((row) => [
    row.latencyMinSeconds * 1000,
    row.latencyAverageSeconds * 1000,
    row.latencyMaxSeconds * 1000,
  ]), 1);

  const throughputSeries = runGroups.map((group) => ({
    label: group.label,
    color: group.color,
    points: group.throughputPoints,
    showValues: false,
    valueFormatter: fmtTps,
  }));
  const latencySeries = runGroups.flatMap((group) => ([
    {
      label: `${group.label} - min`,
      color: group.color,
      points: group.latencyPoints.map((point) => ({ x: point.x, y: point.min })),
      showValues: false,
      valueFormatter: (value) => fmt(value, 1),
    },
    {
      label: `${group.label} - avg`,
      color: group.color,
      points: group.latencyPoints.map((point) => ({ x: point.x, y: point.avg })),
      showValues: true,
      valueFormatter: (value) => fmt(value, 1),
    },
    {
      label: `${group.label} - max`,
      color: group.color,
      points: group.latencyPoints.map((point) => ({ x: point.x, y: point.max })),
      showValues: false,
      valueFormatter: (value) => fmt(value, 1),
    },
  ]));

  const body = `
  ${panelFrame(20, 76, 940, 260, `${test.title} - Throughput vs Offered Load`, `${runGroups.length} retained run${runGroups.length === 1 ? '' : 's'}; the dashed line is the ideal y=x reference.`)}
  ${renderLineChart({
    x: 26,
    y: 96,
    w: 928,
    h: 238,
    series: throughputSeries,
    unitLabel: 'Offered TPS',
    yMax: throughputMax * 1.15,
    xDomain: stepValues,
    xFormatter: fmtTps,
    showIdealLine: true,
  })}
  ${panelFrame(20, 358, 940, 260, `${test.title} - Latency vs Offered Load`, 'Latency is shown in milliseconds; values come from the retained Caliper summary rows.')}
  ${renderLineChart({
    x: 26,
    y: 378,
    w: 928,
    h: 238,
    series: latencySeries,
    unitLabel: 'Offered TPS',
    yMax: latencyMax * 1.15,
    xDomain: stepValues,
    xFormatter: fmtTps,
  })}
  <text x="34" y="688" fill="#6b778c" font-family="Times New Roman, Times, serif" font-size="13">
    Source artifacts: ${escapeXml(runs.map((run) => rel(run.runDir)).join(', '))}
  </text>`;

  return buildSvgDocument(test.title, test.subtitle, body);
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const manifest = {
    generatedAtUtc: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    outputDir: rel(OUTPUT_DIR),
    figures: [],
    missing: [],
  };

  let missingCount = 0;
  for (const test of TESTS) {
    const runs = loadRunsForTest(test).filter((run) => measurementRows(run, test).length > 0);
    if (runs.length === 0) {
      missingCount += 1;
      manifest.missing.push({
        test: test.key,
        expectedConfig: test.config,
        reason: 'No retained Caliper run with a parseable summary was found yet.',
      });
      continue;
    }

    const filePath = path.join(OUTPUT_DIR, test.fileName);
    const svg = test.kind === 'sweep'
      ? buildSweepFigure(test, runs)
      : buildSingleRunFigure(test, runs);
    fs.writeFileSync(filePath, svg);

    const sources = runs.map((run) => ({
      runId: run.manifest.runId,
      runDir: rel(run.runDir),
      benchmarkConfig: run.manifest.benchmarkConfig,
      startedAtUtc: run.manifest.startedAtUtc,
      status: run.manifest.status,
      reportCreated: Boolean(run.manifest.reportCreated),
      summarySha256: run.manifest.performanceSummary
        ? sha256(path.join(run.runDir, run.manifest.performanceSummary))
        : null,
    }));

    manifest.figures.push({
      test: test.key,
      file: rel(filePath),
      sha256: sha256(filePath),
      sources,
    });
  }

  if (manifest.figures.length > 0) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log(`Wrote ${manifest.figures.length} Caliper figure${manifest.figures.length === 1 ? '' : 's'} to ${rel(OUTPUT_DIR)}`);
  if (manifest.missing.length > 0) {
    console.log('Missing data for:');
    for (const item of manifest.missing) {
      console.log(`  - ${item.test} (${item.expectedConfig}): ${item.reason}`);
    }
  }

  if (missingCount > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
