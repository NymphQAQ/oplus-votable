import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const original = readFileSync(join(root,'charge-test.sh'),'utf8');

function mk(t) {
  const base=mkdtempSync(join(tmpdir(),'oplus-votable-adaptive-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const data=join(base,'storage');
  const u=join(base,'UFCS_CURR'),v=join(base,'VOOC_CURR'),p=join(base,'PPS_CURR');
  const sys=join(base,'sys/class/oplus_mms');
  const boot=join(base,'boot_id'),uptime=join(base,'uptime');
  for (const d of [data,u,v,p,join(sys,'ufcs'),join(sys,'vooc'),join(sys,'pps')]) {
    mkdirSync(d,{recursive:true});
  }
  const put=(f,val)=>writeFileSync(f,String(val));
  put(join(u,'status'),
    'UFCS_CURR: MAX_VOTER: en=1 v=10900\n'+
    'UFCS_CURR: COOL_DOWN_VOTER: en=1 v=6500\n'+
    'UFCS_CURR: effective=COOL_DOWN_VOTER type=Min v=6500\n');
  for (const dir of [u,v,p]) {
    put(join(dir,'force_active'),'0');
    put(join(dir,'force_val'),'0');
  }
  // 默认仅 UFCS 在线，VOOC 与 PPS 离线。
  put(join(sys,'ufcs/item_id'),'0'); put(join(sys,'ufcs/data'),'1');
  put(join(sys,'vooc/item_id'),'0'); put(join(sys,'vooc/data'),'0');
  put(join(sys,'pps/item_id'),'0');  put(join(sys,'pps/data'),'0');
  put(boot,'12345678-1234-1234-1234-123456789012');
  put(uptime,'101.24 202.55');
  const volt=join(base,'battery_voltage');
  put(volt,'4520000');
  const temp=join(base,'battery_temp');
  put(temp,'340');
  let code=original;
  const replacements=[
    ["/data/adb/oplus-votable",data],
    ["/proc/oplus-votable/UFCS_CURR",u],
    ["/proc/oplus-votable/VOOC_CURR",v],
    ["/proc/oplus-votable/PPS_CURR",p],
    ["/sys/class/oplus_mms/",sys+'/'],
    ["/sys/class/power_supply/battery/voltage_now",volt],
    ["/sys/class/power_supply/battery/temp",temp],
    ["/proc/sys/kernel/random/boot_id",boot],
    ["/proc/uptime",uptime],
  ];
  for (const [a,b] of replacements) code=code.split(a).join(b);
  const shell=join(base,'charge-test.sh');
  put(shell,code);
  const env={...process.env};
  return {base,data,u,v,p,sys,shell,env,volt,temp,uptime};
}

function command(f,...args) {
  return spawnSync('sh',[f.shell,...args],{encoding:'utf8',env:f.env,timeout:20000});
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function waitFor(check,label,attempts=80) {
  for (let i=0;i<attempts;i++) {
    if (check()) return;
    await sleep(100);
  }
  assert.fail('等待超时：'+label);
}
function onceExit(child) {
  if (child.exitCode!==null || child.signalCode!==null) return Promise.resolve();
  return new Promise(resolve=>child.once('exit',resolve));
}
function startDaemon(t,f) {
  const child=spawn('sh',[f.shell,'--control-run'],{env:f.env,stdio:'ignore',detached:false});
  t.after(async()=>{ try { child.kill('SIGKILL'); } catch {} await onceExit(child); });
  return child;
}
const leasePath = f => join(f.data,'active-test.lease');
const statusOf = f => command(f,'--status').stdout;
const readEvents = f => { try { return readFileSync(join(f.data,'events.log'),'utf8'); } catch { return ''; } };
function liveGet(f,key) {
  let raw;
  try { raw=readFileSync(join(f.data,'auto-live'),'utf8'); } catch { return ''; }
  const m=new RegExp('^'+key+'=(.*)$','m').exec(raw);
  return m?m[1].trim():'';
}
function field(raw,key) {
  const m=new RegExp(key+'=(\\d+)').exec(raw);
  return m?Number(m[1]):NaN;
}
const online=(f,proto,on)=>writeFileSync(join(f.sys,proto,'data'),on?'1':'0');
function sampleTemperature(f,value) {
  writeFileSync(f.temp,String(value));
  const tick=Math.floor(Number(readFileSync(f.uptime,'utf8').split(' ')[0]))+1;
  writeFileSync(f.uptime,tick+'.24 202.55');
}

test('温控默认关闭，三项设置校验边界、原子保存、重读保留，坏配置回落默认',t=>{
  const f=mk(t);
  let st=command(f,'--thermal-status').stdout;
  assert.match(st,/THERMAL_ENABLED=NO;THERMAL_LIMIT_C=45;THERMAL_VOTE_MA=1000;THERMAL_GAP_C=2/);
  assert.match(st,/THERMAL_TEMP_DECI=340;THERMAL_STATE=OFF/);
  for (const [arg,values,key,file] of [
    ['limit',[20,45,60],'THERMAL_LIMIT_C','thermal-limit-c'],
    ['vote',[500,1000,5000],'THERMAL_VOTE_MA','thermal-vote-ma'],
    ['gap',[1,2,5],'THERMAL_GAP_C','thermal-gap-c'],
  ]) {
    for(const value of values) {
      const result=command(f,'--thermal-'+arg+'-set',String(value));
      assert.equal(result.status,0,result.stderr);
      assert.match(statusOf(f),new RegExp(key+'='+value+';'));
      assert.equal(readFileSync(join(f.data,'auto-control.'+file),'utf8').trim(),String(value));
    }
    for(const value of [values[0]-1,values[2]+1,'1.5','abc','$(touch nope)','045','9999999999999999']) {
      assert.equal(command(f,'--thermal-'+arg+'-set',String(value)).status,2);
    }
    assert.match(statusOf(f),new RegExp(key+'='+values[2]+';'));
    writeFileSync(join(f.data,'auto-control.'+file),'garbage');
    assert.match(statusOf(f),new RegExp(key+'='+values[1]+';'));
  }
  assert.equal(command(f,'--thermal-enable').status,0);
  assert.match(command(f,'--thermal-status').stdout,/THERMAL_ENABLED=YES/);
  assert.equal(command(f,'--thermal-disable').status,0);
  assert.match(command(f,'--thermal-status').stdout,/THERMAL_ENABLED=NO/);
  assert.equal(existsSync(leasePath(f)),false,'修改温控设置不能绕过监测总开关自行接管');
  assert.equal(readdirSync(f.data).some(name=>name.includes('.tmp.')),false);
});

test('UFCS/PPS 超温首次接管即受 500mA 限制，低电压也不能重新升流',async t=>{
  for(const proto of ['ufcs','pps']) {
    const f=mk(t);
    online(f,'ufcs',proto==='ufcs'); online(f,'pps',proto==='pps');
    command(f,'--thermal-enable'); command(f,'--thermal-vote-set','500');
    command(f,'--vote-initial-set','9000');
    writeFileSync(f.volt,'4400000'); sampleTemperature(f,450);
    startDaemon(t,f);
    const node=proto==='ufcs'?f.u:f.p;
    await waitFor(()=>readFileSync(join(node,'force_val'),'utf8')==='500' && liveGet(f,'REASON')==='THERMAL_LIMITED','超温起步限制');
    await sleep(450);
    assert.equal(readFileSync(join(node,'force_val'),'utf8'),'500');
    assert.match(readEvents(f),/START_ADAPTIVE_500/);
    assert.doesNotMatch(readEvents(f),/START_ADAPTIVE_9000/);
    assert.match(command(f,'--thermal-status').stdout,/THERMAL_STATE=LIMITED;THERMAL_ACTIVE=YES/);
    assert.equal(readFileSync(f.temp,'utf8'),'450','温控不能改写温度节点');
  }
});

test('运行中超温立即限流，恢复温差 5°C/1°C 边界生效，降温后按步进恢复',async t=>{
  const f=mk(t);
  command(f,'--thermal-enable'); command(f,'--thermal-vote-set','500');
  command(f,'--thermal-gap-set','5'); command(f,'--vote-initial-set','3000');
  command(f,'--raise-step-set','10'); command(f,'--interval-set','200');
  startDaemon(t,f);
  await waitFor(()=>liveGet(f,'THERMAL_STATE')==='NORMAL' && liveGet(f,'TARGET')==='3000','正常起步');
  sampleTemperature(f,450);
  await waitFor(()=>liveGet(f,'THERMAL_STATE')==='LIMITED' && liveGet(f,'TARGET')==='500','达到温度上限');
  sampleTemperature(f,401);
  await sleep(450);
  assert.equal(liveGet(f,'THERMAL_STATE'),'LIMITED','尚未降到 40°C');
  writeFileSync(f.volt,'4400000'); sampleTemperature(f,400);
  await waitFor(()=>liveGet(f,'THERMAL_STATE')==='NORMAL' && Number(liveGet(f,'TARGET'))>500,'40°C 边界解除并爬坡');
  assert.ok(Number(liveGet(f,'TARGET'))<1000,'不能由 500mA 瞬间跳回普通下限');
  sampleTemperature(f,450);
  await waitFor(()=>liveGet(f,'THERMAL_STATE')==='LIMITED','再次超温');
  command(f,'--thermal-gap-set','1'); sampleTemperature(f,441);
  await sleep(450);
  assert.equal(liveGet(f,'THERMAL_STATE'),'LIMITED');
  sampleTemperature(f,440);
  await waitFor(()=>liveGet(f,'THERMAL_STATE')==='NORMAL','44°C 边界解除');
});

test('读温失败最多投票 1000mA，错误值不当作低温，正常且充分降温才恢复',async t=>{
  const f=mk(t);
  command(f,'--thermal-enable'); command(f,'--thermal-vote-set','5000');
  command(f,'--vote-initial-set','9000');
  writeFileSync(f.volt,'4400000'); sampleTemperature(f,'UNKNOWN');
  startDaemon(t,f);
  await waitFor(()=>liveGet(f,'THERMAL_STATE')==='SENSOR_ERROR' && liveGet(f,'TARGET')==='1000','无效温度保守起步');
  for(const invalid of ['',1501,-501]) {
    sampleTemperature(f,invalid);
    await sleep(250);
    assert.equal(liveGet(f,'THERMAL_STATE'),'SENSOR_ERROR');
    assert.equal(liveGet(f,'TARGET'),'1000');
  }
  sampleTemperature(f,440);
  await waitFor(()=>liveGet(f,'THERMAL_STATE')==='LIMITED','传感器恢复但未充分降温');
  assert.equal(liveGet(f,'TARGET'),'1000','不能因配置限流 5000 而升高故障期间目标');
  sampleTemperature(f,430);
  await waitFor(()=>liveGet(f,'THERMAL_STATE')==='NORMAL' && Number(liveGet(f,'TARGET'))>1000,'降到恢复点');
  command(f,'--thermal-disable'); sampleTemperature(f,'bad');
  await waitFor(()=>liveGet(f,'THERMAL_STATE')==='OFF','关闭温控恢复原行为');
});

test('温控不会抬高更低目标或突破协议上限，协议切换和守护重启保留已触发限制',async t=>{
  const f=mk(t);
  command(f,'--thermal-enable'); command(f,'--thermal-vote-set','5000');
  command(f,'--vote-max-set','ufcs','2000'); command(f,'--vote-initial-set','9000');
  sampleTemperature(f,450);
  const first=startDaemon(t,f);
  await waitFor(()=>liveGet(f,'TARGET')==='2000','协议上限优先');
  command(f,'--thermal-vote-set','500');
  await waitFor(()=>liveGet(f,'TARGET')==='500','运行中调低限流值');
  sampleTemperature(f,440);
  online(f,'ufcs',false); online(f,'pps',true);
  await waitFor(()=>liveGet(f,'PROTO')==='pps' && liveGet(f,'TARGET')==='500','协议切换仍限流');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'0');
  first.kill('SIGKILL'); await onceExit(first);
  const second=startDaemon(t,f);
  await waitFor(()=>readFileSync(leasePath(f),'utf8').split(' ')[2]===String(second.pid) && liveGet(f,'REASON')==='THERMAL_LIMITED' && readFileSync(join(f.p,'force_val'),'utf8')==='500','恢复温差内重启保持限制');
  command(f,'--thermal-vote-set','5000');
  await sleep(300);
  assert.equal(liveGet(f,'TARGET'),'500','限流上限调高不能主动升流');
  writeFileSync(join(f.data,'auto-control.monitor'),'off');
  await waitFor(()=>readFileSync(join(f.p,'force_active'),'utf8')==='0','关闭监测撤销接管');
  assert.match(command(f,'--thermal-status').stdout,/THERMAL_STATE=IDLE;THERMAL_ACTIVE=NO/);
});

test('--status 未接管时报告 STOPPED、总开关默认开、UFCS/PPS 默认开与各自默认参数',t=>{
  const f=mk(t);
  const r=command(f,'--status');
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stdout.trim().split('\n').length,1);
  assert.match(r.stdout,/CONTROL_STATE=STOPPED/);
  assert.match(r.stdout,/MONITOR_ENABLED=YES/);
  assert.match(r.stdout,/ACTIVE_PROTOCOL=NONE/);
  assert.match(r.stdout,/ONLINE_PROTOCOL=UFCS/);
  for (const k of ['UFCS','PPS']) {
    assert.match(r.stdout,new RegExp(k+'_ENABLED=YES'));
    assert.match(r.stdout,new RegExp(k+'_LIMIT_MV='+(k==='PPS'?'4500':'4560')));
    assert.match(r.stdout,new RegExp(k+'_VOTE_MAX='+(k==='PPS'?'5000':'9000')));
  }
  assert.doesNotMatch(r.stdout,/VOOC_ENABLED|VOOC_VOTE_MAX|VOOC_LIMIT_MV/);
  assert.match(r.stdout,/VOTE_INITIAL=1000/);
  assert.match(r.stdout,/INTERVAL_MS=100/);
  assert.match(r.stdout,/RAISE_STEP=100/);
  assert.match(r.stdout,/LOWER_STEP=500/);
  assert.match(r.stdout,/CUTOFF_GAP_MV=-50/);
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'0');
  assert.equal(existsSync(leasePath(f)),false);
});

