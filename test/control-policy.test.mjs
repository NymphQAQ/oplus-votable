import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  PROTOCOLS,
  VOTE_MIN_RAW,
  INITIAL_RAW, INITIAL_MIN_RAW, INITIAL_MAX_RAW,
  DEFAULT_VOTE_MAX_RAW, DEFAULT_PPS_VOTE_MAX_RAW, PPS_VOTE_MAX_MAX_RAW,
  VOTE_MAX_MIN_RAW, VOTE_MAX_MAX_RAW,
  DEFAULT_LIMIT_MV, DEFAULT_PPS_LIMIT_MV, LIMIT_MIN_MV, LIMIT_MAX_MV,
  RAISE_STEP_RAW, LOWER_STEP_RAW, RAISE_STEP_MIN_RAW, RAISE_STEP_MAX_RAW,
  LOWER_STEP_MIN_RAW, LOWER_STEP_MAX_RAW,
  CUTOFF_GAP_MV, CUTOFF_GAP_MIN_MV, CUTOFF_GAP_MAX_MV,
  INTERVAL_MS, INTERVAL_MIN_MS, INTERVAL_MAX_MS,
  initialSession, shouldControl,
  clampInitialRaw, clampRaiseStep, clampLowerStep, clampCutoffGapMv,
  clampIntervalMs, clampLimitMv, clampVoteMax, computeNextStep,
} from '../control-policy.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const shell = join(root,'charge-test.sh');
const service = join(root,'service.sh');
const guard = join(root,'watchdog.sh');

test('多协议与高级参数常量与用户设定一致',()=>{
  assert.deepEqual(PROTOCOLS,['ufcs','pps']);
  assert.equal(VOTE_MIN_RAW,1000);
  assert.equal(INITIAL_RAW,1000);
  assert.equal(INITIAL_MIN_RAW,1000);
  assert.equal(INITIAL_MAX_RAW,10000);
  assert.equal(DEFAULT_VOTE_MAX_RAW,9000);
  assert.equal(DEFAULT_PPS_VOTE_MAX_RAW,5000);
  assert.equal(PPS_VOTE_MAX_MAX_RAW,5800);
  assert.equal(VOTE_MAX_MIN_RAW,1000);
  assert.equal(VOTE_MAX_MAX_RAW,13500);
  assert.equal(DEFAULT_LIMIT_MV,4560);
  assert.equal(DEFAULT_PPS_LIMIT_MV,4500);
  assert.equal(LIMIT_MIN_MV,3800);
  assert.equal(LIMIT_MAX_MV,4560);
  assert.equal(RAISE_STEP_RAW,100);
  assert.equal(LOWER_STEP_RAW,500);
  assert.equal(RAISE_STEP_MIN_RAW,10);
  assert.equal(RAISE_STEP_MAX_RAW,500);
  assert.equal(LOWER_STEP_MIN_RAW,100);
  assert.equal(LOWER_STEP_MAX_RAW,1000);
  assert.equal(CUTOFF_GAP_MV,-50);
  assert.equal(CUTOFF_GAP_MIN_MV,-100);
  assert.equal(CUTOFF_GAP_MAX_MV,0);
  assert.equal(INTERVAL_MS,100);
  assert.equal(INTERVAL_MIN_MS,20);
  assert.equal(INTERVAL_MAX_MS,200);
});

test('新会话从投票初始值起步',()=>{
  assert.deepEqual(initialSession(),{targetRaw:1000});
  assert.deepEqual(initialSession(3000),{targetRaw:3000});
  assert.deepEqual(initialSession(99999),{targetRaw:10000});
  assert.deepEqual(initialSession(10),{targetRaw:1000});
});

test('仅当监测开、协议开、协议在线同时满足时才接管',()=>{
  assert.equal(shouldControl({monitorOn:true,protoEnabled:true,protoOnline:true}),true);
  assert.equal(shouldControl({monitorOn:true,protoEnabled:true,protoOnline:false}),false);
  assert.equal(shouldControl({monitorOn:true,protoEnabled:false,protoOnline:true}),false);
  assert.equal(shouldControl({monitorOn:false,protoEnabled:true,protoOnline:true}),false);
  assert.equal(shouldControl({monitorOn:false,protoEnabled:false,protoOnline:false}),false);
});

