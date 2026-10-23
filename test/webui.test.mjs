import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const utils = require('../webroot/log-utils.js');
const backend = join(dir, 'webroot/log-reader.sh');
const app = readFileSync(join(dir,'webroot/app.js'),'utf8');
const html = readFileSync(join(dir,'webroot/index.html'),'utf8');
const prop = readFileSync(join(dir,'module.prop'),'utf8');

test('UI、模块与安装包版本一致，温度控制与温度伪装入口及参数范围明确',()=>{
  const version=/^version=([^\n]+)/m.exec(prop)[1];
  assert.equal(version,'0.9.29-compact-chart');
  assert.ok(html.includes('ADAPTIVE · v'+version.split('-')[0]));
  assert.ok(readFileSync(join(dir,'build.mjs'),'utf8').includes('oplus-votable-'+version+'.zip'));
  for(const kind of ['Range','Input']) assert.match(html,new RegExp('id="cvFastGap'+kind+'" min="0" max="50" step="1" value="15"'));
  for(const [name,min,max,value] of [['Gap',-50,0,-10],['Step',0,1000,200]]) for(const kind of ['Range','Input']) {
    assert.match(html,new RegExp('id="advEarly'+name+kind+'" min="'+min+'" max="'+max+'" step="1" value="'+value+'"'));
  }
  assert.match(html,/data-detail="pulse"/);
  assert.match(html,/id="pulseSwitch" role="switch"/);
  for(const [name,min,max,value] of [['Charge',1,1200,60],['Pause',0,60000,1000]]) {
    for(const kind of ['Range','Input']) assert.match(html,new RegExp('id="pulse'+name+kind+'" min="'+min+'" max="'+max+'" step="1" value="'+value+'"'));
  }
  assert.match(html,/data-detail="thermal"/);
  assert.match(html,/id="thermalSwitch" role="switch"/);
  for(const [name,min,max,value] of [['Limit',20,60,50],['Vote',500,5000,1000],['Gap',1,5,2]]) {
    for(const kind of ['Range','Input']) {
      assert.match(html,new RegExp('id="thermal'+name+kind+'" min="'+min+'" max="'+max+'"[^>]*value="'+value+'"'));
    }
  }
  // 温度伪装是独立入口，默认开启，范围 20.0–45.0°C、步进 0.5。
  assert.match(html,/data-detail="faketemp"/);
  assert.match(html,/id="control-detail-faketemp"/);
  assert.match(html,/id="fakeSwitch" role="switch"/);
  assert.match(html,/id="fakeEnabled"/);
  assert.match(html,/id="fakeTag"/);
  assert.match(html,/id="fakeStatus"/);
  assert.match(html,/id="fakeSaveStatus"/);
  for(const kind of ['Range','Input']) {
    assert.match(html,new RegExp('id="fakeValue'+kind+'" min="20" max="45"[^>]*value="36"'));
  }
  assert.match(html,/id="fakeValueValue"/);
  assert.match(html,/\/proc\/shell-temp/);
  assert.doesNotMatch(html,/温度限制仍未启用/);
});

test('oplus-votable 模块名、ID、WebUI 命令和私有目录统一', () => {
  const info = readFileSync(join(dir,'module.prop'), 'utf8');
  const guard = readFileSync(join(dir,'watchdog.sh'), 'utf8');
  const control = readFileSync(join(dir,'charge-test.sh'), 'utf8');
  const cleanup = readFileSync(join(dir,'uninstall.sh'), 'utf8');
  const reader = readFileSync(backend,'utf8');
  const utilsSource = readFileSync(join(dir,'webroot/log-utils.js'),'utf8');
  assert.match(info,/^id=oplus-votable$/m);
  assert.match(info,/^name=oplus-votable$/m);
  assert.match(html,/<title>oplus-votable/);
  assert.match(html,/<h1>oplus-votable<\/h1>/);
  assert.match(app,/window\.OplusVotableLog/);
  assert.match(utilsSource,/root\.OplusVotableLog = api/);
  assert.match(app,/\/data\/adb\/modules\/oplus-votable\/webroot\/log-reader\.sh/);
  assert.match(app,/\/data\/adb\/modules\/oplus-votable\/charge-test\.sh/);
  for (const file of [guard,control,cleanup,reader]) {
    assert.match(file,/\/data\/adb\/oplus-votable/);
  }
});