test('升级时撤销旧温度写入开关，保留现有协议配置；不向温度节点写值',t=>{
  const f=mk(t);
  const enabled=join(f.data,'temperature.enabled');
  const saved=join(f.data,'auto-control.ufcs.vote-max');
  writeFileSync(enabled,'');
  writeFileSync(saved,'7000');
  const code=readFileSync(join(root,'customize.sh'),'utf8').replaceAll('/data/adb/oplus-votable',f.data);
  const result=spawnSync('sh',['-c',code],{encoding:'utf8',timeout:3000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(existsSync(enabled),false);
  assert.equal(readFileSync(saved,'utf8'),'7000');
  assert.doesNotMatch(code,/\/proc\/shell-temp|34326/);
  assert.equal(command(f,'--status').status,0);
});

test('默认监测开：UFCS 在线即自动接管并写入初始 1000',async t=>{
  const f=mk(t);
  startDaemon(t,f);
  await waitFor(()=>existsSync(leasePath(f))&&readFileSync(join(f.u,'force_active'),'utf8')==='1','自动接管');
  assert.equal(readFileSync(join(f.u,'force_val'),'utf8'),'1000');
  assert.equal(readFileSync(leasePath(f),'utf8').trim().split(' ')[3],'1000');
  assert.equal(readFileSync(leasePath(f),'utf8').trim().split(' ')[4],'ufcs');
  const st=statusOf(f);
  assert.match(st,/CONTROL_STATE=RUNNING/);
  assert.match(st,/TARGET_RAW=1000/);
  assert.match(st,/ACTIVE_PROTOCOL=UFCS/);
  assert.match(st,/MONITOR_ENABLED=YES/);
  assert.match(readEvents(f),/state=CONTROL_START_ADAPTIVE_1000/);
  assert.equal(liveGet(f,'PHASE'),'RUNNING');
  assert.equal(liveGet(f,'PROTO'),'ufcs');
  assert.equal(liveGet(f,'REASON'),'STARTED');
});

test('电压低于 设定值-50mV：投票目标每次 +100 爬坡',async t=>{
  const f=mk(t);
  writeFileSync(f.volt,'4400000');
  startDaemon(t,f);
  await waitFor(()=>existsSync(leasePath(f)),'接管');
  await waitFor(()=>Number(readFileSync(join(f.u,'force_val'),'utf8'))>=1200,'目标爬坡');
  const target=field(statusOf(f),'TARGET_RAW');
  assert.ok(target>1000,target);
  assert.ok(target<=9000,target);
});

test('电压超过设定值：按默认降低步进 500 回落',async t=>{
  const f=mk(t);
  writeFileSync(f.volt,'4400000');
  startDaemon(t,f);
  await waitFor(()=>existsSync(leasePath(f)),'接管');
  await waitFor(()=>Number(readFileSync(join(f.u,'force_val'),'utf8'))>=1300,'先爬坡');
  const peak=Number(readFileSync(join(f.u,'force_val'),'utf8'));
  writeFileSync(f.volt,'4600000');
  await waitFor(()=>Number(readFileSync(join(f.u,'force_val'),'utf8'))<peak,'超压回落');
  const target=field(statusOf(f),'TARGET_RAW');
  assert.ok(target<peak,target+' !< '+peak);
  assert.ok(target>=1000,target);
});

test('持续超压：投票值降到下限 1000 后不再下降',async t=>{
  const f=mk(t);
  writeFileSync(f.volt,'4400000');
  startDaemon(t,f);
  await waitFor(()=>existsSync(leasePath(f)),'接管');
  await waitFor(()=>Number(readFileSync(join(f.u,'force_val'),'utf8'))>=1200,'先爬坡');
  writeFileSync(f.volt,'4700000');
  await waitFor(()=>readFileSync(join(f.u,'force_val'),'utf8')==='1000','降到下限',120);
  await sleep(600);
  assert.equal(readFileSync(join(f.u,'force_val'),'utf8'),'1000');
  assert.match(statusOf(f),/TARGET_RAW=1000/);
});

test('--limit-set 按协议校验并持久化设定电压，互不影响',async t=>{
  const f=mk(t);
  const ok=command(f,'--limit-set','ufcs','4000');
  assert.equal(ok.status,0,ok.stderr);
  assert.match(ok.stdout,/LIMIT_MV=UFCS:4000/);
  assert.match(statusOf(f),/UFCS_LIMIT_MV=4000/);
  assert.match(statusOf(f),/PPS_LIMIT_MV=4500/);
  assert.equal(command(f,'--limit-set','pps','3900').status,0);
  assert.match(statusOf(f),/PPS_LIMIT_MV=3900/);
  assert.match(statusOf(f),/UFCS_LIMIT_MV=4000/);
  assert.equal(command(f,'--limit-set','vooc','3900').status,2);
  assert.equal(command(f,'--limit-set','pps','3700').status,2);
  assert.equal(command(f,'--limit-set','ufcs','4600').status,2);
  assert.equal(command(f,'--limit-set','ufcs','abc').status,2);
  assert.equal(command(f,'--limit-set','bogus','4000').status,2);
  assert.match(statusOf(f),/UFCS_LIMIT_MV=4000/);
});

test('--vote-max-set 按协议校验并持久化投票值上限',async t=>{
  const f=mk(t);
  const ok=command(f,'--vote-max-set','ufcs','12000');
  assert.equal(ok.status,0,ok.stderr);
  assert.match(ok.stdout,/VOTE_MAX=UFCS:12000/);
  assert.match(statusOf(f),/UFCS_VOTE_MAX=12000/);
  assert.match(statusOf(f),/PPS_VOTE_MAX=5000/);
  assert.equal(command(f,'--vote-max-set','pps','5800').status,0);
  assert.equal(command(f,'--vote-max-set','pps','5850').status,2);
  assert.equal(command(f,'--vote-max-set','vooc','5800').status,2);
  assert.equal(command(f,'--vote-max-set','ufcs','900').status,2);
  assert.equal(command(f,'--vote-max-set','ufcs','14000').status,2);
  assert.equal(command(f,'--vote-max-set','ufcs','abc').status,2);
  assert.match(statusOf(f),/UFCS_VOTE_MAX=12000/);
});

test('投票值上限生效：爬坡停在上限，上限下调后立即收敛',async t=>{
  const f=mk(t);
  command(f,'--vote-max-set','ufcs','1100');
  writeFileSync(f.volt,'4400000');
  startDaemon(t,f);
  await waitFor(()=>readFileSync(join(f.u,'force_val'),'utf8')==='1100','爬到上限');
  await sleep(500);
  assert.equal(readFileSync(join(f.u,'force_val'),'utf8'),'1100');
  command(f,'--vote-max-set','ufcs','1000');
  await waitFor(()=>readFileSync(join(f.u,'force_val'),'utf8')==='1000','上限下调收敛');
  assert.match(statusOf(f),/TARGET_RAW=1000/);
});

test('设定电压生效：更低的设定值把原本会升流的电压判为超压',async t=>{
  const f=mk(t);
  command(f,'--limit-set','ufcs','4000');
  writeFileSync(f.volt,'4100000');
  startDaemon(t,f);
  await waitFor(()=>existsSync(leasePath(f)),'接管');
  await sleep(800);
  assert.equal(readFileSync(join(f.u,'force_val'),'utf8'),'1000');
});

test('VOOC 在线时只报告协议，不创建租约或主动写入 VOOC_CURR',async t=>{
  const f=mk(t);
  online(f,'ufcs',false);
  online(f,'vooc',true);
  const child=startDaemon(t,f);
  await waitFor(()=>liveGet(f,'REASON')==='UNSUPPORTED_PROTOCOL','VOOC 未支持阶段');
  assert.equal(existsSync(leasePath(f)),false);
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'0');
  assert.equal(readFileSync(join(f.v,'force_active'),'utf8'),'0');
  assert.equal(readFileSync(join(f.v,'force_val'),'utf8'),'0');
  const st=statusOf(f);
  assert.match(st,/ACTIVE_PROTOCOL=NONE/);
  assert.match(st,/ONLINE_PROTOCOL=VOOC/);
  assert.equal(child.exitCode,null);
});

test('PPS 默认投票上限 5000，过高初始值不会瞬时超限',async t=>{
  const f=mk(t);
  online(f,'ufcs',false);
  online(f,'pps',true);
  assert.equal(command(f,'--vote-initial-set','7500').status,0);
  startDaemon(t,f);
  await waitFor(()=>existsSync(leasePath(f)) &&
    readFileSync(join(f.p,'force_active'),'utf8')==='1','PPS 接管');
  assert.equal(readFileSync(join(f.p,'force_val'),'utf8'),'5000');
  assert.equal(readFileSync(leasePath(f),'utf8').trim().split(' ')[3],'5000');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'0');
  assert.equal(readFileSync(join(f.v,'force_active'),'utf8'),'0');
  assert.match(statusOf(f),/ACTIVE_PROTOCOL=PPS/);
  assert.match(statusOf(f),/PPS_VOTE_MAX=5000/);
});

