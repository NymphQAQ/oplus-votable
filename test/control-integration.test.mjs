import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, chmodSync } from 'node:fs';
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
  const capacity=join(base,'battery_capacity');
  put(capacity,'50');
  const shellTemp=join(base,'shell-temp');
  put(shellTemp,'0 34000\n1 34000\n2 34000\n');
  const mmi=join(base,'mmi_charging_enable'),usbOnline=join(base,'usb_online');
  put(mmi,'1');put(usbOnline,'1');
  let code=original;
  const replacements=[
    ["/data/adb/oplus-votable",data],
    ["/proc/oplus-votable/UFCS_CURR",u],
    ["/proc/oplus-votable/VOOC_CURR",v],
    ["/proc/oplus-votable/PPS_CURR",p],
    ["/sys/class/oplus_mms/",sys+'/'],
    ["/sys/class/power_supply/battery/voltage_now",volt],
    ["/sys/class/power_supply/battery/temp",temp],
    ["/sys/class/power_supply/battery/capacity",capacity],
    ["/proc/sys/kernel/random/boot_id",boot],
    ["/proc/uptime",uptime],
    ["/proc/shell-temp",shellTemp],
    ["/sys/devices/virtual/oplus_chg/battery/mmi_charging_enable",mmi],
    ["/sys/class/power_supply/usb/online",usbOnline],
  ];
  for (const [a,b] of replacements) code=code.split(a).join(b);
  const shell=join(base,'charge-test.sh');
  put(shell,code);
  const bin=join(base,'bin'),horaeLog=join(base,'horae.log');
  mkdirSync(bin);
  put(join(bin,'timeout'),'#!/bin/sh\n[ "$1" = 3 ] || exit 99\nshift\nexec "$@"\n');
  put(join(bin,'dumpsys'),'#!/bin/sh\nif [ "$*" = horae ]; then printf "Temp:36.00\\n"; if [ "${HORAETEST_STUCK:-0}" = 1 ] && [ ! -f "$HORAETEST_RESTARTED" ]; then printf "TestModeShellTemp:33000\\n"; fi; exit 0; fi\nprintf "%s\\n" "$*" >> "$HORAETEST_LOG"\n[ "$*" = "horae testmode" ] || [ "$*" = "horae testmode false" ] || exit 98\n[ "${HORAETEST_EXIT:-0}" = 0 ] || exit "$HORAETEST_EXIT"\nif [ "$*" = "horae testmode" ]; then chmod 0644 "$HORAETEST_NODE"; printf reset > "$HORAETEST_NODE"; fi\n');
  put(join(bin,'getprop'),'#!/bin/sh\n[ "$*" = init.svc.horae ] || exit 98\nprintf running\n');
  put(join(bin,'setprop'),'#!/bin/sh\n[ "$*" = "ctl.restart horae" ] || exit 98\n[ "${HORAETEST_RESTART_FAIL:-0}" = 0 ] || exit 1\nprintf restarted > "$HORAETEST_RESTARTED"\n');
  for(const name of ['timeout','dumpsys','getprop','setprop']) chmodSync(join(bin,name),0o755);
  const env={...process.env,PATH:bin+':'+process.env.PATH,HORAETEST_LOG:horaeLog,HORAETEST_NODE:shellTemp,HORAETEST_RESTARTED:join(base,'horae-restarted')};
  return {base,data,u,v,p,sys,shell,env,volt,temp,uptime,shellTemp,capacity,horaeLog,mmi,usbOnline};
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
// 权限位（八进制）用于校验温度伪装是否已将节点设为只读。
const modeOf=path=>(statSync(path).mode & 0o777).toString(8).padStart(3,'0');
function sampleTemperature(f,value) {
  writeFileSync(f.temp,String(value));
  const tick=Math.floor(Number(readFileSync(f.uptime,'utf8').split(' ')[0]))+1;
  writeFileSync(f.uptime,tick+'.24 202.55');
}
const clockAt=(f,ms)=>writeFileSync(f.uptime,(ms/1000).toFixed(3)+' 202.55');