test('模块声明 WebUI 且浏览器资源全部为本地静态文件', () => {
  assert.match(prop, /^hasWebUi=true$/m);
  assert.match(html, /\.\/log-utils\.js/);
  assert.match(html, /\.\/app\.js/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.ok(existsSync(backend));
});

test('解析控制日志行并正确标记异常和强制状态',()=>{
  const entry=utils.parseLine('epoch=1791751140 time=200 state=CONTROL_GUARDIAN_RECOVERY_FAILED pid=MISSING power=UNPLUGGED temp_deci=351 ufcs_force=1 pps_force=0 consecutive=3 write=NEVER');
  assert.equal(entry.state,'CONTROL_GUARDIAN_RECOVERY_FAILED');
  assert.equal(entry.fields.ufcs_force,'1');
  assert.equal(entry.warning,true);
  assert.equal(utils.level(entry.state),'danger');
  assert.equal(utils.temperature(entry.fields.temp_deci),'35.1°C');
  assert.match(utils.timestamp(entry.fields), /\d/);
});

test('解析正常日志和轮转日志，忽略空内容标记',()=>{
  const list=utils.parseLines('\nNO_LOGS_YET\n'+
    'time=100 state=CONTROL_FINISHED_PROTOCOL_CHANGED write=NEVER\n');
  assert.equal(list.length,1);
  assert.equal(list[0].warning,false);
  assert.equal(utils.level(list[0].state),'good');
  assert.equal(utils.parseLines('NO_PREVIOUS_LOG\n').length,0);
});

test('无效温度和未知字段只显示占位，不产生伪数据',()=>{
  const item=utils.parseLine('state=CONTROL_BLOCKED_STORAGE temp_deci=UNKNOWN foo=<svg/onload=alert(1)>');
  assert.equal(utils.temperature(item.fields.temp_deci),'—');
  assert.equal(item.warning,true);
});

test('WebUI 兼容 SukiSU 同步 stdout 字符串和异步对象返回',()=>{
  const raw='WATCHDOG=RUNNING\nCURRENT_LOG=YES\nCURRENT_BYTES=36699\n';
  assert.equal(utils.unwrapExecResponse(raw),raw);
  assert.equal(utils.unwrapExecResponse({errno:0,stdout:raw,stderr:''}),raw);
  assert.equal(utils.unwrapExecResponse(JSON.stringify({errno:0,stdout:raw})),raw);
  assert.equal(utils.unwrapExecResponse({result:{stdout:raw}}),raw);
  assert.equal(utils.parseStatus(utils.unwrapExecResponse({result:{stdout:raw}})).WATCHDOG,'RUNNING');
});

test('WebUI 命令失败必须显示错误，不把空值当作守护进程未知',()=>{
  assert.throws(()=>utils.unwrapExecResponse({errno:13,stdout:'',stderr:'Permission denied'}),
    /Permission denied/);
  assert.throws(()=>utils.unwrapExecResponse(JSON.stringify({errno:13,stdout:'',stderr:'Permission denied'})),
    /Permission denied/);
  assert.throws(()=>utils.unwrapExecResponse(null),/未返回/);
  assert.throws(()=>utils.unwrapExecResponse({unrelated:'value'}),/返回结构未知/);
  const app=readFileSync(join(dir,'webroot/app.js'),'utf8');
  assert.match(app,/无法识别守护状态/);
  assert.match(app,/unwrapExecResponse/);
});

test('状态响应解析严格使用键值对且忽略小写无关字段',()=>{
  const meta=utils.parseStatus('WATCHDOG=RUNNING\nCURRENT_LOG=YES\nCURRENT_BYTES=1234\nrandom=abc\n');
  assert.equal(meta.WATCHDOG,'RUNNING');
  assert.equal(meta.CURRENT_BYTES,'1234');
  assert.equal(meta.random,undefined);
});

test('界面只展示 oplus-votable 控制状态和电池温度/电压',()=>{
  assert.match(html,/id="voltageState"/);
  assert.match(html,/id="tempState"/);
  assert.match(html,/id="stateName"/);
  assert.doesNotMatch(html,/id="pidState"|id="forceState"/);
  assert.match(app,/CONTROL_STATE/);
  assert.match(app,/controlEntries/);
  assert.match(app,/--battery/);
  assert.match(app,/--votes/);
  assert.match(html,/id="voteList"/);
  assert.match(html,/id="voteEffective"/);
  for (const key of ['diagCurrentProtocol','diagProtocolConfidence','diagPrimaryName',
    'diagForceVal','diagForceActive','diagEffective','diagBatteryCurrent',
    'diagRelatedVotes','diagPower','diagSnapshot','kernelRequest','kernelEvents',
    'kernelRead','copyDiagnostics']) {
    assert.match(html,new RegExp('id="'+key+'"'));
  }
  assert.doesNotMatch(html,/id="diagTarget"|id="diagDisabled"|id="diagChgFull"/);
  assert.match(app,/--kernel-ufcs/);
  assert.match(app,/parseKernelSnapshot/);
  assert.match(app,/paintCurrentProtocol/);
  assert.doesNotMatch(app,/refreshDiagnostics|run\('diagnostics'\)/);
  assert.match(app,/refreshVotes/);
});

test('UFCS 投票行解析包含有效值、普通投票和禁用投票',()=>{
  const raw=[
    'UFCS_CURR: MAX_VOTER:   en=1 v=10900',
    'UFCS_CURR: COOL_DOWN_VOTER:\t\ten=1 v=2000',
    'UFCS_CURR: CABLE_MAX_VOTER: en=0 v=12000',
    'UFCS_CURR: effective=COOL_DOWN_VOTER type=Min v=2000',
  ].join('\n');
  const result=utils.parseVotes(raw);
  assert.deepEqual(result.effective,{name:'COOL_DOWN_VOTER',type:'Min',raw:'2000'});
  assert.equal(result.voters.length,3);
  assert.deepEqual(result.voters[1],{name:'COOL_DOWN_VOTER',enabled:true,raw:'2000'});
  assert.equal(result.voters[2].enabled,false);
  const packed='VOTES_B64='+Buffer.from(raw,'utf8').toString('base64')+'\n';
  assert.equal(utils.decodeVotePayload(packed),raw);
  assert.throws(()=>utils.decodeVotePayload('VOTES_UNAVAILABLE\n'),/读取失败/);
  assert.throws(()=>utils.decodeVotePayload('VOTES_B64=???'),/编码无效/);
  assert.equal(utils.parseVotes('UFCS_CURR: <script>: en=1 v=1').voters.length,0);
});

test('投票值只读接口能返回多行数据，缺失节点时明确提示',t=>{
  const tmp=mkdtempSync(join(tmpdir(),'oplus-votable-votes-'));
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const status=join(tmp,'status');
  const raw=[
    'UFCS_CURR: MAX_VOTER:\t\ten=1 v=10900',
    'UFCS_CURR: COOL_DOWN_VOTER: en=1 v=2000',
    'UFCS_CURR: effective=COOL_DOWN_VOTER type=Min v=2000',
  ].join('\n')+'\n';
  writeFileSync(status,raw);
  const code=readFileSync(backend,'utf8').replace(
    "source='/proc/oplus-votable/UFCS_CURR/status'", "source='"+status+"'");
  const script=join(tmp,'reader.sh');
  writeFileSync(script,code);
  const result=execFileSync('sh',[script,'--votes'],{encoding:'utf8',timeout:3000});
  assert.equal(result.trim().split('\n').length,1);
  assert.equal(utils.decodeVotePayload(result),raw);
  assert.equal(utils.parseVotes(utils.decodeVotePayload(result)).voters.length,2);
  rmSync(status);
  assert.equal(execFileSync('sh',[script,'--votes'],{encoding:'utf8'}).trim(),
    'VOTES_UNAVAILABLE');
});

test('驱动只读诊断读取强制状态、普通投票与 UFCS 禁用状态',t=>{
  const temp=mkdtempSync(join(tmpdir(),'oplus-votable-diag-'));
  t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const uf=join(temp,'UFCS_CURR');
  const disable=join(temp,'UFCS_DISABLE');
  const protocol=join(temp,'ufcs-data');
  const current=join(temp,'current');
  const fs=require('node:fs');
  fs.mkdirSync(uf,{recursive:true});
  fs.mkdirSync(disable,{recursive:true});
  writeFileSync(join(uf,'force_val'),'10700\n');
  writeFileSync(join(uf,'force_active'),'1\n');
  writeFileSync(join(uf,'status'),
    'UFCS_CURR: MAX_VOTER: en=1 v=10900\nUFCS_CURR: effective=COOL_DOWN_VOTER type=Min v=2000\n');
  writeFileSync(join(disable,'status'),
    'UFCS_DISABLE: CHG_FULL_VOTER: en=1 v=1\nUFCS_DISABLE: effective=CHG_FULL_VOTER type=Set_any v=1\n');
  writeFileSync(protocol,'1\n');
  writeFileSync(current,'-4000000\n');
  const code=readFileSync(backend,'utf8')
    .replaceAll('/proc/oplus-votable/UFCS_CURR',uf)
    .replaceAll('/proc/oplus-votable/UFCS_DISABLE/status',join(disable,'status'))
    .replaceAll('/sys/class/oplus_mms/ufcs/data',protocol)
    .replaceAll('/sys/class/power_supply/battery/current_now',current);
  const script=join(temp,'reader.sh');
  writeFileSync(script,code);
  const actual=utils.parseStatus(execFileSync('sh',[script,'--diagnostics'],{encoding:'utf8'}));
  assert.equal(actual.FORCE_ACTIVE,'1');
  assert.equal(actual.FORCE_VAL,'10700');
  assert.equal(actual.UFCS_EFFECTIVE,'2000');
  assert.equal(actual.BATTERY_CURRENT_RAW,'-4000000');
  assert.equal(actual.UFCS_ONLINE,'1');
  assert.equal(actual.UFCS_DISABLED,'1');
  assert.equal(actual.CHG_FULL_ENABLED,'1');
  fs.rmSync(join(uf,'force_active'));
  const failed=utils.parseStatus(execFileSync('sh',[script,'--diagnostics'],{encoding:'utf8'}));
  assert.equal(failed.FORCE_ACTIVE,'UNKNOWN');
});

test('内核 UFCS 请求日志只读提取并标注请求年龄、退出事件',t=>{
  const temp=mkdtempSync(join(tmpdir(),'oplus-votable-kernel-'));
  t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const fs=require('node:fs');
  fs.mkdirSync(join(temp,'bin'),{recursive:true});
  const fixture=join(temp,'dmesg.txt');
  writeFileSync(fixture,[
    '[  987.5000] unrelated login details',
    '[  989.4000] OPLUS_CHG[UFCS]([oplus_ufcs_current_work][5500]): [10600, 11000]',
    '[  990.8000] OPLUS_CHG[ADSP] success set vbus_mv = 11000, ibus_ma = 10700',
    '[  995.2500] OPLUS_CHG[UFCS] normal hw full',
    '[  995.2800] CHG_FULL_VOTER set ufcs disable to true',
    '[  995.3000] OPLUS_CHG[UFCS] exit ufcs fast charge, start ffc',
  ].join('\n')+'\n');
  const dmesg=join(temp,'bin/dmesg');
  writeFileSync(dmesg,"#!/bin/sh\ncat '"+fixture+"'\n");
  fs.chmodSync(dmesg,0o755);
  const uptime=join(temp,'uptime');
  writeFileSync(uptime,'1000.01 2000.11\n');
  const code=readFileSync(backend,'utf8')
    .replace(" /proc/uptime 2>/dev/null", " '"+uptime+"' 2>/dev/null");
  const script=join(temp,'reader.sh');
  writeFileSync(script,code);
  const payload=execFileSync('sh',[script,'--kernel-ufcs'],{
    encoding:'utf8',env:{...process.env,PATH:join(temp,'bin')+':'+process.env.PATH}});
  const snapshot=utils.parseKernelSnapshot(payload);
  assert.equal(snapshot.request.ibusMa,10700);
  assert.equal(snapshot.request.vbusMv,11000);
  assert.equal(snapshot.ageSeconds,9);
  assert.equal(snapshot.exitedAfterRequest,true);
  assert.equal(snapshot.lines.length,5,'其他普通系统日志必须过滤');
  assert.throws(()=>utils.parseKernelSnapshot('KERNEL_NOW_UPTIME=1234;KERNEL_B64=??'),/编码无效/);
  assert.throws(()=>utils.parseKernelSnapshot('NO_DMESG'),/缺少/);
});

test('控制首页仅提供 UFCS/PPS 双协议控制且 VOOC 不可控',()=>{
  const markup=readFileSync(join(dir,'webroot/index.html'),'utf8');
  assert.match(markup,/id="monitorSwitch"/);
  assert.match(markup,/id="monitorState"/);
  assert.match(markup,/role="switch"/);
  assert.doesNotMatch(markup,/id="manualSwitch"|id="manualState"/);
  for (const k of ['UFCS','PPS']) {
    assert.match(markup,new RegExp('id="protoSwitch'+k+'"'));
    assert.match(markup,new RegExp('id="protoState'+k+'"'));
    assert.match(markup,new RegExp('id="protoTag'+k+'"'));
    assert.match(markup,new RegExp('id="targetValue'+k+'"'));
  }
  for (const key of ['control-home','control-detail-UFCS','control-detail-PPS',
    'control-detail-advanced','bottomNav','advSaveStatus']) {
    assert.match(markup,new RegExp('id="'+key+'"'));
  }
  assert.match(markup,/data-detail="UFCS"/);
  assert.match(markup,/data-detail="PPS"/);
  assert.match(markup,/data-detail="advanced"/);
  assert.match(markup,/data-control-back/);
  assert.doesNotMatch(markup,/id="confirmTest"|id="testSwitch"/);
  assert.doesNotMatch(markup,/8 秒|8秒|固定目标 10700|最小投票/);
  assert.ok(markup.indexOf('id="monitorSwitch"')<markup.indexOf('运行概况'),
    '电流控制面板必须位于运行概况之前');
  assert.match(app,/monitorSwitch/);
  assert.match(app,/toggleMonitor/);
  assert.match(app,/toggleProto/);
  assert.match(app,/--monitor-enable/);
  assert.match(app,/--monitor-disable/);
  assert.match(app,/--proto-enable/);
  assert.match(app,/--proto-disable/);
  assert.doesNotMatch(app,/manualSwitch|manualState|toggleManual/);
  assert.doesNotMatch(app,/--manual-enable|--manual-disable/);
  assert.match(app,/MONITOR_ENABLED/);
  assert.match(app,/ACTIVE_PROTOCOL/);
  assert.match(app,/ONLINE_PROTOCOL/);
  assert.doesNotMatch(app,/I_AGREE_LIMIT_ONLY_MANUAL/);
  assert.doesNotMatch(app,/confirmTest/);
  assert.doesNotMatch(app,/testRunning/);
  assert.doesNotMatch(app,/ORIGINAL_UFCS_OR_FORCE_ACTIVE/);
  assert.doesNotMatch(app,/controlDiagnose/);
  assert.doesNotMatch(app,/VOTABLE_DETAIL/);
  assert.doesNotMatch(app,/startTest/);
});

test('WebUI 提供独立电压滑条，UFCS 最高 4660、PPS 最高 4560 且双向联动',()=>{
  const markup=readFileSync(join(dir,'webroot/index.html'),'utf8');
  for (const k of ['UFCS','PPS']) {
    assert.match(markup,new RegExp('id="limitRange'+k+'"'));
    assert.match(markup,new RegExp('id="limitInput'+k+'"'));
    assert.match(markup,new RegExp('id="limitValue'+k+'"'));
    assert.match(markup,new RegExp('id="limitRange'+k+'"[^>]*min="3800"[^>]*max="'+(k==='UFCS'?4660:4560)+'"'));
    assert.match(markup,new RegExp('id="limitInput'+k+'"[^>]*min="3800"[^>]*max="'+(k==='UFCS'?4660:4560)+'"'));
  }
  assert.match(app,/limitRange/);
  assert.match(app,/limitInput/);
  assert.match(app,/--limit-set/);
  assert.match(app,/runLimit/);
  assert.match(app,/LIMIT_MIN = 3800/);
  assert.match(app,/LIMIT_MAX = 4560/);
  // 投票值统一带 mA 单位，且不再引用旧的 capValue / controlCap。
  assert.match(app,/voteText/);
  assert.doesNotMatch(app,/capValue|controlCap|CAP_RAW/);
});

test('WebUI 提供 UFCS/PPS 独立投票上限，PPS 最高 5800',()=>{
  const markup=readFileSync(join(dir,'webroot/index.html'),'utf8');
  for (const k of ['UFCS','PPS']) {
    const top=k==='PPS' ? '5800' : '13500';
    assert.match(markup,new RegExp('id="voteMaxRange'+k+'"'));
    assert.match(markup,new RegExp('id="voteMaxInput'+k+'"'));
    assert.match(markup,new RegExp('id="voteMaxValue'+k+'"'));
    assert.match(markup,new RegExp('id="voteMaxRange'+k+'"[^>]*min="1000"[^>]*max="'+top+'"'));
    assert.match(markup,new RegExp('id="voteMaxInput'+k+'"[^>]*min="1000"[^>]*max="'+top+'"'));
  }
  assert.match(app,/PPS_VOTE_MAX_MAX = 5800/);
  assert.doesNotMatch(markup,/id="protoSwitchVOOC"|id="voteMaxRangeVOOC"/);
  assert.match(app,/voteMaxRange/);
  assert.match(app,/voteMaxInput/);
  assert.match(app,/--vote-max-set/);
  assert.match(app,/runVoteMax/);
  assert.match(app,/VOTE_MAX_MIN = 1000/);
  assert.match(app,/VOTE_MAX_MAX = 13500/);
});

test('电流控制高级参数面板使用预定义命令，且不改动任意输入',()=>{
  const markup=readFileSync(join(dir,'webroot/index.html'),'utf8');
  const advanced=markup.split('id="control-detail-advanced"')[1].split('</section>')[0];
  assert.equal((advanced.match(/class="setting-divider"/g)||[]).length,6);
  for (const [id,value] of [['advInitial','2000'],['advInterval','100'],
    ['advRaise','100'],['advLower','1000'],['advGap','-50']]) {
    assert.match(advanced,new RegExp('id="'+id+'Value">[^<]+</strong> [^·]+· 默认 '+value+'，可调范围'));
  }
  assert.match(advanced,/id="advReset"[^>]*>恢复默认<\/button>/);
  for (const kind of ['Range','Input']) {
    assert.match(advanced,new RegExp('id="advRaise'+kind+'" min="10" max="500" step="10" value="100"'));
    assert.match(advanced,new RegExp('id="advLower'+kind+'" min="100" max="1000" step="10" value="1000"'));
  }
  assert.match(markup,/这里的参数为高级参数，非必要请勿调节/);
  for (const f of ['advInitial','advInterval','advRaise','advLower','advGap','advEarlyGap','advEarlyStep']) {
    assert.match(markup,new RegExp('id="'+f+'Range"'));
    assert.match(markup,new RegExp('id="'+f+'Input"'));
    assert.match(markup,new RegExp('id="'+f+'Value"'));
  }
  assert.match(app,/--vote-initial-set/);
  assert.match(app,/--interval-set/);
  assert.match(app,/--raise-step-set/);
  assert.match(app,/--lower-step-set/);
  assert.match(app,/--cutoff-gap-set/);
  assert.match(app,/runAdv/);
  assert.match(app,/execControl/);
  assert.match(app,/VOTE_INITIAL/);
  assert.match(app,/INTERVAL_MS/);
  assert.match(app,/RAISE_STEP/);
  assert.match(app,/LOWER_STEP/);
  assert.match(app,/CUTOFF_GAP_MV/);
});

test('温度伪装面板只使用预定义命令读写，且不改动温控设置',()=>{
  const markup=readFileSync(join(dir,'webroot/index.html'),'utf8');
  assert.match(markup,/data-detail="faketemp" aria-controls="control-detail-faketemp"/);
  const section=markup.split('id="control-detail-faketemp"')[1].split('</section>')[0];
  for (const id of ['fakeSaveStatus','fakeSwitch','fakeEnabled','fakeStatus',
    'fakeValueRange','fakeValueInput','fakeValueValue','fakeNote','fakeHoraeStatus',
    'fakeAdaptiveSwitch','fakeAdaptiveEnabled','fakeOffsetRange','fakeOffsetInput',
    'fakeOffsetValue','fakeAdaptiveReading','fakeAdaptiveNote']) {
    assert.match(section,new RegExp('id="'+id+'"'));
  }
  assert.match(app,/function paintFake\(/);
  assert.match(app,/function applyFakeStatus\(/);
  assert.match(app,/function refreshFake\(/);
  assert.match(app,/function runFake\(/);
  assert.match(app,/fakeDeci/);
  assert.match(app,/--faketemp-enable/);
  assert.match(app,/--faketemp-disable/);
  assert.match(app,/--faketemp-value-set/);
  assert.match(app,/FAKE_MIN = 20/);
  assert.match(app,/FAKE_MAX = 45/);
  assert.match(app,/FAKETEMP_ENABLED/);
  assert.match(app,/FAKETEMP_VALUE_DECI/);
  assert.match(app,/FAKETEMP_STATE/);
  assert.match(app,/CONTROL_DETAILS = \['UFCS', 'PPS', 'advanced', 'thermal', 'faketemp', 'pulse', 'cv', 'handoff'\]/);
});

test('WebUI 仅使用预定义控制命令，不接受用户输入的任意命令',()=>{
  assert.match(app,/controlStatus: 'sh ' \+ CONTROL \+ ' --status'/);
  assert.match(app,/monitorEnable: 'sh ' \+ CONTROL \+ ' --monitor-enable'/);
  assert.match(app,/monitorDisable: 'sh ' \+ CONTROL \+ ' --monitor-disable'/);
  assert.match(app,/faketempStatus: 'sh ' \+ CONTROL \+ ' --faketemp-status'/);
  assert.match(app,/hasOwnProperty\.call\(ALLOWED_COMMANDS, action\)/);
  assert.doesNotMatch(app,/eval\(/);
  assert.doesNotMatch(app,/controlCheck|controlRun|controlStop|controlDiagnose/);
});

test('WebUI 只接受预定义静态读取命令并用 textContent 绘制日志和投票值',()=>{
  assert.match(app, /window\.ksu\.exec\(/);
  assert.match(app, /log-reader\.sh/);
  assert.match(app, /selectedEntries/);
  assert.match(app, /textContent/);
  assert.doesNotMatch(app,/\.innerHTML\s*=/);
  const cmds=app.match(/sh \' \+ SCRIPT \+ \' --(?:status|latest|previous)\'/g) || [];
  assert.equal(cmds.length,3);
});

test('日志读取脚本 shell 语法正常，拒绝未知命令',()=>{
  execFileSync('sh',['-n',backend],{timeout:3000});
  const invalid=spawnSync('sh',[backend,'--write-force'],{encoding:'utf8',timeout:3000});
  assert.equal(invalid.status,2);
  assert.match(invalid.stderr,/INVALID_ACTION/);
});

test('日志读取脚本在未安装模块环境不创建文件，缺日志给清晰提示',()=>{
  const status=execFileSync('sh',[backend,'--status'],{encoding:'utf8',timeout:3000});
  assert.match(status,/WATCHDOG=(RUNNING|STOPPED)/);
  assert.match(status,/CURRENT_LOG=(YES|NO)/);
  const latest=execFileSync('sh',[backend,'--latest'],{encoding:'utf8',timeout:3000});
  assert.equal(typeof latest,'string');
});

test('只读电池接口正确输出系统温度、电压及缺失值',t=>{
  const tmp=mkdtempSync(join(tmpdir(),'oplus-votable-battery-'));
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const battery=join(tmp,'battery');
  const volt=join(tmp,'voltage');
  const current=join(tmp,'current');
  writeFileSync(battery,'AC powered: true\nUSB powered: false\ntemperature: 351\n');
  writeFileSync(volt,'4280000\n');
  writeFileSync(current,'-4000000\n');
  const code=readFileSync(backend,'utf8')
    .replace('dumpsys battery 2>/dev/null', "cat '"+battery+"' 2>/dev/null")
    .replace('/sys/class/power_supply/battery/voltage_now',volt)
    .replace('/sys/class/power_supply/battery/current_now',current);
  const script=join(tmp,'reader.sh');
  writeFileSync(script,code);
  const result=utils.parseStatus(execFileSync('sh',[script,'--battery'],{encoding:'utf8'}));
  assert.equal(result.BATTERY_TEMP_DECI,'351');
  assert.equal(result.BATTERY_VOLTAGE_UV,'4280000');
  assert.equal(result.BATTERY_CURRENT_RAW,'-4000000');
  assert.equal(result.POWER,'POWERED');
  writeFileSync(volt,'invalid\n');
  writeFileSync(current,'garbage\n');
  const invalid=utils.parseStatus(execFileSync('sh',[script,'--battery'],{encoding:'utf8'}));
  assert.equal(invalid.BATTERY_VOLTAGE_UV,'UNKNOWN');
  assert.equal(invalid.BATTERY_CURRENT_RAW,'UNKNOWN');
});

test('概览首先显示运行概况，移除协商卡片且诊断快照仍可读取',()=>{
  const overview=html.slice(html.indexOf('id="page-overview"'),html.indexOf('id="page-diagnostics"'));
  assert.ok(overview.indexOf('<h2>运行概况')<overview.indexOf('class="protocol-hero"'));
  assert.ok(overview.indexOf('class="protocol-hero"')<overview.indexOf('<h2>协议识别'));
  assert.doesNotMatch(html,/充电器协商与限流排查|id="neg[A-Z]/);
  assert.doesNotMatch(app,/el\('neg[A-Z]|setMetric\('neg[A-Z]|paintNegotiation/);
  assert.doesNotMatch(html,/control-detail-temperature|temperatureSwitch/);
  assert.doesNotMatch(app,/temperature\.sh|temperatureEnable|refreshTemperature/);
  assert.match(app,/negotiation: 'sh ' \+ SCRIPT \+ ' --negotiation'/);
  assert.match(app,/await refreshNegotiation\(\)/);
  assert.match(app,/analyzeNegotiation/);
  assert.doesNotMatch(app,/innerHTML\s*=/);
});

test('PPS: 投票已经生效且输入上限 9V 3A，但不误判 27W 为实测或适配器铭牌',()=>{
  const raw=[
    'USB_ONLINE=1','USB_VOLTAGE_UV=8840000','USB_VOLTAGE_MAX_UV=9000000',
    'USB_CURRENT_MAX_UA=3000000','USB_INPUT_LIMIT_UA=3000000',
    'USB_CURRENT_NOW_UA=0','SOC=80','BATTERY_TEMP_DECI=394',
    'VOTE_PROTOCOL=pps','VOTE_EFFECTIVE=4250',
    'VOTE_OWNER=DEBUG_FORCE_CLIENT','VOTE_FORCE_ACTIVE=1','VOTE_FORCE_VAL=4250',
    'WIRED_ICL_EFFECTIVE=3000','WIRED_ICL_OWNER=PD_PDO_ICL_VOTER',
    'WIRED_FCC_EFFECTIVE=2200','WIRED_FCC_OWNER=SPEC_VOTER',
  ].join(';');
  const context={protocolId:'PPS',activeProtocol:'PPS',controlState:'RUNNING',targetRaw:'4250'};
  const state=utils.analyzeNegotiation(raw,context);
  assert.equal(state.voltageV,8.84);
  assert.equal(state.reportedMaxA,3);
  assert.equal(state.inputLimitA,3);
  assert.equal(state.maxVoltageV,9);
  assert.equal(state.reportedPowerReferenceW,26.52);
  assert.equal(state.measuredInputPowerW,null,'USB 电流为 0 不能显示实测 0W');
  assert.deepEqual([state.vote.node,state.vote.effective,state.vote.forceActive],
    ['PPS_CURR',4250,true]);
  assert.match(state.voteStatus,/投票链路已确认/);
  assert.match(state.supplyStatus,/不是硬上限或实测功率/);
  assert.match(state.supplyStatus,/无法仅凭这些字段确认充电器 APDO/);
  assert.match(state.thermalStatus,/电量\/温度可能触发/);
  assert.equal(state.wiredIcl,'3000');
  const bad=utils.analyzeNegotiation(raw,{...context,targetRaw:'5000'});
  assert.match(bad.voteStatus,/不一致/);
  const mismatched=utils.analyzeNegotiation(raw,{...context,protocolId:'UFCS'});
  assert.equal(mismatched.vote,null,'协议不一致时不能用 PPS 票当 UFCS 的票');
});

test('PPS 策略限额 2A 不得错误压低 USB 报告功率参考值',()=>{
  const raw='USB_ONLINE=1;USB_VOLTAGE_UV=8840000;USB_CURRENT_MAX_UA=3000000;'+
    'USB_INPUT_LIMIT_UA=2000000;USB_CURRENT_NOW_UA=0;VOTE_PROTOCOL=pps';
  const reading=utils.analyzeNegotiation(raw);
  assert.equal(reading.inputLimitA,2);
  assert.equal(reading.reportedMaxA,3);
  assert.equal(reading.reportedPowerReferenceW,26.52);
  assert.equal(reading.measuredInputPowerW,null);
  assert.match(reading.supplyStatus,/不参与功率计算/);
  assert.match(reading.supplyStatus,/不是硬上限或实测功率/);
  assert.doesNotMatch(html,/USB 报告功率参考值（非上限）/);
  assert.doesNotMatch(app,/inputPowerCeilingW|inputLimitCeilingA/);
});

test('协商缺失、拔线残留、不可信值不会形成虚假的充电器结论',()=>{
  assert.throws(()=>utils.analyzeNegotiation('USB_CURRENT_MAX_UA=3000000'),
    /响应不完整/);
  const stale=utils.analyzeNegotiation(
    'USB_ONLINE=0;USB_VOLTAGE_UV=8900000;USB_CURRENT_MAX_UA=3000000;'+
    'USB_INPUT_LIMIT_UA=3000000;VOTE_PROTOCOL=pps;VOTE_FORCE_ACTIVE=1');
  assert.equal(stale.voltageV,null);
  assert.equal(stale.reportedPowerReferenceW,null);
  assert.equal(stale.vote,null);
  assert.match(stale.supplyStatus,/未检测到 USB 供电/);
  const bad=utils.analyzeNegotiation(
    'USB_ONLINE=1;USB_VOLTAGE_UV=<script>;USB_CURRENT_MAX_UA=123456789012;'+
    'USB_INPUT_LIMIT_UA=UNKNOWN;VOTE_PROTOCOL=none;SOC=999');
  assert.equal(bad.voltageV,null);
  assert.equal(bad.reportedMaxA,null);
  assert.equal(bad.reportedPowerReferenceW,null);
  assert.equal(bad.soc,null);
});

test('协商采集固定读取 sysfs 和三个原有 Votable，离线模拟数据通过',t=>{
  const tmp=mkdtempSync(join(tmpdir(),'oplus-votable-neg-'));
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const usb=join(tmp,'usb'), bat=join(tmp,'battery'),
    mms=join(tmp,'mms'), votes=join(tmp,'votables');
  for (const path of [usb,bat,mms,votes]) mkdirSync(path,{recursive:true});
  const put=(path,text)=>writeFileSync(path,text+'\n');
  for (const key of ['ufcs','vooc','pps']) {
    const path=join(mms,key);
    mkdirSync(path);
    put(join(path,'item_id'),'0');
    put(join(path,'data'),key==='pps' ? '1' : '0');
  }
  for (const [key,val] of Object.entries({online:'1',voltage_now:'8840000',
    voltage_max:'9000000',current_max:'3000000',input_current_limit:'3000000',
    current_now:'0'})) put(join(usb,key),val);
  put(join(bat,'capacity'),'80');
  put(join(bat,'temp'),'394');
  for (const name of ['PPS_CURR','WIRED_ICL','WIRED_FCC']) {
    mkdirSync(join(votes,name));
    put(join(votes,name,'status'),
      name+': effective='+ (name==='PPS_CURR' ? 'DEBUG_FORCE_CLIENT' : 'MAX_VOTER') +
      ' type=Min v='+ (name==='PPS_CURR'?'4250':'3000'));
  }
  put(join(votes,'PPS_CURR','force_active'),'1');
  put(join(votes,'PPS_CURR','force_val'),'4250');
  const script=join(tmp,'reader.sh');
  writeFileSync(script,readFileSync(backend,'utf8')
    .replaceAll('/sys/class/power_supply/usb',usb)
    .replaceAll('/sys/class/power_supply/battery',bat)
    .replaceAll('/sys/class/oplus_mms',mms)
    .replaceAll('/proc/oplus-votable',votes));
  const raw=execFileSync('sh',[script,'--negotiation'],{encoding:'utf8',timeout:7000});
  assert.equal(raw.trim().split('\n').length,1);
  const data=utils.parseStatus(raw);
  assert.equal(data.USB_VOLTAGE_UV,'8840000');
  assert.equal(data.VOTE_PROTOCOL,'pps');
  assert.equal(data.VOTE_EFFECTIVE,'4250');
  assert.equal(data.VOTE_OWNER,'DEBUG_FORCE_CLIENT');
  assert.equal(data.VOTE_FORCE_ACTIVE,'1');
  assert.equal(data.WIRED_ICL_EFFECTIVE,'3000');
  assert.equal(utils.analyzeNegotiation(raw,{
    protocolId:'PPS',activeProtocol:'PPS',controlState:'RUNNING',targetRaw:'4250'
  }).vote.effective,4250);
  put(join(usb,'online'),'0');
  const offline=utils.parseStatus(execFileSync('sh',[script,'--negotiation'],
    {encoding:'utf8',timeout:7000}));
  assert.equal(offline.USB_VOLTAGE_UV,'UNKNOWN');
  assert.equal(offline.USB_CURRENT_MAX_UA,'UNKNOWN');
  assert.equal(offline.WIRED_ICL_EFFECTIVE,'UNKNOWN');
  const section=readFileSync(script,'utf8').split('  --negotiation)')[1]
    .split('  --votables)')[0];
  assert.doesNotMatch(section,/ > [^\n]*\/(?:force_val|force_active|vote|check_points)/);
  assert.doesNotMatch(section,/\b(?:overwrite|publish|clean_overwrite)\b/);
});

test('临时日志目录中的当前/轮转日志都可读取，且状态元信息可解析', t=>{
  const tmp=mkdtempSync(join(tmpdir(),'oplus-votable-logs-'));
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const code=readFileSync(backend,'utf8').replace(
    "DIR='/data/adb/oplus-votable'", "DIR='"+tmp+"'");
  const script=join(tmp,'reader.sh');
  writeFileSync(script,code);
  const line='epoch=1791751140 time=200 state=CONTROL_FINISHED_PROTOCOL_CHANGED write=NEVER';
  writeFileSync(join(tmp,'events.log'),line+'\n');
  writeFileSync(join(tmp,'events.log.prev'),'time=190 state=CONTROL_BLOCKED_STORAGE write=NEVER\n');
  const latest=execFileSync('sh',[script,'--latest'],{encoding:'utf8',timeout:3000});
  const previous=execFileSync('sh',[script,'--previous'],{encoding:'utf8',timeout:3000});
  assert.equal(latest.trim().split('\n').length,1,'SukiSU桥接只返回最后一行时仍需拿到完整日志');
  assert.equal(previous.trim().split('\n').length,1);
  assert.equal(utils.parseLines(utils.decodeLogPayload(latest))[0].state,'CONTROL_FINISHED_PROTOCOL_CHANGED');
  assert.equal(utils.parseLines(utils.decodeLogPayload(previous))[0].state,'CONTROL_BLOCKED_STORAGE');
  const info=utils.parseStatus(execFileSync('sh',[script,'--status'],{encoding:'utf8',timeout:3000}));
  assert.equal(info.WATCHDOG,'STOPPED');
  assert.equal(info.CURRENT_LOG,'YES');
  assert.equal(info.PREVIOUS_LOG,'YES');
  const packed=execFileSync('sh',[script,'--status'],{encoding:'utf8',timeout:3000});
  assert.equal(packed.trim().split('\n').length,1,'完整的WATCHDOG和日志信息在最后一行');
  assert.match(packed,/WATCHDOG=STOPPED;CURRENT_LOG=YES;/);
  assert.ok(Number(info.CURRENT_BYTES)>0);
});

test('WebUI 可完整恢复以一行 base64 传输的多行中文日志',()=>{
  const lines='epoch=1791751140 state=CONTROL_FINISHED_PROTOCOL_CHANGED\nepoch=1791751141 state=CONTROL_BLOCKED_STORAGE 文本测试\n';
  const packed='LOG_B64='+Buffer.from(lines,'utf8').toString('base64')+'\n';
  assert.equal(utils.decodeLogPayload(packed),lines);
  assert.equal(utils.parseLines(utils.decodeLogPayload(packed)).length,2);
  assert.equal(utils.decodeLogPayload('NO_LOGS_YET\n'),'NO_LOGS_YET\n');
  assert.throws(()=>utils.decodeLogPayload('LOG_B64=???'),/编码无效/);
});

test('单行状态信息能兼容旧多行和 SukiSU 仅返回最后一行的情形',()=>{
  const line='WATCHDOG=RUNNING;CURRENT_LOG=YES;CURRENT_BYTES=10654;PREVIOUS_LOG=YES';
  const state=utils.parseStatus(line);
  assert.equal(state.WATCHDOG,'RUNNING');
  assert.equal(state.PREVIOUS_LOG,'YES');
  const previousError='PREVIOUS_LOG=YES';
  assert.equal(utils.parseStatus(previousError).WATCHDOG,undefined);
});



test('多页面 WebUI：底部导航可切换概览、控制、诊断、日志',()=>{
  for (const name of ['overview','control','history','diagnostics','logs']) {
    assert.match(html, new RegExp('id="page-' + name + '"'));
    assert.match(html, new RegExp('id="tab-' + name + '"'));
    assert.match(html, new RegExp('aria-controls="page-' + name + '"'));
  }
  assert.match(html,/role="tablist"/);
  assert.match(html,/class="bottom-nav"/);
  assert.match(app,/function switchPage\(/);
  assert.match(app,/function showControlDetail\(/);
  assert.doesNotMatch(app,/hashchange|location\.hash\s*=|history\.pushState|history\.replaceState/);
  assert.ok(html.indexOf('id="updated"') < html.indexOf('id="protocolName"'));
  assert.ok(html.indexOf('id="page-diagnostics"') < html.indexOf('id="voteList"'));
});


test('当前协议诊断排在诊断页最前面，UFCS 历史信息独立收起',()=>{
  const page=html.indexOf('id="page-diagnostics"');
  const current=html.indexOf('id="diagCurrentProtocol"');
  const all=html.indexOf('id="votableGroups"');
  const ufcs=html.indexOf('id="voteList"');
  const history=html.indexOf('aria-label="UFCS 专用内核历史日志"');
  assert.ok(page<current && current<all && all<ufcs && ufcs<history);
  assert.match(html,/<h2>当前充电协议诊断<\/h2>/);
  assert.doesNotMatch(html,/<h2>驱动只读诊断<\/h2>/);
  assert.match(app,/currentProtocol = result/);
  assert.match(app,/paintCurrentProtocol\(\)/);
  assert.match(app,/protocolVoteSelection\(protocol, votableRows\)/);
  assert.doesNotMatch(app,/diagData\./);
});

test('协议关联投票可自动适配 UFCS、PPS、VOOC、无线及普通有线',()=>{
  const names=['UFCS_CURR','UFCS_DISABLE','VOOC_CURR','PPS_CURR','WLS_FCC',
    'WLS_NOR_ICL','WIRED_FCC','WIRED_ICL','WIRED_CHARGING_DISABLE']
    .map(name=>({name,effective:{name:'MAX_VOTER',type:'Min',raw:'6500'},
      forceActive:'0',forceVal:'1000',voters:[]}));
  const select=id=>utils.protocolVoteSelection({id},names);
  assert.equal(select('UFCS').primary.name,'UFCS_CURR');
  assert.deepEqual(select('UFCS').rows.map(x=>x.name),
    ['UFCS_CURR','UFCS_DISABLE','WIRED_FCC','WIRED_ICL']);
  assert.equal(select('VOOC').primary.name,'VOOC_CURR');
  assert.equal(select('PPS').primary.name,'PPS_CURR');
  assert.equal(select('WIRELESS').primary.name,'WLS_FCC');
  assert.equal(select('WIRELESS').rows.some(x=>x.name==='WIRED_FCC'),false);
  for(const id of ['PD','QC','DCP','CDP','SDP']) {
    assert.equal(select(id).primary.name,'WIRED_FCC');
    assert.match(select(id).note,/共享有线充电投票/);
    assert.equal(select(id).rows.some(x=>x.name==='UFCS_CURR'),false);
  }
  for(const id of ['UNKNOWN','NONE']) {
    assert.equal(select(id).primary,null);
    assert.deepEqual(select(id).rows,[]);
    assert.equal(select(id).expected,0);
  }
  const empty=utils.protocolVoteSelection({id:'PPS'},[]);
  assert.equal(empty.primary,null);
  assert.equal(empty.expected>0,true);
  assert.deepEqual(utils.protocolVoteSelection(null,names).rows,[]);
});

test('充电协议识别优先信任明确 OPLUS 状态，并拒绝在线冲突',()=>{
  const parse = utils.identifyProtocol;
  assert.equal(parse('UFCS=1;VOOC=0;PPS=0;USB_REAL_TYPE=USB_DCP;POWER=YES').id,'UFCS');
  assert.equal(parse('UFCS=0;VOOC=1;PPS=0;USB_REAL_TYPE=USB_DCP;POWER=YES').name,'VOOC / SUPERVOOC');
  assert.equal(parse('UFCS=0;VOOC=0;PPS=1;USB_REAL_TYPE=USB_PD;POWER=YES').id,'PPS');
  assert.equal(parse('UFCS=1;VOOC=1;PPS=0;POWER=YES').id,'UNKNOWN');
  assert.equal(parse('UFCS=1;VOOC=0;PPS=0;WIRELESS_ONLINE=1;POWER=YES').id,'UNKNOWN');
  assert.equal(parse('UFCS=1;VOOC=0;PPS=0;USB_ONLINE=0;WIRELESS_ONLINE=0;POWER=NO').id,'NONE');
});

test('USB 充电协议 fallback 覆盖 PD/PPS/QC 与基础类型，未知时不猜测',()=>{
  const parse = utils.identifyProtocol;
  for (const [hint,id] of [
    ['USB_PD','PD'], ['USB_PD_PPS','PPS'], ['HVDCP_3','QC'],
    ['USB_DCP','DCP'], ['USB_CDP','CDP'], ['USB_SDP','SDP'],
  ]) {
    assert.equal(parse('USB_REAL_TYPE='+hint+';POWER=YES').id,id,hint);
  }
  assert.equal(parse('USB_REAL_TYPE=UNKNOWN;PD_ACTIVE=1;POWER=YES').id,'PD');
  assert.equal(parse('USB_REAL_TYPE=UNKNOWN;PD_ACTIVE=1;PPS_ACTIVE=1;POWER=YES').id,'PPS');
  assert.equal(parse('WIRELESS_ONLINE=1;POWER=YES').id,'WIRELESS');
  assert.equal(parse('POWER=YES;CPA_ITEM_ID=0;CPA_DATA=4').id,'UNKNOWN');
  assert.match(parse('USB_REAL_TYPE=USB_DCP;POWER=YES').reason,/不能排除/);
});

test('--protocol 为单行只读快照；MMS item_id 非 0 时不能解释 data',t=>{
  const fs = require('node:fs');
  const tmp = mkdtempSync(join(tmpdir(),'ufcs-protocol-'));
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const mms = join(tmp,'oplus_mms');
  const usb = join(tmp,'usb');
  const wireless = join(tmp,'wireless');
  for (const p of [join(mms,'ufcs'),join(mms,'vooc'),join(mms,'pps'),
    join(mms,'cpa'),usb,wireless]) fs.mkdirSync(p,{recursive:true});
  const put=(p,v)=>writeFileSync(p,String(v)+'\n');
  for (const name of ['ufcs','vooc','pps']) {
    put(join(mms,name,'item_id'),'0');
    put(join(mms,name,'data'),'0');
  }
  put(join(mms,'ufcs/data'),'1');
  put(join(mms,'vooc/item_id'),'5');
  put(join(mms,'vooc/data'),'1');
  put(join(usb,'real_type'),'USB_DCP');
  put(join(usb,'online'),'1');
  put(join(wireless,'online'),'0');
  const dump=join(tmp,'battery');
  put(dump,'AC powered: false\nUSB powered: true\nWireless powered: false');
  const code=readFileSync(backend,'utf8')
    .replace("mms='/sys/class/oplus_mms'", "mms='"+mms+"'")
    .replace("usb='/sys/class/power_supply/usb'", "usb='"+usb+"'")
    .replace('/sys/class/power_supply/wireless/online',join(wireless,'online'))
    .replace('dumpsys battery 2>/dev/null',"cat '"+dump+"' 2>/dev/null");
  const script=join(tmp,'reader.sh');
  writeFileSync(script,code);
  const out=execFileSync('sh',[script,'--protocol'],{encoding:'utf8'});
  assert.equal(out.trim().split('\n').length,1);
  const data=utils.parseStatus(out);
  assert.equal(data.UFCS,'1');
  assert.equal(data.VOOC,'UNKNOWN');
  assert.equal(data.PPS,'0');
  assert.equal(utils.identifyProtocol(out).id,'UFCS');
  assert.equal(readFileSync(join(mms,'vooc/item_id'),'utf8').trim(),'5');
});


test('完整 Votable 解析支持六类分组、普通投票及强制开关',()=>{
  const raw = [
    'G\tUFCS_CURR\t0\t5450',
    'V\tUFCS_CURR\tMAX_VOTER\t1\t10900',
    'V\tUFCS_CURR\tCOOL_DOWN_VOTER\t0\t2000',
    'E\tUFCS_CURR\tMAX_VOTER\tMin\t10900',
    'G\tFV_MAX\t?\t?',
    'V\tFV_MAX\tSPEC_VOTER\t1\t4510',
    'E\tFV_MAX\tSPEC_VOTER\tMax\t4510',
    'G\tWLS_FCC\t1\t2000',
    'E\tWLS_FCC\tnone\tMin\t-22',
    'G\tPPS_DISABLE\t0\t0',
    'E\tPPS_DISABLE\tCP_OFFLINE_VOTER\tSet_any\t0',
    'G\tVOOC_CURR\t0\t11000',
    'E\tVOOC_CURR\tDEF_VOTER\tMin\t11000',
    'G\tVENDOR_EXTRA\t?\t?',
    'R\tVENDOR_EXTRA\tUNREADABLE',
  ].join('\n') + '\n';
  const packed = 'VOTABLES_B64=' + Buffer.from(raw).toString('base64') + '\n';
  const items = utils.parseVotables(utils.decodeVotablesPayload(packed));
  assert.equal(items.length, 6);
  assert.equal(items[0].name, 'UFCS_CURR');
  assert.equal(items[0].group, 'ufcs');
  assert.equal(items[0].forceActive, '0');
  assert.equal(items[0].forceVal, '5450');
  assert.deepEqual(items[0].effective,{name:'MAX_VOTER',type:'Min',raw:'10900'});
  assert.equal(items[0].voters[1].enabled,false);
  assert.equal(items[1].group,'wired');
  assert.equal(items[1].effective.type,'Max');
  assert.equal(items[2].group,'wireless');
  assert.equal(items[2].forceActive,'1');
  assert.equal(items[2].effective.raw,'-22');
  assert.equal(items[3].effective.type,'Set_any');
  assert.equal(items[4].group,'vooc');
  assert.equal(items[5].group,'other');
  assert.equal(items[5].error,'status 不可读取');
  assert.equal(Object.keys(utils.votableDescriptions).length,46);
});

test('Votable 数据严格过滤恶意字段、重复目录、非法编码',()=>{
  assert.throws(()=>utils.decodeVotablesPayload('VOTABLES_UNAVAILABLE'),/不可用/);
  assert.throws(()=>utils.decodeVotablesPayload('VOTABLES_B64=%%%'),/编码异常/);
  assert.throws(()=>utils.decodeVotablesPayload('VOTABLES_B64='+
    'A'.repeat(500001)),/编码异常/);
  const raw = [
    'G\tUFCS_CURR\t0\t42',
    'V\tUFCS_CURR\t<script>\t1\t1000',
    'V\tUFCS_CURR\tNORMAL_VOTER\t1\t1000',
    'E\tUFCS_CURR\tOWNER\tWhatever\t1000',
    'E\tUFCS_CURR\tOWNER\tMin\t1000',
    'G\tUFCS_CURR\t1\t2500',
    'G\tLOWERCASE\t1\tbad-value',
    'G\t../../etc\t0\t0',
    'V\tMISSING\tOWNER\t1\t1000',
  ].join('\n');
  const items=utils.parseVotables(raw);
  assert.equal(items.length,2);
  assert.equal(items[0].forceActive,'0');
  assert.equal(items[0].voters.length,1);
  assert.equal(items[0].effective.type,'Min');
  assert.equal(items[1].forceVal,'?');
});

test('全目录 Shell 只读快照在模拟 /proc 下完整解析且拒绝伪造目录',t=>{
  const fs = require('node:fs');
  const tmp=mkdtempSync(join(tmpdir(),'oplus-votable-all-'));
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const root=join(tmp,'votables');
  fs.mkdirSync(root);
  const putDir=(name,status,forceActive,forceVal)=>{
    const path=join(root,name);
    fs.mkdirSync(path);
    if (status !== null) writeFileSync(join(path,'status'),status);
    writeFileSync(join(path,'force_active'),forceActive+'\n');
    writeFileSync(join(path,'force_val'),forceVal+'\n');
  };
  putDir('UFCS_CURR',[
    'UFCS_CURR: MAX_VOTER:\t\ten=1 v=10900',
    'UFCS_CURR: BAD_TEMP_VOTER: en=0 v=1000',
    'UFCS_CURR: effective=MAX_VOTER type=Min v=10900',
    'UFCS_CURR: FAKE_VOTER: en=1 v=0 > /proc/danger',
  ].join('\n')+'\n','0','5450');
  putDir('CHG_DISABLE','CHG_DISABLE: effective=TIMEOUT_VOTER type=Set_any v=0\n','1','0');
  putDir('PPS_CURR',null,'?','??');
  putDir('name;touch hacked','PPS_CURR: effective=none type=Min v=-22\n','1','100');
  const source=readFileSync(backend,'utf8').replace(
    "votable_root='/proc/oplus-votable'","votable_root='"+root+"'");
  const script=join(tmp,'reader.sh');
  writeFileSync(script,source);
  const result=execFileSync('sh',[script,'--votables'],{encoding:'utf8',timeout:10000});
  assert.equal(result.trim().split('\n').length,1);
  const parsed=utils.parseVotables(utils.decodeVotablesPayload(result));
  assert.equal(parsed.length,3);
  const ufcs=parsed.find(x=>x.name==='UFCS_CURR');
  assert.deepEqual(ufcs.effective,{name:'MAX_VOTER',type:'Min',raw:'10900'});
  assert.equal(ufcs.voters.length,2);
  assert.equal(ufcs.forceActive,'0');
  assert.equal(ufcs.forceVal,'5450');
  assert.equal(parsed.find(x=>x.name==='CHG_DISABLE').forceActive,'1');
  assert.equal(parsed.find(x=>x.name==='PPS_CURR').error,'status 不可读取');
  assert.equal(fs.existsSync(join(tmp,'hacked')),false);
  assert.ok(!source.includes('> "$dir/vote"'));
  fs.rmSync(root,{recursive:true});
  assert.equal(execFileSync('sh',[script,'--votables'],{encoding:'utf8'}).trim(),
    'VOTABLES_UNAVAILABLE');
});

test('诊断页新增全 Votable 浏览区和只读刷新命令，不引入任意路径执行',()=>{
  for (const id of ['votableCategory','votableSearch','votableRefresh',
    'votableSummary','votableGroups']) {
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(app,/votables: 'sh ' \+ SCRIPT \+ ' --votables'/);
  assert.match(app,/function refreshVotables\(/);
  assert.match(app,/function renderVotables\(/);
  assert.match(app,/document\.createElement\('details'\)/);
  assert.doesNotMatch(app,/refreshVotablesIfNeeded/);
  assert.equal((app.match(/run\('votables'\)/g)||[]).length,1,
    '只能由手动按钮读取完整驱动目录');
  assert.doesNotMatch(app,/\.innerHTML\s*=/);
  assert.doesNotMatch(backend,/\b(?:eval|pkill|killall|chmod)\b/);
});

test('服务端 Shell 只读访问日志目录，没有充电节点写入',()=>{
  const shell=readFileSync(backend,'utf8');
  const commands=shell.split('\n').filter(line=>!line.trim().startsWith('#')).join('\n');
  assert.match(shell, /\/data\/adb\/oplus-votable/);
  assert.match(commands, /\/proc\/oplus-votable\/UFCS_CURR\/status/);
  assert.match(commands, /\[ ! -r "\$source" \]/);
  assert.doesNotMatch(commands, /\b(?:pkill|killall|setprop|chmod|rm|mv)\b/);
  assert.doesNotMatch(commands, /\b(?:echo|printf)\s+[^\n]*>\s*\/proc/);
  assert.doesNotMatch(commands, /\b(?:echo|printf)\s+[^\n]*>\s*"?\$uf\/force_/);
});