test('PPS 历史配置低于 5800 原值保留，高于 5800 只在运行时钳制',t=>{
  const f=mk(t);
  const path=join(f.data,'auto-control.pps.vote-max');
  writeFileSync(path,'4250');
  assert.match(statusOf(f),/PPS_VOTE_MAX=4250/);
  assert.equal(readFileSync(path,'utf8'),'4250');
  writeFileSync(path,'10700');
  assert.match(statusOf(f),/PPS_VOTE_MAX=5800/);
  assert.equal(readFileSync(path,'utf8'),'10700');
  assert.equal(command(f,'--vote-max-set','pps','6000').status,2);
  assert.equal(command(f,'--proto-enable','vooc').status,2);
  assert.equal(command(f,'--proto-disable','vooc').status,2);
});

test('旧 VOOC 租约只允许安全回收，不再创建新的 VOOC 强制投票',t=>{
  const f=mk(t);
  writeFileSync(join(f.v,'force_val'),'7500');
  writeFileSync(join(f.v,'force_active'),'1');
  writeFileSync(leasePath(f),
    '12345678-1234-1234-1234-123456789012 100 999999 7500 vooc\n');
  const result=command(f,'--recover');
  assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(join(f.v,'force_active'),'utf8'),'0');
  assert.equal(existsSync(leasePath(f)),false);
});

