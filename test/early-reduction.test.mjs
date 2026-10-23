import test from 'node:test';
import assert from 'node:assert/strict';
import {computeNextStep as next,computeCvStep as cv} from '../control-policy.mjs';
const computeNextStep=(s,v,p)=>next(s,v,{lowerStepRaw:500,earlyGapMv:0,earlyStepMa:0,...p});
const computeCvStep=(s,v,p)=>cv(s,v,{cvOffsetMv:-20,cvFastGapMv:10,earlyGapMv:0,earlyStepMa:0,...p});

test('提前降流在设定值下方触发，零压差或零步进关闭，单步不补扣且等待期间不升流',()=>{
  const p={limitMv:4560,cutoffGapMv:0,earlyGapMv:-10,earlyStepMa:50,nowMs:1000,elapsedMs:600,intervalMs:50,lowerStepRaw:500};
  const initial={targetRaw:5000};
  assert.equal(computeNextStep(initial,4549000,p).targetRaw,5100);
  const s=computeNextStep(initial,4550000,p);assert.equal(s.targetRaw,4950);assert.equal(s.earlyHoldUntilMs,2500);
  assert.equal(computeNextStep(initial,4560000,p).targetRaw,4950);
  assert.equal(computeNextStep(s,4550000,{...p,nowMs:1200}).targetRaw,4950);
  assert.equal(computeNextStep(s,4540000,{...p,nowMs:1200}).targetRaw,4950);
  assert.equal(computeNextStep(s,4550000,{...p,nowMs:2500}).targetRaw,4900);
  assert.equal(computeNextStep(s,4540000,{...p,nowMs:2500}).targetRaw,5050);
  assert.equal(computeNextStep(initial,4550000,{...p,earlyGapMv:0}).targetRaw,5100);
  assert.equal(computeNextStep(initial,4550000,{...p,earlyStepMa:0}).targetRaw,5100);
  assert.equal(computeNextStep(initial,4550000,{...p,earlyStepMa:1}).targetRaw,4999);
  assert.equal(computeNextStep(initial,4550000,{...p,earlyStepMa:1000}).targetRaw,4000);
  assert.equal(computeNextStep({targetRaw:1500},4550000,{...p,earlyStepMa:1000}).targetRaw,1000);
  assert.equal(computeNextStep({targetRaw:500},4550000,p).targetRaw,500);
  assert.equal(computeNextStep(initial,4550000,{...p,nowMs:0}).targetRaw,1000);
  assert.equal(computeNextStep(s,4561000,{...p,nowMs:1200}).targetRaw,1000,'超过上限仍快速降流');
});

test('提前降流与恒压共用写入等待，一轮只降一个设定步进，轻微超限和快速降流仍分级处理',()=>{
  const p={limitMv:4560,cvOffsetMv:0,earlyGapMv:-10,earlyStepMa:200,nowMs:1500,lowerStepRaw:500,intervalMs:50,elapsedMs:600};
  const initial={targetRaw:5000,nextAdjustMs:1500};
  assert.equal(computeCvStep(initial,4550000,{...p,nowMs:1499}).targetRaw,5000);
  const s=computeCvStep(initial,4550000,p);assert.deepEqual(s,{targetRaw:4800,nextAdjustMs:3000});
  assert.equal(computeCvStep(s,4550000,{...p,nowMs:1600}).targetRaw,4800);
  assert.equal(computeCvStep(s,4561000,{...p,nowMs:1600}).targetRaw,4800);
  assert.equal(computeCvStep(s,4561000,{...p,nowMs:3000}).targetRaw,4700);
  assert.equal(computeCvStep(s,4570000,{...p,nowMs:1600}).targetRaw,1000);
  assert.equal(computeCvStep(initial,4550000,{...p,full:true}).targetRaw,4800);
});
