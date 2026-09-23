#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MODEL_VERSION } = require('../../src/policy');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = {
    adapter: 'experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v4-best/adapters.safetensors',
    output: 'experiments/runs/20260902_qwen3_policy_engine_train_v4/deployment_manifest.json',
  };
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '');
    if (!(name in args) || argv[index + 1] === undefined) {
      throw new Error(`invalid option '${argv[index] || ''}'`);
    }
    args[name] = argv[index + 1];
  }
  return args;
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function main() {
  const args = parseArgs(process.argv);
  const adapterPath = path.resolve(ROOT, args.adapter);
  const outputPath = path.resolve(ROOT, args.output);
  if (!fs.existsSync(adapterPath)) throw new Error(`adapter not found: ${adapterPath}`);
  const adapterHash = sha256Buffer(fs.readFileSync(adapterPath));
  const manifest = {
    createdAtUtc: new Date().toISOString(),
    modelVersion: MODEL_VERSION,
    adapterPath: path.relative(ROOT, adapterPath),
    adapterSha256: adapterHash,
    serving: {
      engine: 'mlx_lm.server',
      model: 'mlx-community/Qwen3-14B-4bit',
      temperature: 0,
      topP: 1,
      maxTokens: 192,
      chatTemplateArgs: { enable_thinking: false },
    },
    runtime: 'standalone-local',
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(JSON.stringify({
    deploymentManifest: path.relative(ROOT, outputPath),
    adapterSha256: adapterHash,
    environment: {
      LLM_POLICY_ADAPTER_HASH: adapterHash,
    },
  }, null, 2));
  process.stdout.write('\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