test('协议开关关闭：在线协议不被接管，阶段为 PROTOCOL_DISABLED',async t=>{
  const f=mk(t);
  writeFileSync(join(f.data,'auto-control.ufcs.enabled'),'off');
  const child=startDaemon(t,f);
  await waitFor(()=>liveGet(f,'REASON')==='PROTOCOL_DISABLED','协议关闭阶段');
  assert.equal(existsSync(leasePath(f)),false);
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'0');
  assert.match(statusOf(f),/UFCS_ENABLED=NO/);
  assert.equal(child.exitCode,null,'守护必须继续存活');
});

test('UFCS 与 VOOC 同时在线：为避免误操作不接管，阶段为 PROTOCOL_CONFLICT',async t=>{
  const f=mk(t);
  online(f,'vooc',true);
  startDaemon(t,f);
  await waitFor(()=>liveGet(f,'REASON')==='PROTOCOL_CONFLICT','协议冲突阶段');
  assert.equal(existsSync(leasePath(f)),false);
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'0');
  assert.equal(readFileSync(join(f.v,'force_active'),'utf8'),'0');
});

test('协议变化：立即撤销限流但监测继续，恢复 UFCS 后自动重新接管',async t=>{
  const f=mk(t);
  const child=startDaemon(t,f);
  const active=join(f.u,'force_active');
  await waitFor(()=>existsSync(leasePath(f))&&readFileSync(active,'utf8')==='1','初始接管');
  online(f,'ufcs',false);
  await waitFor(()=>/state=CONTROL_FINISHED_PROTOCOL_CHANGED/.test(readEvents(f)),'协议变化日志');
  await waitFor(()=>!existsSync(leasePath(f)),'协议变化后撤销租约');
  await waitFor(()=>readFileSync(active,'utf8')==='0','撤销强制状态');
  assert.equal(child.exitCode,null,'守护必须继续存活');
  online(f,'ufcs',true);
  await waitFor(()=>existsSync(leasePath(f))&&readFileSync(active,'utf8')==='1','协议恢复后重新接管');
  assert.match(statusOf(f),/ACTIVE_PROTOCOL=UFCS/);
});

