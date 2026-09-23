#!/usr/bin/env node
'use strict';

// Run after extracting the Overleaf ZIP and compiling its main.tex.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const extracted = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'Pass the extracted and compiled package directory.');
const run = path.join(root, 'experiments/runs/20260915_dias_paper_rewrite');
const paper = path.join(root, 'papers/final_paper');
const read = (file) => fs.readFileSync(file, 'utf8');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const source = (file) => read(path.join(paper, file));
const headings = (s) => [...s.matchAll(/\\subsection\{([^}]+)\}/g)].map((m) => m[1]);
const methodHeadings = headings(source('methodology.tex'));
assert.deepEqual(methodHeadings, [
  'Contextual Recommendation and Auditor Decision', 'Exact-Scope Dynamic Access Policy',
  'Explainable Audit and Governed Record Sharing', 'Algorithm Summary'
]);
assert.equal(/\\subsubsection/.test(source('methodology.tex')), false);
const resultHeadings = headings(source('evaluation_setup.tex') + source('results.tex'));
assert.equal(resultHeadings.length, 4);
assert.ok(source('methodology.tex').includes('\\input{methodology_algorithm}'));
assert.equal(sha(path.join(paper, 'introduction.tex')),
  sha(path.join(run, 'before/introduction.tex')), 'The user introduction must remain unchanged.');

const copies = {
  'DIAS_Methodology_Results.tex': 'main.tex',
  'methodology.tex': 'methodology.tex',
  'methodology_algorithm.tex': 'methodology_algorithm.tex',
  'evaluation_setup.tex': 'evaluation_setup.tex',
  'results.tex': 'results.tex',
  'DIAS_OVERLEAF_README.md': 'README.md',
  'DIAS_REWRITE_NOTES.md': 'DIAS_REWRITE_NOTES.md',
  'tables/dias_recommendation.tex': 'tables/dias_recommendation.tex',
  'tables/dias_input_ablation.tex': 'tables/dias_input_ablation.tex',
  'tables/dias_scope.tex': 'tables/dias_scope.tex',
  'tables/dias_workflow.tex': 'tables/dias_workflow.tex'
};
for (const [original, copy] of Object.entries(copies)) {
  assert.equal(sha(path.join(paper, original)), sha(path.join(extracted, copy)), copy);
}
const standalone = path.join(root, 'output/pdf/DIAS_Methodology_Results.pdf');
const compiledPackage = path.join(extracted, 'main.pdf');
const full = path.join(root, 'output/pdf/dias_paper.pdf');
const pdfText = (file) => execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
assert.equal(pdfText(standalone), pdfText(compiledPackage), 'The isolated package must reproduce the text.');
const pages = (file) => Number(execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/^Pages:\s+(\d+)/m)[1]);
assert.equal(pages(standalone), 3);
assert.equal(pages(compiledPackage), 3);
const logFiles = [path.join(root, 'output/pdf/DIAS_Methodology_Results.log'),
  path.join(root, 'output/pdf/dias_paper.log'), path.join(extracted, 'main.log')];
for (const file of logFiles) {
  const log = read(file);
  assert.equal(/Overfull \\[hv]box/.test(log), false, file);
  assert.equal(/LaTeX Warning: (?:Reference|Citation).*undefined/.test(log), false, file);
  assert.equal(/There were undefined references|multiply defined|^! /m.test(log), false, file);
}
const outputs = ['output/pdf/DIAS_Methodology_Results.pdf',
  'output/overleaf/DIAS_Methodology_Results_Overleaf.zip',
  'experiments/runs/20260915_dias_paper_rewrite/evidence.json',
  'results/tables/dias_paper_final_model_comparison.csv',
  'results/tables/dias_paper_final_input_ablation.csv'];
const report = {
  validatedAt: new Date().toISOString(), status: 'PASS', methodHeadings, resultHeadings,
  checks: { methodologySubsections: 4, algorithmSummaryLast: true, resultTables: 4,
    sourceFilesMatchZip: Object.keys(copies).length, standalonePages: pages(standalone),
    isolatedPackagePages: pages(compiledPackage), isolatedTextMatches: true,
    fullManuscriptPages: pages(full), overfullBoxes: 0, unresolvedReferences: 0,
    originalIntroductionPreserved: true },
  tools: { node: process.version,
    tectonic: execFileSync('tectonic', ['--version'], { encoding: 'utf8' }).trim() },
  warnings: ['Tectonic emits initial IEEE font-encoding fallback warnings; final PDF embeds Times-compatible Nimbus Roman fonts.',
    'The algorithm package has a non-UTF-8 comment warning.',
    'Underfull boxes remain in the method opening and full-paper bibliography; no overfull boxes were found.'],
  boundaries: ['Visual checks are recorded separately in iteration 45.',
    'This is local package validation, not an Overleaf-hosted build.',
    'No model training, new evaluation inference, or live traffic was performed.'],
  sourceSha256: Object.fromEntries(Object.keys(copies).map((f) => [f, sha(path.join(paper, f))])),
  outputSha256: Object.fromEntries(outputs.map((f) => [f, sha(path.join(root, f))]))
};
fs.copyFileSync(path.join(extracted, 'main.log'), path.join(run, 'package-build.log'));
fs.writeFileSync(path.join(run, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, ...report.checks }));
