import test from 'node:test';
import assert from 'node:assert/strict';
import * as implementation from '../control-policy.mjs';
// 明确保留原回归场景参数，不依赖用户新设的默认值。
const policy={...implementation,
  computeCvStep:(s,v,p)=>implementation.computeCvStep(s,v,{cvOffsetMv:-20,cvFastGapMv:10,earlyGapMv:0,earlyStepMa:0,...p}),
  computeNextStep:(s,v,p)=>implementation.computeNextStep(s,v,{earlyGapMv:0,earlyStepMa:0,...p}),
};

test('后段在上限前细调，等待响应，满充禁止升流，硬超限与异常读数仍快速降流',()=>{
  assert.equal(typeof policy.computeCvStep,'function');
  const p={limitMv:4560,cutoffGapMv:-20,raiseStepRaw:100,lowerStepRaw:100,intervalMs:50,voteMaxRaw:5000,nowMs:1000};
  let s=policy.computeCvStep({targetRaw:4000},4550000,p);
  assert.equal(s.targetRaw,3900);assert.equal(s.nextAdjustMs,2500);
  s=policy.computeCvStep(s,4510000,{...p,nowMs:1100});assert.equal(s.targetRaw,3900);
  s=policy.computeCvStep(s,4510000,{...p,nowMs:2500});assert.equal(s.targetRaw,3950);
  assert.equal(policy.computeCvStep(s,4510000,{...p,nowMs:5000,full:true}).targetRaw,3950);
  assert.equal(policy.computeCvStep(s,4510000,{...p,nowMs:5000,allowRaise:false}).targetRaw,3950);
  assert.equal(policy.computeCvStep(s,4540000,{...p,nowMs:5000}).targetRaw,3950);
  assert.ok(policy.computeCvStep(s,4604000,{...p,nowMs:2600,elapsedMs:200}).targetRaw<=3550);
  assert.equal(policy.computeCvStep(s,0,{...p,nowMs:2600}).targetRaw,1000);
  assert.equal(policy.computeCvStep(s,4510000,{...p,nowMs:0}).targetRaw,1000);
});

test('延迟响应闭环重现大幅振荡，后段细调降低峰值和投票摆幅（模型验证）',()=>{
  assert.equal(typeof policy.computeCvStep,'function');
  const simulate=modern=>{
    let state={targetRaw:3000},actual=3000,heldUntil=0;
    const queue=Array(20).fill(3000),out=[];
    for(let ms=80;ms<=180000;ms+=80) {
      const mv=4470+20*ms/180000+actual*.03;
      const p={limitMv:4560,cutoffGapMv:-20,raiseStepRaw:100,lowerStepRaw:100,intervalMs:50,voteMaxRaw:5000,nowMs:ms,elapsedMs:80,allowRaise:ms>=heldUntil};
      if(modern) state=policy.computeCvStep(state,Math.round(mv*1000),p);
      else if(mv>4560 || ms>=heldUntil) state=policy.computeNextStep(state,Math.round(mv*1000),p);
      if(mv>4560) heldUntil=ms+1000;
      queue.push(state.targetRaw);const delayed=queue.shift();actual+=(delayed-actual)*.2;
      if(ms>60000)out.push({mv,vote:state.targetRaw});
    }
    return {peak:Math.max(...out.map(p=>p.mv)),swing:Math.max(...out.map(p=>p.vote))-Math.min(...out.map(p=>p.vote))};
  };
  const old=simulate(false),now=simulate(true);
  assert.ok(old.peak>4600,JSON.stringify(old));assert.ok(now.peak<4560,JSON.stringify(now));
  assert.ok(now.swing<old.swing/2,JSON.stringify({old,now}));
});

test('自定义保持范围、升降步进上限与等待时间参与电压反馈计算',()=>{
  const p={limitMv:4560,cutoffGapMv:-20,raiseStepRaw:100,lowerStepRaw:500,cvBandMv:10,cvRaiseMa:80,cvLowerMa:30,cvWaitMs:500,nowMs:1000};
  assert.equal(policy.computeCvStep({targetRaw:4000},4548000,p).targetRaw,4000);
  const down=policy.computeCvStep({targetRaw:4000},4551000,p);assert.deepEqual(down,{targetRaw:3970,nextAdjustMs:1500});
  const up=policy.computeCvStep({targetRaw:4000},4510000,p);assert.deepEqual(up,{targetRaw:4080,nextAdjustMs:1500});
  assert.equal(policy.computeCvStep({targetRaw:4000},4510000,{...p,raiseStepRaw:20}).targetRaw,4020);
  assert.ok(policy.computeCvStep(down,4604000,{...p,nowMs:1100,elapsedMs:200}).targetRaw<3970,'硬超限不受软等待限制');
});

test('恒压独立压差支持 -50 到 0，0 时超限规则优先于保持带',()=>{
  const s={targetRaw:4000},p={limitMv:4560,cutoffGapMv:-100,nowMs:1000};
  assert.equal(policy.computeCvStep(s,4520000,{...p,cvOffsetMv:-50}).targetRaw,3900);
  assert.equal(policy.computeCvStep(s,4550000,{...p,cvOffsetMv:0}).targetRaw,4050);
  assert.equal(policy.computeCvStep(s,4560000,{...p,cvOffsetMv:0}).targetRaw,4000);
  assert.equal(policy.computeCvStep(s,4561000,{...p,cvOffsetMv:0}).targetRaw,3900);
});