test('--proto-disable 关闭协议后撤销限流，守护继续等待',async t=>{
  const f=mk(t);
  const child=startDaemon(t,f);
  await waitFor(()=>existsSync(leasePath(f))&&readFileSync(join(f.u,'force_active'),'utf8')==='1','初始接管');
  const r=command(f,'--proto-disable','ufcs');
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/PROTO_DISABLED=UFCS/);
  await waitFor(()=>!existsSync(leasePath(f)),'关闭协议后撤销');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'0');
  assert.match(readEvents(f),/state=CONTROL_FINISHED_PROTOCOL_DISABLED/);
  assert.equal(child.exitCode,null,'守护必须继续存活');
  assert.equal(liveGet(f,'REASON'),'PROTOCOL_DISABLED');
});

test('高级参数：逐项校验、持久化并反映在状态与算法中',async t=>{
  const f=mk(t);
  assert.equal(command(f,'--vote-initial-set','5000').status,0);
  assert.equal(command(f,'--interval-set','50').status,0);
  assert.equal(command(f,'--raise-step-set','200').status,0);
  assert.equal(command(f,'--lower-step-set','150').status,0);
  assert.equal(command(f,'--cutoff-gap-set','-80').status,0);
  const st=statusOf(f);
  assert.match(st,/VOTE_INITIAL=5000/);
  assert.match(st,/INTERVAL_MS=50/);
  assert.match(st,/RAISE_STEP=200/);
  assert.match(st,/LOWER_STEP=150/);
  assert.match(st,/CUTOFF_GAP_MV=-80/);
  assert.equal(command(f,'--vote-initial-set','500').status,2);
  assert.equal(command(f,'--vote-initial-set','20000').status,2);
  assert.equal(command(f,'--interval-set','10').status,2);
  assert.equal(command(f,'--interval-set','300').status,2);
  assert.equal(command(f,'--raise-step-set','5').status,2);
  assert.equal(command(f,'--lower-step-set','2000').status,2);
  assert.equal(command(f,'--cutoff-gap-set','1').status,2);
  assert.equal(command(f,'--cutoff-gap-set','-101').status,2);
  assert.match(statusOf(f),/VOTE_INITIAL=5000/);
});