test('间断充电默认关闭，时间设置校验边界并保存，支持多个独立电量区间',t=>{
  const f=mk(t);
  assert.match(command(f,'--pulse-status').stdout,/PULSE_ENABLED=NO;PULSE_CHARGE_S=5;PULSE_PAUSE_MS=1000;PULSE_RANGES=NONE/);
  for(const [field,valid,invalid] of [['charge',[1,5,1200],[0,1201,-1,'1.5','abc']],['pause',[0,1000,60000],[-1,60001,'1.5','$(touch nope)']]]) {
    for(const value of valid) assert.equal(command(f,'--pulse-'+field+'-set',String(value)).status,0);
    for(const value of invalid) assert.equal(command(f,'--pulse-'+field+'-set',String(value)).status,2);
  }
  assert.match(command(f,'--pulse-status').stdout,/PULSE_CHARGE_S=1200;PULSE_PAUSE_MS=60000/);
  assert.equal(command(f,'--pulse-range-set','60,80').status,0);
  assert.equal(command(f,'--pulse-range-set','0,40').status,0);
  assert.match(command(f,'--pulse-status').stdout,/PULSE_RANGES=0,40:60,80;PULSE_CONFIG_VALID=YES/);
  for(const row of ['40,60','-1,40','0,101','80,60','0,40;touch nope']) assert.notEqual(command(f,'--pulse-range-set',row).status,0);
  assert.match(command(f,'--pulse-status').stdout,/PULSE_RANGES=0,40:60,80/);
  assert.equal(command(f,'--pulse-range-delete','60,80').status,0);
  assert.match(command(f,'--pulse-status').stdout,/PULSE_RANGES=0,40;/);
  command(f,'--pulse-enable'); command(f,'--pulse-disable');
  assert.match(command(f,'--pulse-status').stdout,/PULSE_ENABLED=NO;PULSE_CHARGE_S=1200;PULSE_PAUSE_MS=60000;PULSE_RANGES=0,40/);
  assert.equal(existsSync(leasePath(f)),false,'修改间断设置不能自行接管充电');
});

test('充电 5 秒后 MMI 停充，1000 毫秒后恢复当前上限，循环并在关闭监测时恢复 MMI',async t=>{
  const f=mk(t);
  command(f,'--vote-initial-set','3000'); command(f,'--pulse-enable');
  startDaemon(t,f);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING' && liveGet(f,'TARGET')==='3000','正常充电阶段');
  assert.equal(liveGet(f,'PULSE_DEADLINE_MS'),'106240');
  clockAt(f,106239); await sleep(250);
  assert.equal(liveGet(f,'PULSE_STATE'),'CHARGING');
  clockAt(f,106240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','满 5 秒 MMI 停充');
  assert.equal(readFileSync(join(f.u,'force_val'),'utf8'),'3000');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'1');
  assert.equal(readFileSync(f.mmi,'utf8'),'0');
  assert.equal(readFileSync(leasePath(f),'utf8').split(' ')[3],'3000');
  assert.equal(command(f,'--recover').status,0);
  assert.equal(readFileSync(f.mmi,'utf8'),'0','守护不能抢先恢复仍在执行的暂停');
  assert.match(statusOf(f),/CONTROL_STATE=RUNNING;TARGET_RAW=3000/);
  assert.equal(liveGet(f,'PULSE_DEADLINE_MS'),'107240');
  clockAt(f,107239); await sleep(250); assert.equal(readFileSync(f.mmi,'utf8'),'0');
  clockAt(f,107240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING' && liveGet(f,'TARGET')==='9000','1000 毫秒后恢复当前上限');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'1');
  assert.equal(readFileSync(f.mmi,'utf8'),'1');
  clockAt(f,112240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','下一轮再次暂停');
  writeFileSync(join(f.data,'auto-control.monitor'),'off');
  await waitFor(()=>!existsSync(leasePath(f)),'监测关闭时清理暂停租约');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'0');
  await waitFor(()=>readFileSync(f.mmi,'utf8')==='1','关闭监测恢复 MMI');
});

test('间断充电只在所选多个电量区间生效，离开区间立即恢复，重新进入从完整充电阶段开始',async t=>{
  const f=mk(t);
  command(f,'--vote-initial-set','3000');command(f,'--pulse-enable');
  command(f,'--pulse-range-set','0,40');command(f,'--pulse-range-set','60,80');
  startDaemon(t,f);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='OUTSIDE_RANGE','50% 不在所选区间');
  for(const capacity of [0,40,60,80]) {
    writeFileSync(f.capacity,String(capacity));
    await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','进入区间 '+capacity);
    const deadline=Number(liveGet(f,'PULSE_DEADLINE_MS'));
    clockAt(f,deadline);
    await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','区间内暂停');
    assert.equal(readFileSync(f.mmi,'utf8'),'0');
    writeFileSync(f.capacity,'50');
    await waitFor(()=>liveGet(f,'PULSE_STATE')==='OUTSIDE_RANGE' && liveGet(f,'TARGET')==='3000','离开区间恢复');
    assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'1');
    assert.equal(readFileSync(f.mmi,'utf8'),'1');
  }
  writeFileSync(f.capacity,'UNKNOWN');
  await sleep(250);assert.equal(liveGet(f,'PULSE_STATE'),'OUTSIDE_RANGE');
});

