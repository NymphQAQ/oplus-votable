import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const source=readFileSync(new URL('../charge-test.sh',import.meta.url),'utf8').split('case "$CMD" in')[0];
function run(t,body) {
  const dir=mkdtempSync(join(tmpdir(),'vote-headroom-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let script=source.replaceAll('/data/adb/oplus-votable',dir);
  for(const [name,value] of Object.entries({status:'Charging',current_now:'-7800',model_name:'oplus battery'})) {
    const path=join(dir,name);writeFileSync(path,value);
    script=script.replaceAll('/sys/class/power_supply/battery/'+name,path);
  }
  script+='\n'+String.raw`
loop_started=100000; loop_ms=500; hr_sample_at=0; hr_block_raise=0
ap=ufcs; soc_match=NONE; effective_max=10700; target=10700; rstep=100
v=4400000; luv=4560000; raise_uv=4510000; voltage_state=NORMAL
cv_enabled=0; cv_target_mv=4540; cv_band=5; cv_raise=50; cv_next_at=0
voltage_hold_until=0; early_band=0; vote_error=0
pulse_state=OFF; pulse_error=''; pulse_deadline=0; thermal_held=0
headroom_reset; hr_key="$ap:$soc_match:$effective_max"
log() { printf 'EVENT %s\n' "$1"; }
tick() {
  previous="$target"; vm="$effective_max"
  headroom_update
  if [ "$hr_block_raise" -eq 0 ] && [ "$target" -lt "$vm" ]; then
    target=$((target + rstep)); [ "$target" -le "$vm" ] || target="$vm"
  fi
  [ "$target" -le "$vm" ] || target="$vm"
  [ "$target" -eq "$previous" ] || hr_last_write="$loop_started"
  printf 'ROW %s %s %s %s %s\n' "$loop_started" "$target" "$hr_cap" "$hr_pending" "$hr_current"
  loop_started=$((loop_started + 500))
}
`+body;
  const result=spawnSync('sh',['-s'],{input:script,cwd:dir,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  return {output:result.stdout,rows:result.stdout.split('\n').filter(l=>l.startsWith('ROW ')).map(l=>{
    const [,time,target,cap,pending,current]=l.split(' ');
    return {time:+time-100000,target:+target,cap:+cap,pending,current:+current};
  })};
}

for(const gain of [1,2]) test('实际输出 8000→6700→9000 时跟踪余量并恢复，电池侧倍率 '+gain, t=>{
  const {rows,output}=run(t,String.raw`
n=0
while [ "$n" -le 800 ]; do
  elapsed=$((n * 500)); available=8000
  [ "$elapsed" -lt 60000 ] || available=6700
  [ "$elapsed" -lt 160000 ] || available=9000
  actual="$target"; [ "$actual" -le "$available" ] || actual="$available"
  printf '%s' "$((-(actual - 200) * `+gain+String.raw`))" > current_now
  tick; n=$((n + 1))
done
`);
  const at=time=>rows.find(r=>r.time===time);
  assert.ok(at(45000).cap>=8000 && at(45000).cap<=8200,JSON.stringify(at(45000)));
  const settled=rows.filter(r=>r.time>=120000 && r.time<=140000 && r.pending==='NONE');
  assert.ok(settled.length && settled.every(r=>r.cap>=6700 && r.cap<=6900),JSON.stringify(settled));
  assert.ok(at(400000).cap>=8500 && at(400000).cap<=9200,JSON.stringify(at(400000)));
  assert.ok(rows.filter(r=>r.time<60000).every(r=>r.target>=7800),'确认生效点前最多一个 200mA 试探');
  assert.ok(rows.every(r=>r.target>=1000 && r.target<=10700));
  const changes=rows.filter((r,i)=>i && r.target!==rows[i-1].target);
  for(let i=1;i<changes.length;i++) {
    if(changes[i].target<changes[i-1].target) assert.ok(changes[i].time-changes[i-1].time>=1500,'不连续补扣');
  }
  assert.match(output,/HEADROOM_FOUND/);assert.match(output,/HEADROOM_PROBE_UP/);
});

test('起步、异常及放电电流不学习，正常读数恢复后重新等待',t=>{
  const {rows}=run(t,String.raw`
for current in 0 invalid 1000 -999999999999 '-7800
bad'; do
  printf '%s' "$current" > current_now
  tick
done
printf '%s' -7800 > current_now
tick; tick; tick; tick; tick; tick; tick
`);
  assert.ok(rows.slice(0,8).every(r=>r.target===10700 && r.cap===0));
  assert.ok(rows.at(-1).target<10700);
});

test('不稳定电流和孤立低谷不能连续收回投票',t=>{
  const {rows}=run(t,String.raw`
n=0
while [ "$n" -lt 40 ]; do
  if [ $((n % 2)) -eq 0 ]; then printf '%s' -7000 > current_now
  else printf '%s' -8000 > current_now; fi
  tick; n=$((n + 1))
done
printf '%s' -7800 > current_now; tick
printf '%s' -300 > current_now; tick
printf '%s' -7800 > current_now; tick; tick
`);
  assert.ok(rows.every(r=>r.target===10700));
});

test('接近电压上限、恒压调节区和暂停前不试探，温控/暂停/坏时钟清除学习',t=>{
  const {rows}=run(t,String.raw`
for guard in voltage cv pulse_deadline early; do
  v=4400000; cv_enabled=0; pulse_state=OFF; early_band=0
  case "$guard" in
    voltage) v=4530000;;
    cv) cv_enabled=1; v=4540000;;
    pulse_deadline) pulse_state=CHARGING; pulse_deadline=$((loop_started + 2000));;
    early) early_band=1;;
  esac
  tick; tick; tick; tick; tick; tick
done
v=4400000; cv_enabled=0; pulse_state=OFF; early_band=0
for guard in thermal paused error clock range protocol; do
  hr_cap=8000; hr_pending=DOWN; hr_probe=8000; target=8000
  case "$guard" in
    thermal) thermal_held=1;;
    paused) pulse_state=PAUSED;;
    error) vote_error=1;;
    clock) loop_ms=-1;;
    range) soc_match=50,80;;
    protocol) ap=pps;;
  esac
  tick
  [ "$hr_cap" -eq 0 ] && [ "$hr_pending" = NONE ] || exit 12
  thermal_held=0; pulse_state=OFF; vote_error=0; loop_ms=500
done
`);
  assert.ok(rows.slice(0,24).every(r=>r.target===10700 && r.cap===0));
});

test('标准微安、OPLUS 毫安和前导零读数统一，失败不会当作零电流',t=>{
  run(t,String.raw`
printf '%s' '-007800' > current_now
headroom_current && [ "$hr_read" -eq 7800 ] || exit 10
printf '%s' standard > model_name; printf '%s' -7800000 > current_now
headroom_current && [ "$hr_read" -eq 7800 ] || exit 11
printf '%s' Full > status
if headroom_current; then exit 12; fi
`);
});

test('已到用户上限后重新探测下降，恒压向上探测仍受 50mA 和写入等待约束',t=>{
  const {rows}=run(t,String.raw`
hr_cap=10700; hr_direction=UP; hr_observed=10700
n=0
while [ "$n" -lt 32 ]; do tick; n=$((n + 1)); done
[ "$hr_direction" = DOWN ] || [ "$hr_pending" = DOWN ] || exit 10
headroom_reset; hr_key="$ap:$soc_match:$effective_max"
hr_cap=8000; target=8000; hr_observed=8000; hr_direction=UP
cv_enabled=1; cv_next_at=$((loop_started + 5000))
n=0
while [ "$n" -lt 16 ]; do tick; n=$((n + 1)); done
[ "$target" -le 8050 ] || exit 11
`);
  assert.ok(rows.slice(-16).every(r=>r.target<=8050));
});

test('低于普通下限的已有目标不会被余量下探抬高，异常时钟恢复后重新采样',t=>{
  run(t,`
target=500; v=4520000; hr_observed=500
n=0
while [ "$n" -lt 20 ]; do
  vm="$effective_max"; headroom_update
  [ "$target" -eq 500 ] || exit 10
  loop_started=$((loop_started + 500)); n=$((n + 1))
done
loop_ms=-5000; loop_started=50000; vm="$effective_max"; headroom_update
loop_ms=500; loop_started=50500; vm="$effective_max"; headroom_update
[ "$hr_sample_at" -eq 51000 ] || exit 11
`);
});

test('1.5 秒电流延迟与 40mA 波动下仍能移除高位余量，保持一档试探幅度',t=>{
  const {rows}=run(t,`
q0=10700; q1=10700; q2=10700; n=0
while [ "$n" -le 120 ]; do
  actual="$q0"; [ "$actual" -le 8000 ] || actual=8000
  noise=20; [ $((n % 2)) -eq 0 ] || noise=-20
  printf '%s' "$((-actual + 200 + noise))" > current_now
  tick; q0="$q1"; q1="$q2"; q2="$target"; n=$((n + 1))
done
`);
  const settled=rows.filter(r=>r.time>=40000 && r.pending==='NONE');
  assert.ok(settled.length && settled.every(r=>r.cap>=7900 && r.cap<=8300),JSON.stringify(settled));
  assert.ok(rows.every(r=>r.target>=7700),'延迟后最多保留小幅试探');
});

test('更长恒压等待不被试探绕过，恢复能力的升流使用恒压目标而非通用截止线',t=>{
  const {rows}=run(t,`
cv_enabled=1; cv_target_mv=4540; v=4500000; raise_uv=4460000
hr_cap=8000; target=8000; hr_observed=8000; hr_direction=UP
cv_next_at=$((loop_started + 10000))
n=0
while [ "$n" -lt 26 ]; do tick; n=$((n + 1)); done
`);
  assert.ok(rows.filter(r=>r.time<10000).every(r=>r.target===8000));
  assert.equal(rows.at(-1).target,8050);
});