test('高级电流设置分别持久化，重新启动查询后原值仍在，且没有临时文件残留',t=>{
  const f=mk(t);
  const params=[
    ['--vote-initial-set','4200','auto-control.vote-initial','VOTE_INITIAL'],
    ['--interval-set','90','auto-control.interval-ms','INTERVAL_MS'],
    ['--raise-step-set','180','auto-control.raise-step','RAISE_STEP'],
    ['--lower-step-set','170','auto-control.lower-step','LOWER_STEP'],
    ['--cutoff-gap-set','-60','auto-control.cutoff-gap-mv','CUTOFF_GAP_MV'],
  ];
  for(const [option,value,file,key] of params) {
    const result=command(f,option,value);
    assert.equal(result.status,0,result.stderr);
    assert.equal(readFileSync(join(f.data,file),'utf8').trim(),value);
    assert.match(statusOf(f),new RegExp(key+'='+value+'(?:;|\\n)'));
  }
  // 后续调用全新 shell 进程，模拟重开 WebUI/模块更新后的加载。
  const reload=command(f,'--status');
  assert.equal(reload.status,0,reload.stderr);
  for(const [,value,,key] of params) {
    assert.match(reload.stdout,new RegExp(key+'='+value+'(?:;|\\n)'));
  }
  assert.equal(readdirSync(f.data).some(name=>name.includes('.tmp.')),false);
});

