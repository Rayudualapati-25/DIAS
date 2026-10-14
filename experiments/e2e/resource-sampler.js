#!/usr/bin/env node
'use strict';

/** CPU and memory of every part of the Mac host, sampled until stopped. */

const fs = require('fs');
const { execFile } = require('child_process');

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
    (error, stdout) => resolve(error ? '' : stdout));
});

/** "123.4MiB / 7.8GiB" -> MiB used. */
function mebibytes(text) {
  const match = /([\d.]+)\s*([KMGT]?i?B)/i.exec(String(text || ''));
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const scale = { B: 1 / 1048576, KB: 1 / 1024, KIB: 1 / 1024, MB: 1, MIB: 1, GB: 1024, GIB: 1024, TB: 1048576, TIB: 1048576 };
  return Math.round(value * (scale[unit] ?? 1) * 10) / 10;
}

/** What part of the host a process is, or null. */
function processKind(command) {
  if (/node backend\/src\/server\.js/.test(command)) return 'backend';
  if (/mlx_lm\.server/.test(command) && /Python/.test(command)) return 'model-server';
  if (/qemu-system/.test(command)) {
    const avd = /-avd\s+(\S+)/.exec(command);
    return `emulator:${avd ? avd[1] : 'unknown'}`;
  }
  return null;
}

async function sample() {
  const t = Date.now();
  const lines = [];
  const stats = await run('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}']);
  for (const line of stats.split('\n').filter(Boolean)) {
    const [name, cpu, memory] = line.split('\t');
    lines.push({ t, kind: 'container', name, cpuPercent: Number(String(cpu).replace('%', '')), memoryMiB: mebibytes(memory) });
  }
  const ps = await run('ps', ['-Ao', 'pid=,pcpu=,rss=,command=']);
  for (const line of ps.split('\n').filter(Boolean)) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const kind = processKind(match[4]);
    if (!kind) continue;
    lines.push({ t, kind: 'process', name: kind, pid: Number(match[1]), cpuPercent: Number(match[2]),
      memoryMiB: Math.round((Number(match[3]) / 1024) * 10) / 10 });
  }
  const load = await run('sysctl', ['-n', 'vm.loadavg']);
  const pages = await run('vm_stat', []);
  const page = Number((/page size of (\d+)/.exec(pages) || [])[1] || 16384);
  const count = (label) => Number((new RegExp(`${label}:\\s+(\\d+)`).exec(pages) || [])[1] || 0);
  const usedPages = count('Pages active') + count('Pages wired down') + count('Pages occupied by compressor');
  lines.push({ t, kind: 'host', name: 'mac', loadAverage1m: Number(String(load).replace(/[{}]/g, '').trim().split(/\s+/)[0]),
    memoryMiB: Math.round((usedPages * page) / 1048576) });
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf('--out') + 1];
  const every = Number(argv.includes('--every') ? argv[argv.indexOf('--every') + 1] : 5) * 1000;
  if (!out || argv.indexOf('--out') === -1) throw new Error('usage: resource-sampler.js --out FILE [--every SECONDS]');
  let stopped = false;
  process.on('SIGTERM', () => { stopped = true; });
  process.on('SIGINT', () => { stopped = true; });
  while (!stopped) {
    const started = Date.now();
    const lines = await sample();
    fs.appendFileSync(out, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    const wait = every - (Date.now() - started);
    if (wait > 0 && !stopped) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

module.exports = { mebibytes, processKind };

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