test('暂停期间仍应用当前 UFCS 电量参数与温控，恢复时使用当前允许的目标',async t=>{
  const f=mk(t);
  command(f,'--soc-range-set','0,20,6000,4000,100,100,500,-50');
  command(f,'--soc-range-set','21,80,2000,9000,100,100,500,-50');
  command(f,'--soc-enable'); command(f,'--pulse-enable');
  writeFileSync(f.capacity,'20');
  startDaemon(t,f);
  await waitFor(()=>liveGet(f,'TARGET')==='4000','按当前电量参数起步');
  clockAt(f,106240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','进入暂停');
  writeFileSync(f.capacity,'21'); await sleep(250);
  assert.equal(readFileSync(f.mmi,'utf8'),'0');
  assert.equal(readFileSync(join(f.u,'force_val'),'utf8'),'4000','暂停期间不改写保存值');
  clockAt(f,107240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING' && liveGet(f,'TARGET')==='2000','恢复到新电量区间上限');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'1');
  assert.equal(readFileSync(f.mmi,'utf8'),'1');
  command(f,'--thermal-enable'); command(f,'--thermal-vote-set','500');
  writeFileSync(f.temp,'450'); clockAt(f,112240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','第二次暂停');
  clockAt(f,113240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING' && liveGet(f,'TARGET')==='500','恢复时温控仍优先');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'1');
});

test('暂停时关闭功能、断开时间设为 0 或时钟异常均恢复正常投票，PPS 同样循环',async t=>{
  const f=mk(t);
  command(f,'--vote-initial-set','3000');command(f,'--pulse-enable');
  startDaemon(t,f);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','启动');
  clockAt(f,106240);await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','暂停');
  command(f,'--pulse-disable');
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='OFF' && liveGet(f,'TARGET')==='3000','关闭后恢复');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'1');
  command(f,'--pulse-enable');await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','重开重新计时');
  clockAt(f,111240);await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','再次暂停');
  command(f,'--pulse-pause-set','0');
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CONTINUOUS' && liveGet(f,'TARGET')==='3000','0 毫秒保持连续充电');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'1');
  clockAt(f,211240);await sleep(250);assert.equal(liveGet(f,'TARGET'),'3000');
  command(f,'--pulse-pause-set','1000');await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','恢复循环');
  clockAt(f,216240);await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','再次暂停');
  writeFileSync(f.uptime,'invalid');
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CLOCK_ERROR' && liveGet(f,'TARGET')==='3000','时钟异常恢复强制投票');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'1');
  clockAt(f,217240);writeFileSync(f.volt,'4470000');
  online(f,'ufcs',false);online(f,'pps',true);
  await waitFor(()=>liveGet(f,'PROTO')==='pps' && liveGet(f,'PULSE_STATE')==='CHARGING' && liveGet(f,'TARGET')==='3000','PPS 从正常充电阶段起步');
  clockAt(f,222240);await waitFor(()=>liveGet(f,'PROTO')==='pps' && liveGet(f,'PULSE_STATE')==='PAUSED','PPS 暂停');
  assert.equal(readFileSync(f.mmi,'utf8'),'0');
  assert.equal(readFileSync(join(f.p,'force_val'),'utf8'),'3000');
  clockAt(f,223240);await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING' && liveGet(f,'TARGET')==='5000','PPS 恢复上限');
  assert.equal(readFileSync(join(f.p,'force_active'),'utf8'),'1');
  assert.equal(readFileSync(f.mmi,'utf8'),'1');
});

test('MMI 停充先核对本模块租约，核对失败不开始计时，节点恢复后重试',async t=>{
  const f=mk(t);
  command(f,'--vote-initial-set','3000');command(f,'--pulse-enable');
  startDaemon(t,f);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','正常充电');
  writeFileSync(join(f.u,'force_val'),'7000');clockAt(f,106240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='WRITE_ERROR','外部投票值不匹配时拒绝撤销');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'1');
  assert.equal(readFileSync(join(f.u,'force_val'),'utf8'),'7000');
  assert.equal(liveGet(f,'PULSE_DEADLINE_MS'),'0');
  writeFileSync(join(f.u,'force_val'),'3000');clockAt(f,107240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','恢复后重试成功');
  assert.equal(readFileSync(f.mmi,'utf8'),'0');
  assert.equal(liveGet(f,'PULSE_DEADLINE_MS'),'108240');
});

test('MMI 接口不可用或已被外部停用时不误恢复，接口可用后重试',async t=>{
  const f=mk(t);
  writeFileSync(f.mmi,'0');command(f,'--pulse-enable');startDaemon(t,f);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','正常阶段');clockAt(f,106240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='WRITE_ERROR','外部停充拒绝接管');
  assert.equal(existsSync(join(f.data,'pulse-mmi.lease')),false);
  command(f,'--pulse-disable');await waitFor(()=>liveGet(f,'PULSE_STATE')==='OFF','关闭功能');
  assert.equal(readFileSync(f.mmi,'utf8'),'0','不能恢复其它来源的停充');
  rmSync(f.mmi);command(f,'--pulse-enable');await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','重开');
  clockAt(f,111240);await waitFor(()=>liveGet(f,'PULSE_STATE')==='WRITE_ERROR','缺少接口');
  assert.equal(existsSync(f.mmi),false,'不能创建伪造的充电节点');
  writeFileSync(f.mmi,'1');await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','接口恢复后停充');
  assert.equal(readFileSync(f.mmi,'utf8'),'0');
});

test('MMI 导致协议暂时离线仍完成暂停，恢复后等待协议重新在线；真实拔线立即恢复 MMI',async t=>{
  const f=mk(t);command(f,'--pulse-enable');startDaemon(t,f);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','启动');clockAt(f,106240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','暂停');online(f,'ufcs',false);
  clockAt(f,106740);await sleep(250);
  assert.equal(liveGet(f,'PULSE_STATE'),'PAUSED');assert.equal(readFileSync(f.mmi,'utf8'),'0');
  clockAt(f,107240);await waitFor(()=>readFileSync(f.mmi,'utf8')==='1' && liveGet(f,'REASON')==='WAITING_PROTOCOL','恢复并等待协议');
  online(f,'ufcs',true);await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','协议恢复');
  clockAt(f,112240);await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','再次暂停');
  writeFileSync(f.usbOnline,'0');online(f,'ufcs',false);
  await waitFor(()=>readFileSync(f.mmi,'utf8')==='1' && !existsSync(join(f.data,'pulse-mmi.lease')),'真实拔线恢复 MMI 并完成清理');
  assert.equal(existsSync(join(f.data,'pulse-mmi.lease')),false);
});

test('MMI 恢复失败保留恢复记录并重试，不误报正常充电',async t=>{
  const f=mk(t);command(f,'--pulse-enable');startDaemon(t,f);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','启动');clockAt(f,106240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','暂停');
  rmSync(f.mmi);mkdirSync(f.mmi);clockAt(f,107240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='WRITE_ERROR','恢复失败');
  assert.equal(existsSync(join(f.data,'pulse-mmi.lease')),true);
  assert.notEqual(liveGet(f,'PULSE_STATE'),'CHARGING');
  rmSync(f.mmi,{recursive:true});writeFileSync(f.mmi,'0');
  await waitFor(()=>readFileSync(f.mmi,'utf8')==='1' && liveGet(f,'PULSE_STATE')==='CHARGING','恢复后继续充电');
  assert.equal(liveGet(f,'TARGET'),'9000');assert.equal(existsSync(join(f.data,'pulse-mmi.lease')),false);
});