test('步进范围分别校验，旧有效配置保留，旧越界配置使用默认值',t=>{
  const f=mk(t);
  for (const [option,values,key] of [
    ['--raise-step-set',[10,100,500],'RAISE_STEP'],
    ['--lower-step-set',[100,500,1000],'LOWER_STEP'],
  ]) {
    for (const value of values) {
      const result=command(f,option,String(value));
      assert.equal(result.status,0,result.stderr);
      assert.match(statusOf(f),new RegExp(key+'='+value+'(?:;|\\n)'));
    }
  }
  for (const [option,value] of [
    ['--raise-step-set','9'],['--raise-step-set','501'],
    ['--lower-step-set','99'],['--lower-step-set','1001'],
  ]) assert.equal(command(f,option,value).status,2);
  assert.match(statusOf(f),/RAISE_STEP=500;LOWER_STEP=1000;/);
  const raise=join(f.data,'auto-control.raise-step');
  const lower=join(f.data,'auto-control.lower-step');
  writeFileSync(raise,'180');
  writeFileSync(lower,'100');
  assert.match(statusOf(f),/RAISE_STEP=180;LOWER_STEP=100;/);
  writeFileSync(raise,'1000');
  writeFileSync(lower,'70');
  assert.match(statusOf(f),/RAISE_STEP=100;LOWER_STEP=500;/);
  assert.equal(readFileSync(raise,'utf8'),'1000');
  assert.equal(readFileSync(lower,'utf8'),'70');
});

