'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SYSTEM_PROMPT, buildUserPrompt } = require('../../backend/src/llm/policyPrompt');
const { groundedSystemPrompt } = require('../../backend/src/llm/groundedPolicyPrompt');
const { evaluate } = require('../../chaincode/crimerecords/lib/policy/policyEngine');
const reasonDecisions = require('../../chaincode/crimerecords/lib/policy/reasonDecisions');
const { SYSTEM_REASON_CODES } = require('../../chaincode/crimerecords/lib/policy/controlledDecision');
const { POLICY_VERSION } = require('../../chaincode/crimerecords/lib/policy/policyV1');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function score(rows) {
  const n = rows.length;
  const correct = (r) => r.valid && r.prediction.action === r.expected.action && r.prediction.purpose === r.expected.purpose && r.prediction.decision === r.expected.decision && r.prediction.reasonCode === r.expected.reasonCode;
  const nonAllows = rows.filter(r=>r.expected.decision !== 'allow');
  const allows = rows.filter(r=>r.valid && r.prediction.decision === 'allow');
  const latencies = rows.map(r=>r.latencyMs).sort((a,b)=>a-b);
  return { n, schemaValid: rows.filter(r=>r.valid).length,
    decisionAccuracy: rows.filter(r=>r.valid && r.prediction.decision===r.expected.decision).length/n,
    jointAccuracy: rows.filter(correct).length/n,
    actionAccuracy: rows.filter(r=>r.valid && r.prediction.action===r.expected.action).length/n,
    purposeAccuracy: rows.filter(r=>r.valid && r.prediction.purpose===r.expected.purpose).length/n,
    falseAllows: nonAllows.filter(r=>r.valid && r.prediction.decision==='allow').length,
    expectedNonAllows: nonAllows.length,
    allowPrecision: allows.length ? allows.filter(r=>r.expected.decision==='allow').length/allows.length : null,
    guardedFalseAllows: nonAllows.filter(r=>r.guardedDecision==='allow').length,
    guardReferrals: rows.filter(r=>r.guardDisagreement).length,
    rejected: rows.filter(r=>!r.valid).length,
    adversarialJointAccuracy: rows.filter(r=>r.adversarial && correct(r)).length / rows.filter(r=>r.adversarial).length,
    medianLatencyMs: latencies[Math.floor(n/2)], p95LatencyMs: latencies[Math.min(n-1,Math.floor(n*.95))],
    perReason: Object.fromEntries([...new Set(rows.map(r=>r.expected.reasonCode))].map(c=>{const rs=rows.filter(r=>r.expected.reasonCode===c);return [c,{n:rs.length,correct:rs.filter(correct).length}];})),
  };
}
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a,v,i,arr)=>i%2?a:[...a,[v.replace(/^--/,''),arr[i+1]]],[]));
  const { data, output, adapter } = args;
  if (!data || !output || !adapter) throw new Error('--data --output --adapter required');
  if (fs.existsSync(output)) throw new Error('output exists; retain completed runs');
  const version = args.version || 'qwen3-14b-seba-lora-v4';
  const arm = args.arm || 'grounded';
  if (!['short', 'grounded', 'no-subject'].includes(arm)) throw new Error('invalid arm');
  const cases = JSON.parse(fs.readFileSync(data));
  // Round-robin reasons for small validation subsets.
  cases.sort((a,b)=>a.expected.reasonCode.localeCompare(b.expected.reasonCode));
  const codes = [...new Set(cases.map(r=>r.expected.reasonCode))];
  const ordered = []; for(let i=0;i<cases.length/codes.length;i++) for(const c of codes){const row=cases.filter(r=>r.expected.reasonCode===c)[i];if(row)ordered.push(row);}
  const selected = args.limit ? ordered.slice(0,Number(args.limit)) : ordered;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const rows = [];
  const config = { ...args, version, arm, seed:42, policyVersion:POLICY_VERSION, dataSha256:sha(fs.readFileSync(data)), adapterSha256:sha(fs.readFileSync(path.join(adapter,'adapters.safetensors'))), startedAtUtc:new Date().toISOString() };
  fs.writeFileSync(`${output}.config.json`,JSON.stringify(config,null,2));
  for (const example of selected) {
    const input = structuredClone(example.input);
    // Remove both the attributes and role-specific permission row in this ablation.
    if (arm==='no-subject') input.subject = Object.fromEntries(Object.keys(input.subject).map(k=>[k,null]));
    const system = arm==='short' ? `${SYSTEM_PROMPT} modelVersion must be ${version}.` : groundedSystemPrompt(input.subject,version);
    const messages = [{role:'system',content:system},{role:'user',content:buildUserPrompt(input)}];
    const started=performance.now();
    let raw='', prediction=null, error=null;
    try {
      const response=await fetch(`${args.url||'http://127.0.0.1:8080'}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(90000),body:JSON.stringify({model:'mlx-community/Qwen3-14B-4bit',adapters:path.resolve(adapter),messages,temperature:0,top_p:1,max_tokens:192,stream:false,seed:42})});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const body=await response.json();raw=String(body.choices?.[0]?.message?.content||'').trim();prediction=JSON.parse(raw);
    }catch(e){error=e.message;}
    const expectedKeys=['action','decision','modelVersion','policyVersion','purpose','reasonCode'].sort().join(',');
    const valid=Boolean(prediction && Object.keys(prediction).sort().join(',')===expectedKeys && ['view','export','annotate'].includes(prediction.action) && typeof prediction.purpose==='string' && prediction.purpose.length>0 && ['allow','deny','escalate'].includes(prediction.decision) && prediction.reasonCode in reasonDecisions && !SYSTEM_REASON_CODES.includes(prediction.reasonCode) && reasonDecisions[prediction.reasonCode]===prediction.decision && prediction.policyVersion===POLICY_VERSION && prediction.modelVersion===version);
    const oracle=valid ? evaluate(example.input.subject,example.input.record,prediction.action,{purpose:prediction.purpose}) : null;
    const guardDisagreement=Boolean(valid && (oracle.decision!==prediction.decision || oracle.reasonCode!==prediction.reasonCode));
    const row={id:example.id,expected:example.expected,adversarial:example.adversarial,simple:example.simple,raw,prediction,valid,error,guardDisagreement,guardedDecision:valid?(guardDisagreement?'escalate':prediction.decision):null,latencyMs:performance.now()-started,promptHash:sha(JSON.stringify(messages))};
    rows.push(row);fs.appendFileSync(`${output}.partial.jsonl`,JSON.stringify(row)+'\n');
    if(rows.length%10===0)console.log(`${arm} ${rows.length}/${selected.length} joint=${score(rows).jointAccuracy.toFixed(3)}`);
  }
  const result={config,finishedAtUtc:new Date().toISOString(),metrics:score(rows),rows};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result.metrics));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={score};