test('控制进程崩溃后即使投票租约缺失也可恢复自有 MMI；TERM 退出立即恢复',async t=>{
  const f=mk(t);command(f,'--pulse-enable');const child=startDaemon(t,f);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','启动');clockAt(f,106240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','暂停');
  child.kill('SIGKILL');await onceExit(child);rmSync(leasePath(f));
  const recovered=command(f,'--recover');assert.equal(recovered.status,0,recovered.stderr);
  assert.equal(readFileSync(f.mmi,'utf8'),'1');assert.equal(existsSync(join(f.data,'pulse-mmi.lease')),false);
  clockAt(f,107240);const next=startDaemon(t,f);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','重新启动');clockAt(f,112240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','再次暂停');
  next.kill('SIGTERM');await onceExit(next);
  assert.equal(readFileSync(f.mmi,'utf8'),'1');assert.equal(existsSync(join(f.data,'pulse-mmi.lease')),false);
});

test('卸载先关闭控制并恢复本模块 MMI，损坏或跨启动的标记不能误开启充电',async t=>{
  const f=mk(t);command(f,'--pulse-enable');const child=startDaemon(t,f);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='CHARGING','启动');clockAt(f,106240);
  await waitFor(()=>liveGet(f,'PULSE_STATE')==='PAUSED','暂停');
  const uninstall=join(f.base,'uninstall.sh');
  writeFileSync(uninstall,readFileSync(join(root,'uninstall.sh'),'utf8').replaceAll('/data/adb/oplus-votable',f.data));
  const result=spawnSync('sh',[uninstall],{encoding:'utf8',env:f.env,timeout:5000});
  assert.equal(result.status,0,result.stderr);await onceExit(child);
  assert.equal(readFileSync(f.mmi,'utf8'),'1');assert.equal(existsSync(join(f.data,'pulse-mmi.lease')),false);
  writeFileSync(f.mmi,'0');writeFileSync(join(f.data,'pulse-mmi.lease'),'invalid marker\n');
  assert.equal(command(f,'--recover').status,3);assert.equal(readFileSync(f.mmi,'utf8'),'0');
  writeFileSync(join(f.data,'pulse-mmi.lease'),'87654321-1234-1234-1234-123456789012 12345\n');
  assert.equal(command(f,'--recover').status,0);assert.equal(readFileSync(f.mmi,'utf8'),'0');
  assert.equal(existsSync(join(f.data,'pulse-mmi.lease')),false);
});