test('高级参数生效：投票初始值起步、升流截止压差改变停止升流点',async t=>{
  const f=mk(t);
  command(f,'--vote-initial-set','3000');
  command(f,'--cutoff-gap-set','0');
  writeFileSync(f.volt,'4500000');
  startDaemon(t,f);
  // 截止压差 0 时，只有电压 < 4560000 才升流；4500000 会持续爬坡，故先确认起步 3000。
  await waitFor(()=>existsSync(leasePath(f)),'接管');
  assert.equal(readFileSync(leasePath(f),'utf8').trim().split(' ')[3],'3000');
  await waitFor(()=>Number(readFileSync(join(f.u,'force_val'),'utf8'))>3000,'按初始值起步后爬坡');
});

test('监测关闭：守护不常驻且不接管内核',async t=>{
  const f=mk(t);
  writeFileSync(join(f.data,'auto-control.monitor'),'off');
  const child=spawn('sh',[f.shell,'--control-run'],{env:f.env,stdio:'ignore'});
  await onceExit(child);
  assert.equal(child.exitCode,0);
  assert.equal(existsSync(leasePath(f)),false);
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'0');
  assert.equal(liveGet(f,'REASON'),'MONITOR_OFF');
});

test('--monitor-disable：撤销限流并退出守护',async t=>{
  const f=mk(t);
  const child=spawn('sh',[f.shell,'--control-run'],{env:f.env,stdio:'ignore'});
  await waitFor(()=>existsSync(leasePath(f))&&readFileSync(join(f.u,'force_active'),'utf8')==='1','初始接管');
  const r=command(f,'--monitor-disable');
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/MONITOR=OFF/);
  await waitFor(()=>!existsSync(leasePath(f)),'关闭监测后撤销');
  await onceExit(child);
  assert.equal(child.exitCode,0);
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'0');
  assert.match(readEvents(f),/state=CONTROL_FINISHED_MONITOR_DISABLED/);
});

test('--monitor-ensure：默认监测开时拉起常驻守护并接管',async t=>{
  const f=mk(t);
  let pid=0;
  t.after(()=>{ if (pid) { try { process.kill(pid,'SIGKILL'); } catch { /* 已退出 */ } } });
  const r=command(f,'--monitor-ensure');
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/MONITOR=ON/);
  await waitFor(()=>existsSync(leasePath(f))&&readFileSync(join(f.u,'force_active'),'utf8')==='1','拉起守护并接管');
  pid=Number(readFileSync(leasePath(f),'utf8').trim().split(' ')[2]);
  command(f,'--monitor-disable');
  await sleep(400);
});

test('模拟守护被 SIGKILL：租约保留，--recover 撤销残留强制状态',async t=>{
  const f=mk(t);
  const child=spawn('sh',[f.shell,'--control-run'],{env:f.env,stdio:'ignore'});
  const active=join(f.u,'force_active');
  await waitFor(()=>existsSync(leasePath(f))&&readFileSync(active,'utf8')==='1','初始接管');
  child.kill('SIGKILL');
  await onceExit(child);
  assert.equal(existsSync(leasePath(f)),true);
  assert.match(statusOf(f),/CONTROL_STATE=RECOVERY_REQUIRED/);
  const r=command(f,'--recover');
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/GUARDIAN_RECOVERY_REQUESTED/);
  assert.equal(readFileSync(active,'utf8'),'0');
  assert.equal(existsSync(leasePath(f)),false);
});

test('未知命令返回用法并以退出码 2 结束',t=>{
  const f=mk(t);
  const r=command(f,'--diagnose');
  assert.equal(r.status,2);
  assert.match(r.stderr,/USAGE:/);
});