test('各高级参数被夹到合法区间，非法值回落默认',()=>{
  assert.equal(clampInitialRaw(5000),5000);
  assert.equal(clampInitialRaw(500),1000);
  assert.equal(clampInitialRaw(20000),10000);
  assert.equal(clampInitialRaw('abc'),1000);
  assert.equal(clampRaiseStep(200),200);
  assert.equal(clampRaiseStep(5),10);
  assert.equal(clampRaiseStep(5000),500);
  assert.equal(clampLowerStep(undefined),500);
  assert.equal(clampLowerStep(70),100);
  assert.equal(clampLowerStep(2000),1000);
  assert.equal(clampIntervalMs(50),50);
  assert.equal(clampIntervalMs(10),20);
  assert.equal(clampIntervalMs(300),200);
  assert.equal(clampCutoffGapMv(-80),-80);
  assert.equal(clampCutoffGapMv(1),0);
  assert.equal(clampCutoffGapMv(-101),-100);
  assert.equal(clampCutoffGapMv('abc'),-50);
});

test('设定电压被夹到 3800..4560，投票上限被夹到 1000..13500',()=>{
  assert.equal(clampLimitMv(4000),4000);
  assert.equal(clampLimitMv(3700),3800);
  assert.equal(clampLimitMv(4600),4560);
  assert.equal(clampLimitMv('abc'),4560);
  assert.equal(clampVoteMax(12000),12000);
  assert.equal(clampVoteMax(500),1000);
  assert.equal(clampVoteMax(20000),13500);
  assert.equal(clampVoteMax('abc'),9000);
});

test('电压低于 设定值+截止压差 时按提升步进上升（默认 -50mV、步进 100）',()=>{
  const step=computeNextStep({targetRaw:1000},4_440_000);
  assert.equal(step.raised,true);
  assert.equal(step.lowered,false);
  assert.equal(step.targetRaw,1100);
  const top=computeNextStep({targetRaw:9000},4_440_000);
  assert.equal(top.raised,false);
  assert.equal(top.targetRaw,9000);
});

test('电压在 设定值+截止压差..设定值 之间保持不变',()=>{
  const lo=computeNextStep({targetRaw:3000},4_510_000);
  assert.equal(lo.raised,false);
  assert.equal(lo.lowered,false);
  assert.equal(lo.targetRaw,3000);
  const hi=computeNextStep({targetRaw:3000},4_560_000);
  assert.equal(hi.raised,false);
  assert.equal(hi.lowered,false);
  assert.equal(hi.targetRaw,3000);
});

test('电压超过设定值时按降低步进回落，最低降到 1000',()=>{
  const first=computeNextStep({targetRaw:5000},4_600_000);
  assert.equal(first.lowered,true);
  assert.equal(first.raised,false);
  assert.equal(first.targetRaw,4500);
  const bottom=computeNextStep({targetRaw:1000},4_700_000);
  assert.equal(bottom.targetRaw,1000);
  assert.equal(bottom.lowered,false);
});

test('参数可调：设定值、投票上限、步进与截止压差都改变决策',()=>{
  assert.equal(computeNextStep({targetRaw:2000},3_900_000,{limitMv:4000}).targetRaw,2100);
  assert.equal(computeNextStep({targetRaw:2000},3_960_000,{limitMv:4000}).targetRaw,2000);
  assert.equal(computeNextStep({targetRaw:2000},4_100_000,{limitMv:4000}).targetRaw,1500);
  assert.equal(computeNextStep({targetRaw:1000},4_400_000,{raiseStepRaw:500}).targetRaw,1500);
  assert.equal(computeNextStep({targetRaw:5000},4_600_000,{lowerStepRaw:250}).targetRaw,4750);
  // 截止压差：更负的压差会提前停止升流。
  assert.equal(computeNextStep({targetRaw:2000},4_530_000,{cutoffGapMv:0}).targetRaw,2100);
  assert.equal(computeNextStep({targetRaw:2000},4_530_000,{cutoffGapMv:-50}).targetRaw,2000);
  // 投票上限：到达即停，上限下调立即收敛。
  assert.equal(computeNextStep({targetRaw:11000},4_400_000,{voteMaxRaw:11000}).raised,false);
  assert.equal(computeNextStep({targetRaw:12000},4_400_000,{voteMaxRaw:5000}).targetRaw,5000);
  assert.equal(computeNextStep({targetRaw:13000},4_400_000,{voteMaxRaw:13500}).targetRaw,13100);
});

test('非法电压读数不改变投票值',()=>{
  for (const bad of [NaN,undefined,null,'',Infinity,0,-1]) {
    const r=computeNextStep({targetRaw:2000},bad);
    assert.equal(r.targetRaw,2000);
    assert.equal(r.raised,false);
    assert.equal(r.lowered,false);
  }
});