test('UFCS 电压上限 4660，PPS 保持 4560，保存和运行时读取均按协议校验',t=>{
  const f=mk(t);
  assert.equal(command(f,'--limit-set','ufcs','4660').status,0);
  assert.match(statusOf(f),/UFCS_LIMIT_MV=4660/);
  assert.equal(command(f,'--limit-set','ufcs','4661').status,2);
  assert.equal(command(f,'--limit-set','pps','4660').status,2);
  writeFileSync(join(f.data,'auto-control.pps.limit-mv'),'4660');
  assert.match(statusOf(f),/PPS_LIMIT_MV=4500/);
});

test('电量区间保存六项独立参数，包含边界，禁止重叠和非法值，删除后回退且通用设置不变',t=>{
  const f=mk(t);
  const row='0,20,4200,2400,150,200,600,-80';
  assert.match(command(f,'--soc-status').stdout,/SOC_ENABLED=NO.*SOC_RANGES=NONE/);
  const result=command(f,'--soc-range-set',row);
  assert.equal(result.status,0,result.stdout+result.stderr);
  command(f,'--soc-enable');
  for(const capacity of [0,20]) {
    writeFileSync(f.capacity,String(capacity));
    const st=command(f,'--soc-status').stdout;
    assert.match(st,/SOC_MATCH=0,20;SOC_EFFECTIVE_VOTE_MAX=4200;SOC_EFFECTIVE_INITIAL=2400;SOC_EFFECTIVE_INTERVAL_MS=150;SOC_EFFECTIVE_RAISE_STEP=200;SOC_EFFECTIVE_LOWER_STEP=600;SOC_EFFECTIVE_CUTOFF_GAP_MV=-80/);
  }
  writeFileSync(f.capacity,'21');
  assert.match(command(f,'--soc-status').stdout,/SOC_MATCH=NONE;SOC_EFFECTIVE_VOTE_MAX=9000;SOC_EFFECTIVE_INITIAL=1000/);
  const file=join(f.data,'auto-control.ufcs.soc-ranges');
  for(const invalid of ['20,30,4200,2400,150,200,600,-80','-1,20,4200,2400,150,200,600,-80','0,101,4200,2400,150,200,600,-80','30,21,4200,2400,150,200,600,-80','0,20,999,2400,150,200,600,-80','0,20,4200,999,150,200,600,-80','0,20,4200,2400,19,200,600,-80','0,20,4200,2400,150,9,600,-80','0,20,4200,2400,150,200,99,-80','0,20,4200,2400,150,200,600,1','0,20,4200,2400,150,200,600,-101','0,20,4200,2400,150,200,600,-80;touch nope']) {
    assert.notEqual(command(f,'--soc-range-set',invalid).status,0,invalid);
    assert.equal(readFileSync(file,'utf8').trim(),row,'无效操作不能破坏已保存的规则');
  }
  assert.equal(command(f,'--soc-range-set','100,100,1000,1000,20,10,100,0').status,0);
  writeFileSync(f.capacity,'100');
  assert.match(command(f,'--soc-status').stdout,/SOC_MATCH=100,100/);
  assert.equal(command(f,'--soc-range-delete','100,100,1000,1000,20,10,100,0').status,0);
  assert.match(command(f,'--soc-status').stdout,/SOC_MATCH=NONE/);
  assert.match(statusOf(f),/UFCS_VOTE_MAX=9000/);
  assert.match(statusOf(f),/VOTE_INITIAL=1000;INTERVAL_MS=100;RAISE_STEP=100;LOWER_STEP=500;CUTOFF_GAP_MV=-50/);
  command(f,'--soc-disable');
  assert.equal(readFileSync(file,'utf8').trim(),row,'关闭功能保留区间');
  assert.equal(existsSync(leasePath(f)),false,'设置区间不能自行接管充电');
});