test('78% 记录的微小越界回放：等待响应，不能在 0.6 秒内把 5700mA 扣到 1000mA',()=>{
  // 只保留导致骤降的电压与相对时间，回放验证决策，不预测修改后的真实电池响应。
  const trace=[[0,4560],[200,4561],[410,4562],[620,4562],[820,4563],[1030,4563],[1230,4487],[1440,4414]];
  let s={targetRaw:5700,nextAdjustMs:664790};const targets=[];
  for(let t=0;t<=1440;t+=60) {
    const mv=trace.filter(p=>p[0]<=t).at(-1)[1];
    s=policy.computeCvStep(s,mv*1000,{limitMv:4560,cvOffsetMv:0,cvLowerMa:100,cvWaitMs:1500,lowerStepRaw:500,intervalMs:50,elapsedMs:60,nowMs:663910+t});
    targets.push(s.targetRaw);
  }
  assert.equal(Math.min(...targets),5600);assert.equal(targets[10],5700);
});

test('恒压轻微越界只走一个设定步进，不补偿迟到周期；明显超限、传感器异常仍立即处理',()=>{
  const p={limitMv:4560,cvOffsetMv:0,cvBandMv:5,cvLowerMa:100,cvWaitMs:1500,lowerStepRaw:500,intervalMs:50,elapsedMs:600,nowMs:1000};
  let s=policy.computeCvStep({targetRaw:5700},4561000,p);
  assert.deepEqual(s,{targetRaw:5600,nextAdjustMs:2500});
  assert.equal(policy.computeCvStep(s,4563000,{...p,nowMs:1200}).targetRaw,5600);
  assert.equal(policy.computeCvStep(s,4563000,{...p,nowMs:2500}).targetRaw,5500);
  assert.equal(policy.computeCvStep(s,4569000,{...p,nowMs:1200}).targetRaw,5600);
  assert.ok(policy.computeCvStep(s,4570000,{...p,nowMs:1200}).targetRaw<=1000,'达到 +10mV 仍立即按快速分支降流');
  assert.equal(policy.computeCvStep(s,0,{...p,nowMs:1200}).targetRaw,1000);
  assert.equal(policy.computeCvStep(s,4561000,{...p,nowMs:2500,full:true}).targetRaw,5500,'Full 不阻止越界下调');
  assert.equal(policy.computeCvStep(s,4550000,{...p,nowMs:2500,full:true}).targetRaw,5600,'Full 不重新升流');
  assert.equal(policy.computeCvStep({targetRaw:500},4563000,p).targetRaw,500,'不抬高温控的更低目标');
});

test('快速降流压差支持 0–50mV，边界与热调整优先于等待，默认采用当前预设 15mV',()=>{
  const s={targetRaw:5700,nextAdjustMs:2500};
  const p={limitMv:4560,cvOffsetMv:0,lowerStepRaw:500,intervalMs:50,elapsedMs:200,nowMs:1200};
  const next=(mv,gap)=>policy.computeCvStep(s,mv*1000,{...p,cvFastGapMv:gap}).targetRaw;
  assert.equal(next(4574,undefined),5700);assert.equal(next(4575,undefined),3700);
  assert.equal(next(4609,50),5700);assert.equal(next(4610,50),3700);
  assert.equal(next(4584,25),5700);assert.equal(next(4585,25),3700);
  assert.equal(next(4560,0),5700);assert.equal(next(4561,0),3700);
  assert.equal(policy.computeCvStep(s,4609000,{...p,cvFastGapMv:50,nowMs:2500}).targetRaw,5600,'阈值下方仍按 100mA 细调');
  assert.equal(next(4575,NaN),3700);assert.equal(next(0,50),1000,'大压差不能跳过传感器异常');
});

test('零目标压差、2mV 波动与 1.2 秒驱动延迟闭环模型：保持电压而非降流至深谷',()=>{
  const simulate=legacy=>{
    let state={targetRaw:5700},actual=5700;const queue=Array(15).fill(5700),out=[];
    for(let now=80;now<=120000;now+=80) {
      const mv=4390+10*now/120000+actual*.03+2*Math.sin(now/317);
      const p={limitMv:4560,cvOffsetMv:0,cvBandMv:5,cvLowerMa:100,cvRaiseMa:50,cvWaitMs:1500,
        lowerStepRaw:500,intervalMs:50,elapsedMs:80,voteMaxRaw:13500,nowMs:now};
      if(legacy && mv>4560) {
        const next=policy.computeNextStep(state,Math.round(mv*1000),p);
        state={targetRaw:next.targetRaw,nextAdjustMs:next.targetRaw!==state.targetRaw?now+1500:state.nextAdjustMs};
      } else state=policy.computeCvStep(state,Math.round(mv*1000),p);
      queue.push(state.targetRaw);actual+=(queue.shift()-actual)*.2;
      if(now>2000)out.push({mv,vote:state.targetRaw});
    }
    return {min:Math.min(...out.map(x=>x.mv)),max:Math.max(...out.map(x=>x.mv)),
      error:out.reduce((sum,x)=>sum+Math.abs(x.mv-4560),0)/out.length};
  };
  const before=simulate(true),after=simulate(false);
  assert.ok(before.min<4500,JSON.stringify(before));
  assert.ok(after.min>4550 && after.max<4570,JSON.stringify(after));
  assert.ok(after.error<before.error/5,JSON.stringify({before,after}));
});