test('charge-test.sh 常量与算法模型保持一致',()=>{
  const s=readFileSync(shell,'utf8');
  assert.match(s,/^VOTE_MIN=1000$/m);
  assert.match(s,/^DEFAULT_INITIAL=1000$/m);
  assert.match(s,/^INITIAL_MIN=1000$/m);
  assert.match(s,/^INITIAL_MAX=10000$/m);
  assert.match(s,/^DEFAULT_INTERVAL=100$/m);
  assert.match(s,/^INTERVAL_MIN=20$/m);
  assert.match(s,/^INTERVAL_MAX=200$/m);
  assert.match(s,/^DEFAULT_RAISE_STEP=100$/m);
  assert.match(s,/^RAISE_STEP_MIN=10$/m);
  assert.match(s,/^RAISE_STEP_MAX=500$/m);
  assert.match(s,/^DEFAULT_LOWER_STEP=500$/m);
  assert.match(s,/^LOWER_STEP_MIN=100$/m);
  assert.match(s,/^LOWER_STEP_MAX=1000$/m);
  assert.match(s,/^DEFAULT_GAP=-50$/m);
  assert.match(s,/^GAP_MIN=-100$/m);
  assert.match(s,/^GAP_MAX=0$/m);
  assert.match(s,/^DEFAULT_VOTE_MAX=9000$/m);
  assert.match(s,/^DEFAULT_PPS_VOTE_MAX=5000$/m);
  assert.match(s,/^PPS_VOTE_MAX_MAX=5800$/m);
  assert.match(s,/^VOTE_MAX_MIN=1000$/m);
  assert.match(s,/^VOTE_MAX_MAX=13500$/m);
  assert.match(s,/^DEFAULT_LIMIT_MV=4560$/m);
  assert.match(s,/^DEFAULT_PPS_LIMIT_MV=4500$/m);
  assert.match(s,/^LIMIT_MIN_MV=3800$/m);
  assert.match(s,/^LIMIT_MAX_MV=4560$/m);
  assert.match(s,/control_proto\(\) \{ case "\$1" in ufcs\|pps\)/);
  assert.match(s,/\bUFCS_CURR\b/);
  assert.match(s,/\bVOOC_CURR\b/);
  assert.match(s,/旧租约清理专用/);
  assert.match(s,/! control_proto "\$ap"/);
  assert.match(s,/\bPPS_CURR\b/);
  assert.match(s,/START_ADAPTIVE_\$target/);
  // 目标变化时必须重写 force_active，驱动才会回调应用新的 force_val。
  assert.match(s,/printf '1' > "\$node\/force_active"/);
  assert.match(s,/FINISHED_PROTOCOL_CHANGED/);
  assert.match(s,/FINISHED_PROTOCOL_DISABLED/);
  assert.match(s,/FINISHED_MONITOR_DISABLED/);
  assert.match(s,/--control-run/);
  assert.match(s,/--monitor-enable/);
  assert.match(s,/--monitor-disable/);
  assert.match(s,/--monitor-ensure/);
  assert.match(s,/--proto-enable/);
  assert.match(s,/--proto-disable/);
  assert.match(s,/auto-control\.%s\.%s/);
  assert.match(s,/proto_config "\$1" enabled/);
  assert.match(s,/--limit-set/);
  assert.match(s,/proto_config "\$1" limit-mv/);
  assert.match(s,/--vote-max-set/);
  assert.match(s,/proto_config "\$1" vote-max/);
  assert.match(s,/--vote-initial-set/);
  assert.match(s,/--interval-set/);
  assert.match(s,/--raise-step-set/);
  assert.match(s,/--lower-step-set/);
  assert.match(s,/--cutoff-gap-set/);
  assert.match(s,/--recover/);
  assert.match(s,/active-test\.lease/);
  assert.match(s,/oplus_mms\/\$1\/data/);
  assert.doesNotMatch(s,/--manual-enable|--manual-disable|MANUAL_ENABLED/);
  assert.doesNotMatch(s,/natural/);
  assert.doesNotMatch(s,/TARGET=10700/);
  assert.doesNotMatch(s,/CAP_RAW/);
  assert.doesNotMatch(s,/I_AGREE_LIMIT_ONLY_MANUAL/);
  assert.doesNotMatch(s,/\bpidof\b/);
  execFileSync('sh',['-n',shell],{timeout:3000});
  execFileSync('sh',['-n',service],{timeout:3000});
  execFileSync('sh',['-n',guard],{timeout:3000});
});

test('service.sh 按总开关拉起常驻控制守护，watchdog 只负责租约恢复',()=>{
  const svc=readFileSync(service,'utf8');
  const wd=readFileSync(guard,'utf8');
  assert.match(svc,/--monitor-ensure/);
  assert.doesNotMatch(svc,/charge-test\.sh" --run/);
  assert.match(wd,/charge-test\.sh" --recover/);
  assert.match(wd,/UFCS_CURR/);
  assert.match(wd,/VOOC_CURR/);
  assert.match(wd,/PPS_CURR/);
});