test('区间参数在真实控制循环生效：初始值、监控时间、升降步进、截止压差和上限',async t=>{
  const f=mk(t);
  writeFileSync(f.capacity,'10'); writeFileSync(f.volt,'4500000');
  const row='0,20,3000,2000,200,200,100,0';
  assert.equal(command(f,'--soc-range-set',row).status,0);
  command(f,'--soc-enable');
  const sleeps=join(f.base,'sleeps');
  writeFileSync(f.shell,readFileSync(f.shell,'utf8').replaceAll('sleep "$ivl"',`printf '%s\\n' "$ivl" >> "${sleeps}"; sleep "$ivl"`));
  startDaemon(t,f);
  await waitFor(()=>liveGet(f,'TARGET')==='3000','区间初始 2000 后每轮 +200 升至上限 3000');
  assert.match(readEvents(f),/START_ADAPTIVE_2000/);
  assert.ok(readFileSync(sleeps,'utf8').trim().split('\n').every(value=>value==='0.200'),'实际休眠使用区间监控时间');
  command(f,'--soc-range-set','0,20,4000,2000,200,200,100,-100');
  await sleep(450);
  assert.equal(liveGet(f,'TARGET'),'3000','区间截止压差 -100 时 4500mV 不再升流');
  writeFileSync(f.volt,'4600000');
  await waitFor(()=>Number(liveGet(f,'TARGET'))<3000,'区间降低步进生效');
  assert.equal((3000-Number(liveGet(f,'TARGET')))%100,0);
  assert.ok(Number(liveGet(f,'TARGET'))>=2700,'使用区间的 100 步进，而非通用 500');
  writeFileSync(f.volt,'4520000'); writeFileSync(f.capacity,'21');
  await waitFor(()=>liveGet(f,'TARGET')==='1000','未匹配区间时按通用初始值起步');
  writeFileSync(f.capacity,'20');
  await waitFor(()=>liveGet(f,'TARGET')==='2000','20% 仍属于第一段，重新按区间初始值起步');
  command(f,'--soc-disable');
  await waitFor(()=>liveGet(f,'TARGET')==='1000','关闭区间控制即时回退');
});

test('区间上限约束起步且不能绕过温控，PPS 使用通用参数，电量异常或坏规则回退',async t=>{
  const f=mk(t);
  command(f,'--soc-range-set','0,100,2000,9000,20,500,100,0'); command(f,'--soc-enable');
  command(f,'--vote-initial-set','3000');
  command(f,'--thermal-enable'); command(f,'--thermal-vote-set','500'); sampleTemperature(f,450);
  startDaemon(t,f);
  await waitFor(()=>liveGet(f,'TARGET')==='500','区间初始值先受区间上限和温控约束');
  command(f,'--thermal-disable');
  await waitFor(()=>liveGet(f,'THERMAL_STATE')==='OFF','确认温控已关闭');
  writeFileSync(f.volt,'4470000');
  online(f,'ufcs',false); online(f,'pps',true);
  await waitFor(()=>liveGet(f,'PROTO')==='pps' && liveGet(f,'TARGET')==='3000','PPS 沿用通用初始值');
  online(f,'pps',false); online(f,'ufcs',true); writeFileSync(f.volt,'4520000');
  await waitFor(()=>liveGet(f,'PROTO')==='ufcs' && liveGet(f,'TARGET')==='2000','UFCS 区间初始值受上限 2000 约束');
  for(const invalid of ['UNKNOWN','101','-1','']) {
    writeFileSync(f.capacity,invalid);
    assert.match(command(f,'--soc-status').stdout,/SOC_PERCENT=UNKNOWN.*SOC_MATCH=NONE;SOC_EFFECTIVE_VOTE_MAX=9000/);
  }
  const file=join(f.data,'auto-control.ufcs.soc-ranges');
  writeFileSync(file,'corrupt');
  assert.match(command(f,'--soc-status').stdout,/SOC_CONFIG_VALID=NO;SOC_RANGES=NONE;SOC_MATCH=NONE/);
  assert.notEqual(command(f,'--soc-range-set','0,20,1000,1000,100,100,500,-50').status,0);
  assert.equal(readFileSync(file,'utf8'),'corrupt','不能用新数据覆盖损坏配置');
});

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

test('温度伪装默认关闭，开启后写固定外壳温度并设为只读，关闭恢复可写',t=>{
  const f=mk(t);
  assert.match(command(f,'--faketemp-status').stdout,
    /FAKETEMP_ENABLED=NO;FAKETEMP_VALUE_DECI=360;FAKETEMP_STATE=OFF;/);
  // 默认关闭时不触碰节点，权限保持原样。
  assert.equal(modeOf(f.shellTemp),'644');
  assert.equal(command(f,'--faketemp-value-set','300').status,0);
  assert.match(command(f,'--faketemp-status').stdout,/FAKETEMP_VALUE_DECI=300;/);
  for (const bad of ['199','451','0','0300','abc','$((1))','12.5']) {
    assert.equal(command(f,'--faketemp-value-set',bad).status,2,'应拒绝 '+bad);
  }
  assert.equal(command(f,'--faketemp-value-set').status,2);
  assert.match(statusOf(f),/FAKETEMP_ENABLED=NO;FAKETEMP_VALUE_DECI=300;FAKETEMP_STATE=OFF;/);
  const on=command(f,'--faketemp-enable');
  assert.equal(on.status,0,on.stderr);
  assert.match(on.stdout,/FAKETEMP_ENABLED=on/);
  assert.match(command(f,'--faketemp-status').stdout,
    /FAKETEMP_ENABLED=YES;FAKETEMP_VALUE_DECI=300;FAKETEMP_STATE=APPLIED;/);
  assert.equal(modeOf(f.shellTemp),'444','开启后节点只读，horae 仍须能读取');
  // 真实节点每次写入都会被内核处理；普通文件会被 > 截断，这里校验换算后的毫摄氏度。
  assert.equal(readFileSync(f.shellTemp,'utf8').trim(),'2 30000','只读权限不能阻止 horae 读取');
  chmodSync(f.shellTemp,0o644);
  assert.match(command(f,'--faketemp-ensure').stdout,/FAKETEMP_STATE=APPLIED;/);
  assert.equal(modeOf(f.shellTemp),'444');
  const off=command(f,'--faketemp-disable');
  assert.equal(off.status,0,off.stderr);
  assert.match(off.stdout,/FAKETEMP_ENABLED=off/);
  assert.match(command(f,'--faketemp-status').stdout,
    /FAKETEMP_ENABLED=NO;FAKETEMP_VALUE_DECI=300;FAKETEMP_STATE=OFF;/);
  assert.equal(modeOf(f.shellTemp),'666','关闭后恢复节点可写');
});

test('温度伪装设置越界时拒绝，且不改变温控状态与监测租约',t=>{
  const f=mk(t);
  command(f,'--thermal-enable'); command(f,'--thermal-vote-set','500');
  for (const [option,values] of [['--faketemp-value-set',['200','450']]]) {
    for (const value of values) assert.equal(command(f,option,value).status,0,option+' '+value);
  }
  assert.equal(command(f,'--faketemp-value-set','199').status,2);
  assert.equal(command(f,'--faketemp-value-set','451').status,2);
  // 温控读取的是电池温度节点，伪装只改外壳温度节点，两者互不干扰。
  assert.match(command(f,'--thermal-status').stdout,/THERMAL_ENABLED=YES;THERMAL_LIMIT_C=45;THERMAL_VOTE_MA=500/);
  assert.equal(readFileSync(f.temp,'utf8'),'340');
  assert.equal(existsSync(leasePath(f)),false,'改伪装设置不能自行接管');
});

test('--status 未接管时报告 STOPPED、总开关默认开、UFCS/PPS 默认开与各自默认参数',t=>{
  const f=mk(t);
  const r=command(f,'--status');
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stdout.trim().split('\n').length,1);
  assert.match(r.stdout,/FAKETEMP_ENABLED=NO;FAKETEMP_VALUE_DECI=360;FAKETEMP_STATE=OFF;/);
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
  assert.equal(command(f,'--limit-set','ufcs','4661').status,2);
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
  await waitFor(()=>!existsSync(leasePath(f)) && /state=CONTROL_FINISHED_PROTOCOL_DISABLED/.test(readEvents(f)),'关闭协议后撤销并完成日志');
  assert.equal(readFileSync(join(f.u,'force_active'),'utf8'),'0');
  assert.match(readEvents(f),/state=CONTROL_FINISHED_PROTOCOL_DISABLED/);
  assert.equal(child.exitCode,null,'守护必须继续存活');
  await waitFor(()=>liveGet(f,'REASON')==='PROTOCOL_DISABLED','原因更新',20);
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

test('温度伪装联动 horae 测试模式，默认关闭不干预，重启重新应用，卸载恢复',t=>{
  const f=mk(t);
  command(f,'--faketemp-value-set','360');
  assert.equal(existsSync(f.horaeLog),false,'未启用过时不得改变 horae');
  assert.match(command(f,'--faketemp-status').stdout,/FAKETEMP_HORAE_STATE=UNKNOWN/);
  assert.equal(command(f,'--faketemp-enable').status,0);
  assert.equal(readFileSync(f.horaeLog,'utf8'),'horae testmode\n');
  assert.match(command(f,'--faketemp-status').stdout,/FAKETEMP_STATE=APPLIED;FAKETEMP_HORAE_STATE=TEST_SENT/);
  writeFileSync(join(f.base,'boot_id'),'87654321-4321-4321-4321-210987654321');
  assert.match(command(f,'--faketemp-status').stdout,/FAKETEMP_STATE=PENDING;FAKETEMP_HORAE_STATE=UNKNOWN/);
  assert.equal(command(f,'--faketemp-ensure').status,0);
  assert.match(command(f,'--faketemp-status').stdout,/FAKETEMP_STATE=APPLIED;FAKETEMP_HORAE_STATE=TEST_SENT/);
  const uninstall=join(f.base,'uninstall.sh');
  writeFileSync(uninstall,readFileSync(join(root,'uninstall.sh'),'utf8').replaceAll('/data/adb/oplus-votable',f.data));
  assert.equal(spawnSync('sh',[uninstall],{env:f.env}).status,0);
  assert.match(readFileSync(f.horaeLog,'utf8'),/horae testmode false\n$/);
  assert.equal(modeOf(f.shellTemp),'666');
  assert.match(command(f,'--faketemp-status').stdout,/FAKETEMP_ENABLED=NO.*FAKETEMP_HORAE_STATE=NORMAL_SENT/);
  const calls=readFileSync(f.horaeLog,'utf8');command(f,'--faketemp-ensure');
  assert.equal(readFileSync(f.horaeLog,'utf8'),calls,'恢复成功后不反复发送恢复命令');
});

test('horae 失败或超时不得报告应用成功，恢复失败仍解锁节点并允许重试',t=>{
  const f=mk(t);f.env.HORAETEST_EXIT='124';
  assert.equal(command(f,'--faketemp-enable').status,3);
  assert.match(command(f,'--faketemp-status').stdout,/FAKETEMP_STATE=PENDING;FAKETEMP_HORAE_STATE=ERROR/);
  f.env.HORAETEST_EXIT='0';assert.equal(command(f,'--faketemp-ensure').status,0);
  assert.equal(modeOf(f.shellTemp),'444');
  f.env.HORAETEST_EXIT='1';assert.equal(command(f,'--faketemp-disable').status,3);
  assert.equal(modeOf(f.shellTemp),'666','horae 恢复失败不能阻止节点解锁');
  assert.match(command(f,'--faketemp-status').stdout,/FAKETEMP_ENABLED=NO.*FAKETEMP_HORAE_STATE=ERROR/);
  f.env.HORAETEST_EXIT='0';assert.equal(command(f,'--faketemp-disable').status,0);
  assert.match(command(f,'--faketemp-status').stdout,/FAKETEMP_HORAE_STATE=NORMAL_SENT/);
});


test('系统忽略退出参数时兼容重启 horae，确认退出后才报告恢复成功',t=>{
  const f=mk(t);f.env.HORAETEST_STUCK='1';
  assert.equal(command(f,'--faketemp-enable').status,0);
  assert.equal(command(f,'--faketemp-disable').status,0);
  assert.equal(existsSync(f.env.HORAETEST_RESTARTED),true);
  assert.equal(modeOf(f.shellTemp),'666');
  assert.match(command(f,'--faketemp-status').stdout,/FAKETEMP_HORAE_STATE=NORMAL_SENT/);
});

test('兼容恢复失败不能误报正常模式，仍恢复节点可写并允许重试',t=>{
  const f=mk(t);f.env.HORAETEST_STUCK='1';f.env.HORAETEST_RESTART_FAIL='1';
  assert.equal(command(f,'--faketemp-enable').status,0);
  assert.equal(command(f,'--faketemp-disable').status,3);
  assert.equal(modeOf(f.shellTemp),'666');
  assert.match(command(f,'--faketemp-status').stdout,/FAKETEMP_HORAE_STATE=ERROR/);
  f.env.HORAETEST_RESTART_FAIL='0';assert.equal(command(f,'--faketemp-disable').status,0);
});
