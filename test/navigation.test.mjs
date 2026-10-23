import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const dir=resolve(fileURLToPath(new URL('..',import.meta.url)));
const html=readFileSync(join(dir,'webroot/index.html'),'utf8');
const script=readFileSync(join(dir,'webroot/app.js'),'utf8');
const require=createRequire(import.meta.url);
const parser=require('../webroot/log-utils.js');
const chargingHistory=require('../webroot/charging-history.js');

function mockElement(id='') {
  const listeners=new Map();
  return {
    id, hidden:false, disabled:false, checked:false, open:false, value:'', textContent:'',
    className:'', dataset:{}, style:{}, tabIndex:0, children:[],
    clientWidth:360, clientHeight:id==='historyCanvas'?300:420,
    getBoundingClientRect() { return {left:0,width:this.clientWidth}; },
    setPointerCapture() {},
    getContext() {
      if (!this.context) {
        const calls=[];this.context={calls};
        for (const name of ['setTransform','clearRect','beginPath','moveTo','lineTo','fillText','save','rect','clip','stroke','arc','fill','setLineDash','restore']) {
          this.context[name]=(...args)=>calls.push({name,args,stroke:this.context.strokeStyle});
        }
      }
      return this.context;
    },
    addEventListener(type,fn) { listeners.set(type,fn); },
    emit(type,event={}) { return listeners.get(type)?.({preventDefault(){},...event}); },
    setAttribute(name,value) { this[name]=value; },
    getAttribute() { return '测试输入框'; },
    append(...items) { this.children.push(...items); },
    appendChild(node) { this.children.push(node); return node; },
    replaceChildren(...items) { this.children=[...items]; },
    querySelectorAll() { return []; },
    focus() {},
    remove() {},
    showModal() { this.open=true; },
    close() { this.open=false; },
  };
}

function openWebUi(settings={},onSet,onCommand,bridge,storage=new Map()) {
  const ids=[...html.matchAll(/id="([^"]+)"/g)].map(x=>x[1]);
  assert.equal(new Set(ids).size,ids.length,'DOM id 不得重复');
  const map=new Map(ids.map(id=>[id,mockElement(id)]));
  for(const [tag,id] of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    map.get(id).hidden=/\shidden(?:\s|>)/.test(tag);
  }
  for (const [tag] of html.matchAll(/<input\b[^>]*>/g)) {
    const id=/id="([^"]+)"/.exec(tag)?.[1];
    if (id) {
      map.get(id).value=/value="([^"]*)"/.exec(tag)?.[1] || '';
      map.get(id).max=/max="([^"]*)"/.exec(tag)?.[1] || '';
    }
  }
  const entries=['UFCS','PPS','advanced','thermal','faketemp','pulse','cv','handoff'].map(id=>{
    const n=mockElement();n.dataset.detail=id;return n;
  });
  const backs=entries.map(()=>mockElement());
  const timers=[];
  const doc={
    hidden:false, activeElement:null, body:mockElement(),
    getElementById(id) {
      assert.ok(map.has(id),'missing DOM id '+id);return map.get(id);
    },
    createElement:()=>mockElement(),
    createDocumentFragment:()=>mockElement(),
    createTextNode:text=>({textContent:text}),
    querySelectorAll(q) {
      if(q==='[data-detail]') return entries;
      if(q==='[data-control-back]') return backs;
      return [];
    },
    addEventListener(){},
  };
  let writes=0, scans=0;
  const window={
    OplusVotableLog:parser,
    OplusChargingHistory:chargingHistory,
    devicePixelRatio:2,
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    scrollTo(){},
    ksu:{async exec(cmd) {
      const response=await onCommand?.(cmd);
      if(response !== undefined) return response;
      if(cmd.includes('--votables')) {scans++;return 'VOTABLES_UNAVAILABLE';}
      const setter=/--(vote-initial|interval|raise-step|lower-step|cutoff-gap|early-gap|early-step|thermal-limit|thermal-vote|thermal-gap|cv-start|cv-offset|cv-band|cv-raise|cv-lower|cv-wait|cv-fast-gap)-set (-?\d+)$/.exec(cmd);
      if(setter) {
        const keys={'vote-initial':'VOTE_INITIAL',interval:'INTERVAL_MS',
          'raise-step':'RAISE_STEP','lower-step':'LOWER_STEP','cutoff-gap':'CUTOFF_GAP_MV','early-gap':'EARLY_GAP_MV','early-step':'EARLY_STEP_MA',
          'thermal-limit':'THERMAL_LIMIT_C','thermal-vote':'THERMAL_VOTE_MA','thermal-gap':'THERMAL_GAP_C',
          'cv-start':'CV_START_SOC','cv-offset':'CV_OFFSET_MV','cv-band':'CV_BAND_MV','cv-raise':'CV_RAISE_MA','cv-lower':'CV_LOWER_MA','cv-wait':'CV_WAIT_MS','cv-fast-gap':'CV_FAST_GAP_MV'};
        writes++;
        await onSet?.(setter[1],setter[2]);
        settings[keys[setter[1]]]=setter[2];
        return keys[setter[1]]+'='+setter[2];
      }
      const protoSetter=/--(limit-set|vote-max-set) (ufcs|pps) (\d+)$/.exec(cmd);
      if(protoSetter) {
        writes++;
        await onSet?.(protoSetter[1],protoSetter[3],protoSetter[2]);
        const key=protoSetter[2].toUpperCase()+(protoSetter[1]==='limit-set'?'_LIMIT_MV':'_VOTE_MAX');
        settings[key]=protoSetter[3];
        return key+'='+protoSetter[3];
      }
      if(/--(monitor-enable|monitor-disable)/.test(cmd)) writes++;
      if(/--pulse-(enable|disable)$/.test(cmd)) {
        writes++; await onSet?.('pulse-enabled');
        settings.PULSE_ENABLED=cmd.endsWith('--pulse-enable')?'YES':'NO';return 'PULSE_SAVED';
      }
      const pulseSetter=/--pulse-(charge|pause)-set (\d+)$/.exec(cmd);
      if(pulseSetter) {
        writes++;await onSet?.('pulse-'+pulseSetter[1],pulseSetter[2]);
        settings[pulseSetter[1]==='charge'?'PULSE_CHARGE_S':'PULSE_PAUSE_MS']=pulseSetter[2];return 'PULSE_SAVED';
      }
      const pulseRange=/--pulse-range-(set|delete) ([0-9,]+)$/.exec(cmd);
      if(pulseRange) {
        writes++;await onSet?.('pulse-range-'+pulseRange[1],pulseRange[2]);
        const rows=(settings.PULSE_RANGES && settings.PULSE_RANGES!=='NONE'?settings.PULSE_RANGES.split(':'):[]).filter(row=>row!==pulseRange[2]);
        if(pulseRange[1]==='set')rows.push(pulseRange[2]);
        settings.PULSE_RANGES=rows.sort((a,b)=>Number(a.split(',')[0])-Number(b.split(',')[0])).join(':')||'NONE';return 'PULSE_SAVED';
      }
      const pulseStatus=['PULSE_ENABLED=NO','PULSE_CHARGE_S=5','PULSE_PAUSE_MS=1000','PULSE_RANGES=NONE','PULSE_CONFIG_VALID=YES','PULSE_SOC=50','PULSE_STATE=OFF','PULSE_REMAIN_MS=0',
        ...Object.entries(settings).map(([key,value])=>key+'='+value)].join(';');
      if(cmd.endsWith('--pulse-status'))return pulseStatus;
      if(/--soc-(enable|disable)$/.test(cmd)) {
        writes++; await onSet?.('soc-enabled');
        settings.SOC_ENABLED=cmd.endsWith('--soc-enable')?'YES':'NO';
        return 'SOC_SAVED';
      }
      if(/--faketemp-(enable|disable)$/.test(cmd)) {
        writes++;await onSet?.('faketemp-enabled');
        const enabled=cmd.endsWith('--faketemp-enable');
        settings.FAKETEMP_ENABLED=enabled?'YES':'NO';
        settings.FAKETEMP_ADAPTIVE_ENABLED='NO';
        settings.FAKETEMP_STATE=enabled?'APPLIED':'OFF';
        settings.FAKETEMP_HORAE_STATE=enabled?'TEST_SENT':'NORMAL_SENT';return 'FAKETEMP_SAVED';
      }
      if(/--faketemp-adaptive-(enable|disable)$/.test(cmd)) {
        writes++;await onSet?.('faketemp-adaptive');
        const enabled=cmd.endsWith('--faketemp-adaptive-enable');
        settings.FAKETEMP_ADAPTIVE_ENABLED=enabled?'YES':'NO';settings.FAKETEMP_ENABLED='NO';
        settings.FAKETEMP_STATE=enabled?'APPLIED':'OFF';settings.FAKETEMP_HORAE_STATE=enabled?'TEST_SENT':'NORMAL_SENT';
        settings.FAKETEMP_REAL_DECI='400';settings.FAKETEMP_TARGET_DECI=String(400-Number(settings.FAKETEMP_OFFSET_C??5)*10);
        return 'FAKETEMP_SAVED';
      }
      const fakeOffset=/--faketemp-offset-set (\d+)$/.exec(cmd);
      if(fakeOffset) {
        writes++;await onSet?.('faketemp-offset',fakeOffset[1]);
        settings.FAKETEMP_OFFSET_C=fakeOffset[1];settings.FAKETEMP_TARGET_DECI=String(400-Number(fakeOffset[1])*10);
        return 'FAKETEMP_SAVED';
      }
      const fakeSetter=/--faketemp-value-set (\d+)$/.exec(cmd);
      if(fakeSetter) {
        writes++;await onSet?.('faketemp-value',fakeSetter[1]);
        settings.FAKETEMP_VALUE_DECI=fakeSetter[1];return 'FAKETEMP_SAVED';
      }
      const fakeStatus=['FAKETEMP_ENABLED=NO','FAKETEMP_ADAPTIVE_ENABLED=NO','FAKETEMP_OFFSET_C=5','FAKETEMP_VALUE_DECI=360','FAKETEMP_STATE=OFF','FAKETEMP_HORAE_STATE=UNKNOWN',
        ...Object.entries(settings).map(([key,value])=>key+'='+value)].join(';');
      if(cmd.endsWith('--faketemp-status'))return fakeStatus;
      const socSetter=/--soc-range-(set|delete) ([0-9,-]+)$/.exec(cmd);
      if(socSetter) {
        writes++; await onSet?.('soc-range-'+socSetter[1],socSetter[2]);
        const row=socSetter[2], key=row.split(',').slice(0,2).join(',');
        const rows=(settings.SOC_RANGES && settings.SOC_RANGES!=='NONE'?settings.SOC_RANGES.split('|'):[])
          .filter(value=>value.split(',').slice(0,2).join(',')!==key);
        if(socSetter[1]==='set') rows.push(row);
        settings.SOC_RANGES=rows.sort((a,b)=>Number(a.split(',')[0])-Number(b.split(',')[0])).join('|')||'NONE';
        return 'SOC_SAVED';
      }
      const socStatus=['SOC_ENABLED=NO','SOC_CONFIG_VALID=YES','SOC_PERCENT=50','SOC_MATCH=NONE','SOC_RANGES=NONE',
        ...Object.entries(settings).map(([key,value])=>key+'='+value)].join(';');
      if(cmd.endsWith('--soc-status')) return socStatus;
      if(/--thermal-(enable|disable)$/.test(cmd)) {
        writes++;
        settings.THERMAL_ENABLED=cmd.endsWith('--thermal-enable')?'YES':'NO';
        return 'THERMAL_ENABLED='+settings.THERMAL_ENABLED;
      }
      const thermalStatus=['THERMAL_ENABLED=NO','THERMAL_LIMIT_C=45','THERMAL_VOTE_MA=1000',
        'THERMAL_GAP_C=2','THERMAL_TEMP_DECI=340','THERMAL_STATE=OFF','THERMAL_ACTIVE=NO',
        ...Object.entries(settings).map(([key,value])=>key+'='+value)].join(';');
      if(cmd.endsWith('--thermal-status')) return thermalStatus;
      if(/--cv-(enable|disable)$/.test(cmd)) {
        writes++;await onSet?.('cv-enabled');settings.CV_ENABLED=cmd.endsWith('--cv-enable')?'YES':'NO';return 'CV_SAVED';
      }
      const cvStatus=['CV_ENABLED=YES','CV_START_SOC=90','CV_OFFSET_MV=-20','CV_BAND_MV=5','CV_RAISE_MA=50','CV_LOWER_MA=100','CV_WAIT_MS=1500','CV_FAST_GAP_MV=10','CV_ACTIVE=NO','CV_TARGET_MV=0',
        ...Object.entries(settings).map(([key,value])=>key+'='+value)].join(';');
      if(cmd.endsWith('--cv-status'))return cvStatus;
      const handoffSetter=/--handoff-(soc-set (\d+)|(bypass-)?(enable|disable))$/.exec(cmd);
      if(handoffSetter) {
        writes++;await onSet?.('handoff-'+(handoffSetter[2]?'soc':handoffSetter[3]?'bypass':'enabled'));
        if(handoffSetter[2])settings.HANDOFF_SOC=handoffSetter[2];
        else settings[handoffSetter[3]?'HANDOFF_BYPASS_ENABLED':'HANDOFF_ENABLED']=handoffSetter[4]==='enable'?'YES':'NO';
        return 'HANDOFF_SAVED';
      }
      const handoffStatus=['HANDOFF_ENABLED=NO','HANDOFF_SOC=100','HANDOFF_BYPASS_ENABLED=YES','BYPASS_STATE=OFF','HANDOFF_ACTIVE=NO','HANDOFF_REASON=NONE',
        ...Object.entries(settings).map(([key,value])=>key+'='+value)].join(';');
      if(cmd.endsWith('--handoff-status'))return handoffStatus;
      if(cmd.endsWith('--status')&&cmd.includes('charge-test.sh')) return [
        'CONTROL_STATE=STOPPED','PHASE=IDLE','REASON=WAITING_PROTOCOL',
        'MONITOR_ENABLED=YES','ACTIVE_PROTOCOL=NONE','ONLINE_PROTOCOL=NONE',
        'UFCS_ENABLED=YES','UFCS_LIMIT_MV=4560','UFCS_VOTE_MAX=9000',
        'PPS_ENABLED=YES','PPS_LIMIT_MV=4500','PPS_VOTE_MAX=5000',
        'VOTE_INITIAL=1000','INTERVAL_MS=100','RAISE_STEP=100',
        'LOWER_STEP=500','CUTOFF_GAP_MV=-50','EARLY_GAP_MV=0','EARLY_STEP_MA=0',
        thermalStatus,
        socStatus,
        pulseStatus,
        fakeStatus,
        cvStatus,
        handoffStatus,
        ...Object.entries(settings).map(([key,value])=>key+'='+value),
      ].join(';');
      if(cmd.includes('--protocol')) return 'UFCS=0;VOOC=0;PPS=0;USB_ONLINE=0;POWER=NO';
      if(cmd.includes('--battery')) return 'BATTERY_TEMP_DECI=340;BATTERY_VOLTAGE_UV=4300000;POWER=UNPLUGGED';
      if(cmd.includes('--negotiation')) return 'USB_ONLINE=0;USB_VOLTAGE_UV=UNKNOWN;VOTE_PROTOCOL=NONE';
      if(cmd.includes('--votes')) return 'VOTES_UNAVAILABLE';
      return 'NO_LOGS_YET';
    }},
  };
  doc.defaultView=window;
  if (bridge) window.ksu.exec=bridge(window.ksu.exec,window);
  const initialUrl='#legacy-diagnostics';
  const location={hash:initialUrl};
  const history={pushState(){assert.fail('不允许 pushState');},
    replaceState(){assert.fail('不允许 replaceState');}};
  runInNewContext(script,{
    window,document:doc,location,history,navigator:{},setInterval(fn,ms){timers.push({fn,ms});},setTimeout(){},clearTimeout(){},
    console, Date, Promise,
  });
  const el=id=>map.get(id);
  return {el,entries,backs,location,initialUrl,doc,timers,
    window, get writes(){return writes;},get scans(){return scans;}};
}

test('投票写入失败时显示异常，不显示控制调整已确认',async ()=>{
  const ui=openWebUi({CONTROL_STATE:'RUNNING',PHASE:'RUNNING',REASON:'VOTE_WRITE_ERROR',ACTIVE_PROTOCOL:'UFCS',TARGET_RAW:'5000'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(ui.el('stateDetail').textContent,/尚未确认调整成功/);
  assert.match(ui.el('controlLease').textContent,/尚未确认/);
  assert.match(ui.el('stateDot').className,/danger/);
  assert.equal(ui.el('controlReadiness').className,'danger-text');
});

test('系统接管设置独立开关、即时滑动、校验、保存回读与重开持久化',async()=>{
  const settings={},flush=()=>new Promise(r=>setImmediate(r)),ui=openWebUi(settings);await flush();
  assert.equal(ui.el('handoffSwitch').checked,false);assert.equal(ui.el('handoffBypassSwitch').checked,true);
  assert.equal(ui.el('handoffSocInput').value,'100');
  ui.el('tab-control').emit('click');ui.entries.find(e=>e.dataset.detail==='handoff').emit('click');await flush();
  assert.equal(ui.el('control-detail-handoff').hidden,false);assert.equal(ui.el('bottomNav').hidden,true);
  for(const raw of ['-1','101','1.5','1;echo bad']) {ui.el('handoffSocInput').value=raw;await ui.el('handoffSocInput').emit('change');}
  assert.equal(ui.writes,0);
  ui.el('handoffSocRange').value='95';ui.el('handoffSocRange').emit('input');
  assert.equal(ui.el('handoffSocInput').value,'95');assert.equal(ui.writes,0);
  await ui.el('handoffSocRange').emit('change');assert.equal(settings.HANDOFF_SOC,'95');
  ui.el('handoffSwitch').checked=true;await ui.el('handoffSwitch').emit('change');
  ui.el('handoffBypassSwitch').checked=false;await ui.el('handoffBypassSwitch').emit('change');
  const reopened=openWebUi(settings);await flush();assert.equal(reopened.el('handoffSwitch').checked,true);
  assert.equal(reopened.el('handoffSocInput').value,'95');assert.equal(reopened.el('handoffBypassSwitch').checked,false);
  for(const raw of ['0','100']){reopened.el('handoffSocInput').value=raw;await reopened.el('handoffSocInput').emit('change');assert.equal(settings.HANDOFF_SOC,raw);}
  const active=openWebUi({HANDOFF_ACTIVE:'YES',HANDOFF_REASON:'SYSTEM_SOC',PHASE:'SYSTEM',REASON:'SYSTEM_SOC'});await flush();
  assert.match(active.el('handoffStatus').textContent,/由系统/);assert.equal(active.el('phaseValue').textContent,'系统接管');
  assert.equal(active.el('stateName').textContent,'系统接管');assert.match(active.el('controlLease').textContent,/已撤销/);
  const error=openWebUi({REASON:'SYSTEM_HANDOFF_ERROR'});await flush();
  assert.match(error.el('stateDot').className,/danger/);assert.match(error.el('controlLease').textContent,/尚未确认/);
});

test('系统接管写入失败回读真实值，防并发且刷新不覆盖草稿',async()=>{
  const flush=()=>new Promise(r=>setImmediate(r));let release;
  const ui=openWebUi({},field=>field==='handoff-soc'?new Promise(r=>{release=r;}):undefined);await flush();
  ui.el('handoffSocInput').value='95';const pending=ui.el('handoffSocInput').emit('change');await flush();
  assert.equal(ui.el('handoffSwitch').disabled,true);await ui.el('handoffSwitch').emit('change');assert.equal(ui.writes,1);
  release();await pending;assert.match(ui.el('handoffSaveStatus').textContent,/已保存并回读确认/);
  ui.entries.find(e=>e.dataset.detail==='handoff').emit('click');await flush();
  ui.doc.activeElement=ui.el('handoffSocInput');ui.el('handoffSocInput').value='88';
  await ui.timers.find(t=>t.ms===1000).fn();assert.equal(ui.el('handoffSocInput').value,'88');
  const failed=openWebUi({},field=>{if(field==='handoff-soc')throw new Error('存储不可写');});await flush();
  failed.el('handoffSocInput').value='95';await failed.el('handoffSocInput').emit('change');
  assert.match(failed.el('handoffSaveStatus').textContent,/失败.*存储不可写/);assert.equal(failed.el('handoffSocInput').value,'100');
  const bad=openWebUi({},undefined,cmd=>cmd.endsWith('--handoff-status')?'HANDOFF_ENABLED=YES':undefined);await flush();
  bad.entries.find(e=>e.dataset.detail==='handoff').emit('click');await flush();
  assert.equal(bad.el('handoffSwitch').disabled,true);assert.match(bad.el('handoffStatus').textContent,/读取失败/);
});

test('控制页完整读取当前默认预设，不自行发送恢复操作',async()=>{
  const defaults=JSON.parse(readFileSync(new URL('./fixtures/control-defaults.json',import.meta.url),'utf8'));
  const ui=openWebUi({...defaults});await new Promise(r=>setImmediate(r));
  for(const [id,key] of [
    ['limitInputUFCS','UFCS_LIMIT_MV'],['voteMaxInputUFCS','UFCS_VOTE_MAX'],
    ['limitInputPPS','PPS_LIMIT_MV'],['voteMaxInputPPS','PPS_VOTE_MAX'],
    ['advInitialInput','VOTE_INITIAL'],['advIntervalInput','INTERVAL_MS'],
    ['advRaiseInput','RAISE_STEP'],['advLowerInput','LOWER_STEP'],['advGapInput','CUTOFF_GAP_MV'],
    ['advEarlyGapInput','EARLY_GAP_MV'],['advEarlyStepInput','EARLY_STEP_MA'],
    ['cvStartInput','CV_START_SOC'],['cvOffsetInput','CV_OFFSET_MV'],['cvBandInput','CV_BAND_MV'],
    ['cvRaiseInput','CV_RAISE_MA'],['cvLowerInput','CV_LOWER_MA'],['cvWaitInput','CV_WAIT_MS'],
    ['cvFastGapInput','CV_FAST_GAP_MV'],['thermalLimitInput','THERMAL_LIMIT_C'],
    ['thermalVoteInput','THERMAL_VOTE_MA'],['thermalGapInput','THERMAL_GAP_C'],
    ['pulseChargeInput','PULSE_CHARGE_S'],['pulsePauseInput','PULSE_PAUSE_MS'],['handoffSocInput','HANDOFF_SOC'],
  ]) assert.equal(ui.el(id).value,defaults[key],id);
  for(const [id,key] of [['thermalSwitch','THERMAL_ENABLED'],['fakeSwitch','FAKETEMP_ENABLED'],
    ['cvSwitch','CV_ENABLED'],['pulseSwitch','PULSE_ENABLED'],['socSwitch','SOC_ENABLED'],
    ['handoffSwitch','HANDOFF_ENABLED'],['handoffBypassSwitch','HANDOFF_BYPASS_ENABLED']]) {
    assert.equal(ui.el(id).checked,defaults[key]==='YES',id);
  }
  assert.equal(ui.writes,0);
});

test('恒压设置默认值、七项滑动输入、开关、重开持久化与一键恢复默认',async()=>{
  const settings={},flush=()=>new Promise(r=>setImmediate(r)),ui=openWebUi(settings);await flush();
  assert.equal(ui.el('cvSwitch').checked,true);
  for(const [name,value] of [['Start','90'],['Offset','-20'],['Band','5'],['Raise','50'],['Lower','100'],['Wait','1500'],['FastGap','10']])assert.equal(ui.el('cv'+name+'Input').value,value);
  ui.el('tab-control').emit('click');ui.entries.find(e=>e.dataset.detail==='cv').emit('click');await flush();
  assert.equal(ui.el('control-detail-cv').hidden,false);assert.equal(ui.el('bottomNav').hidden,true);
  for(const [name,value] of [['Start','101'],['Offset','-51'],['Offset','1'],['Band','0'],['Raise','501'],['Lower','1001'],['Wait','199'],['FastGap','-1'],['FastGap','51']]) {
    ui.el('cv'+name+'Input').value=value;await ui.el('cv'+name+'Input').emit('change');
  }
  assert.equal(ui.writes,0);
  for(const [name,value] of [['Start','0'],['Offset','-35'],['Band','10'],['Raise','80'],['Lower','30'],['Wait','500'],['FastGap','25']]) {
    ui.el('cv'+name+'Range').value=value;ui.el('cv'+name+'Range').emit('input');
    assert.equal(ui.el('cv'+name+'Input').value,value);await ui.el('cv'+name+'Range').emit('change');
    assert.match(ui.el('cvSaveStatus').textContent,/已保存并回读确认/);
  }
  ui.el('cvSwitch').checked=false;await ui.el('cvSwitch').emit('change');
  const reopened=openWebUi(settings);await flush();assert.equal(reopened.el('cvSwitch').checked,false);
  for(const [name,value] of [['Start','0'],['Offset','-35'],['Band','10'],['Raise','80'],['Lower','30'],['Wait','500'],['FastGap','25']])assert.equal(reopened.el('cv'+name+'Input').value,value);
  for(const raw of ['-50','0']) {
    reopened.el('cvOffsetInput').value=raw;reopened.el('cvOffsetInput').emit('input');
    assert.equal(reopened.el('cvOffsetRange').value,raw);await reopened.el('cvOffsetInput').emit('change');
    assert.equal(settings.CV_OFFSET_MV,raw);
  }
  for(const raw of ['0','50']) {
    reopened.el('cvFastGapInput').value=raw;reopened.el('cvFastGapInput').emit('input');
    assert.equal(reopened.el('cvFastGapRange').value,raw);await reopened.el('cvFastGapInput').emit('change');
    assert.equal(settings.CV_FAST_GAP_MV,raw);
  }
  await reopened.el('cvReset').emit('click');assert.equal(reopened.el('cvSwitch').checked,true);
  for(const [name,value] of [['Start','80'],['Offset','-5'],['Band','5'],['Raise','50'],['Lower','100'],['Wait','1500'],['FastGap','15']])assert.equal(reopened.el('cv'+name+'Input').value,value);
  assert.match(reopened.el('cvSaveStatus').textContent,/已恢复默认并回读确认/);
});

test('恒压设置禁止并发写入、失败回读真实值，定时刷新不覆盖输入草稿',async()=>{
  const settings={},flush=()=>new Promise(r=>setImmediate(r));let release;
  const ui=openWebUi(settings,field=>field==='cv-wait'?new Promise(r=>{release=r;}):undefined);await flush();
  ui.el('cvWaitInput').value='500';const pending=ui.el('cvWaitInput').emit('change');await flush();
  assert.equal(ui.el('cvSwitch').disabled,true);assert.equal(ui.el('cvReset').disabled,true);
  ui.el('cvBandInput').value='8';await ui.el('cvBandInput').emit('change');assert.equal(ui.writes,1);
  release();await pending;assert.equal(ui.el('cvWaitInput').value,'500');
  ui.el('tab-control').emit('click');ui.entries.find(e=>e.dataset.detail==='cv').emit('click');await flush();
  ui.doc.activeElement=ui.el('cvBandInput');ui.el('cvBandInput').value='12';
  await ui.timers.find(t=>t.ms===1000).fn();assert.equal(ui.el('cvBandInput').value,'12');
  const failed=openWebUi({},field=>{if(field==='cv-start')throw new Error('存储不可写');});await flush();
  failed.el('cvStartInput').value='75';await failed.el('cvStartInput').emit('change');
  assert.match(failed.el('cvSaveStatus').textContent,/失败.*存储不可写/);assert.equal(failed.el('cvStartInput').value,'90');
  const bad=openWebUi({},undefined,cmd=>cmd.endsWith('--cv-status')?'CV_ENABLED=YES;CV_START_SOC=101':undefined);await flush();
  bad.entries.find(e=>e.dataset.detail==='cv').emit('click');await flush();
  assert.equal(bad.el('cvStartInput').disabled,true);assert.match(bad.el('cvStatus').textContent,/读取失败/);
  const partial=openWebUi({CV_ENABLED:'NO',CV_START_SOC:'75',CV_BAND_MV:'10',CV_LOWER_MA:'30',CV_WAIT_MS:'500'},field=>{
    if(field==='cv-lower')throw new Error('写入失败');
  });await flush();await partial.el('cvReset').emit('click');
  assert.match(partial.el('cvSaveStatus').textContent,/恢复默认未完成/);
  assert.equal(partial.el('cvStartInput').value,'80');assert.equal(partial.el('cvLowerInput').value,'30');
  assert.equal(partial.el('cvWaitInput').value,'500');assert.equal(partial.el('cvSwitch').checked,false);
});

test('快速降流压差保存失败回读旧值，非法回读禁止继续编辑',async()=>{
  const ui=openWebUi({CV_FAST_GAP_MV:'20'},field=>{if(field==='cv-fast-gap')throw new Error('存储不可写');});
  await new Promise(r=>setImmediate(r));ui.el('cvFastGapInput').value='50';await ui.el('cvFastGapInput').emit('change');
  assert.equal(ui.el('cvFastGapInput').value,'20');assert.match(ui.el('cvSaveStatus').textContent,/失败.*存储不可写/);
  const bad=openWebUi({CV_FAST_GAP_MV:'51'});await new Promise(r=>setImmediate(r));
  assert.equal(bad.el('cvFastGapInput').disabled,true);assert.match(bad.el('cvStatus').textContent,/响应无效|读取失败/);
});

test('间断充电默认值、时间边界、滑动输入、开关、多区间添加删除与重开持久化',async ()=>{
  const settings={};const ui=openWebUi(settings);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.el('pulseSwitch').checked,false);
  assert.equal(ui.el('pulseChargeInput').value,'5');assert.equal(ui.el('pulsePauseInput').value,'1000');
  for(const [id,value] of [['pulseCharge','0'],['pulseCharge','1201'],['pulsePause','-1'],['pulsePause','60001']]) {
    ui.el(id+'Input').value=value;await ui.el(id+'Input').emit('change');
  }
  assert.equal(ui.writes,0);
  for(const [id,value] of [['pulseCharge','1200'],['pulsePause','0']]) {
    ui.el(id+'Range').value=value;ui.el(id+'Range').emit('input');assert.equal(ui.el(id+'Input').value,value);
    await ui.el(id+'Range').emit('change');assert.match(ui.el('pulseSaveStatus').textContent,/已保存并回读确认/);
  }
  ui.el('pulsePauseInput').value='60000';await ui.el('pulsePauseInput').emit('change');
  ui.el('pulseSwitch').checked=true;await ui.el('pulseSwitch').emit('change');
  for(const [start,end] of [['0','40'],['60','80']]) {
    ui.el('pulseAdd').emit('click');assert.equal(ui.el('pulseRangeDialog').open,true);
    ui.el('pulseStart').value=start;ui.el('pulseEnd').value=end;await ui.el('pulseRangeForm').emit('submit');
    assert.equal(ui.el('pulseRangeDialog').open,false);
  }
  assert.equal(settings.PULSE_RANGES,'0,40:60,80');
  ui.el('pulseAdd').emit('click');ui.el('pulseStart').value='40';ui.el('pulseEnd').value='60';
  const writes=ui.writes;await ui.el('pulseRangeForm').emit('submit');
  assert.equal(ui.writes,writes);assert.match(ui.el('pulseRangeError').textContent,/重叠/);
  ui.el('pulseRangeCancel').emit('click');assert.equal(ui.el('pulseRangeDialog').open,false);
  const reopened=openWebUi(settings);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reopened.el('pulseSwitch').checked,true);assert.equal(reopened.el('pulseChargeInput').value,'1200');
  assert.equal(reopened.el('pulsePauseInput').value,'60000');assert.equal(reopened.el('pulseRanges').children.length,2);
  await reopened.el('pulseRanges').children[1].children[1].emit('click');
  assert.equal(settings.PULSE_RANGES,'0,40');
});

test('充电记录实时跟随、拖动保留时间点、历史选择与缓存、返回实时及离页停止刷新',async()=>{
  const active='1792340000-12345678-100000',old='1792330000-12345678-100000';
  const rows=['1792340000,0,20,350,4500000,-2000000','1792340002,2000,21,360,4510000,-3000000'];
  let reads=0, lists=0;
  const backend=cmd=>{
    if(!cmd.includes('charging-history.sh'))return;
    if(cmd.includes('--list')) {
      lists++;
      return 'HISTORY_RUNNING=YES;HISTORY_ACTIVE='+active+';HISTORY_ERROR=NONE;HISTORY_MORE=NO;HISTORY_SESSIONS='+
        active+',1792340000,1792340002,2000,20,21,'+rows.length+',ACTIVE:'+old+',1792330000,1792330010,10000,10,11,1,UNPLUGGED';
    }
    reads++;
    const key=cmd.split(' ').at(-1),data=key===active?rows:['1792330000,0,10,320,4000000,-1000000'];
    return 'HISTORY_ID='+key+';HISTORY_TOTAL='+data.length+';HISTORY_DATA_B64='+Buffer.from(data.join('\n')+'\n').toString('base64');
  };
  const flush=()=>new Promise(r=>setImmediate(r));
  const ui=openWebUi({},undefined,backend);await flush();
  ui.el('tab-history').emit('click');await flush();
  assert.equal(ui.el('page-history').hidden,false);
  assert.equal(ui.el('historyRecords').hidden,true);
  ui.el('historyRecordsToggle').emit('click');
  assert.equal(ui.el('historyRecords').hidden,false);
  assert.equal(ui.el('historyRecordsToggle')['aria-expanded'],'true');
  ui.el('historyRecordsToggle').emit('click');
  assert.equal(ui.el('historyRecords').hidden,true);
  assert.equal(ui.el('historyValue-soc').textContent,'21%');assert.equal(ui.el('historyChartValue-power').textContent,'13.53 W');
  assert.equal(ui.el('historyCanvas').width,720);assert.equal(ui.el('historyTable').children.length,2);
  assert.equal((html.match(/<canvas\b/g)||[]).length,1,'五项曲线只使用一张画布');
  const canvas=ui.el('historyCanvas');assert.equal(canvas.height,600);
  const beforeAxes=reads;
  for(const [key,unit] of [['power','W'],['soc','%'],['temp','°C'],['voltage','V'],['vote','mA']]) {
    const start=canvas.context.calls.length;ui.el('historyAxis-'+key).emit('click');
    assert.equal(ui.el('historyAxis-'+key)['aria-pressed'],'true');
    const labels=canvas.context.calls.slice(start).filter(call=>call.name==='fillText').map(call=>String(call.args[0]));
    assert.ok(labels.some(text=>text.endsWith(unit)),key+' 轴使用自身单位');
    assert.ok(labels.includes('5m'),'短记录全程视图至少显示 5 分钟');
    assert.match(ui.el('historyAxisLabel').textContent,new RegExp(unit));
  }
  assert.equal(reads,beforeAxes,'切换纵轴不请求后台');
  assert.equal(ui.el('historySocArc')['stroke-dasharray'],'21 100');
  assert.equal(ui.el('historyChargeState').textContent,'正在记录');
  assert.equal(ui.el('historyDuration').textContent,'0:00:02');
  assert.equal(ui.el('historySocGain').textContent,'+1%');
  assert.equal(ui.doc.body.dataset.page,'history');
  assert.equal(ui.el('historyState').hidden,true);
  ui.el('historyCanvas').emit('pointerdown',{clientX:66,pointerId:1});assert.equal(ui.el('historyValue-soc').textContent,'20%');
  assert.equal(ui.el('historyChartValue-power').textContent,'9.00 W');
  assert.equal(ui.el('historyChartValue-temp').textContent,'35.0 °C');
  rows.push('1792340004,4000,22,370,4520000,-4000000');
  await new Promise(resolve=>setTimeout(resolve,210));
  await ui.timers.find(t=>t.ms===200).fn();assert.equal(ui.el('historyValue-soc').textContent,'20%','刷新不抢走拖动位置');
  ui.el('historyLive').emit('click');await flush();assert.equal(ui.el('historyValue-soc').textContent,'22%');
  ui.el('historySession').value=old;ui.el('historySession').emit('change');await flush();
  assert.equal(ui.el('historyValue-soc').textContent,'10%');assert.equal(ui.el('historyChartValue-power').textContent,'4.00 W');
  const cachedReads=reads;await ui.timers.find(t=>t.ms===200).fn();assert.equal(reads,cachedReads,'不反复读取已结束记录');
  ui.el('historyLive').emit('click');await flush();assert.equal(ui.el('historyValue-soc').textContent,'22%');
  ui.doc.hidden=true;const count=lists;await ui.timers.find(t=>t.ms===200).fn();assert.equal(lists,count);
  ui.doc.hidden=false;ui.el('historyBack').emit('click');await ui.timers.find(t=>t.ms===200).fn();assert.equal(lists,count);
  assert.equal(ui.doc.body.dataset.page,'overview');assert.equal(ui.el('page-history').hidden,true);
});

test('统计页无记录时显示空值，后台停止、存储失败与损坏摘要保持可见提示',async()=>{
  let running='NO',error='NONE',skipped=0;
  const ui=openWebUi({},undefined,cmd=>{
    if(cmd.includes('charging-history.sh'))return 'HISTORY_RUNNING='+running+';HISTORY_ACTIVE=NONE;HISTORY_ERROR='+error+';HISTORY_MORE=NO;HISTORY_SKIPPED='+skipped+';HISTORY_SESSIONS=NONE';
  });
  const flush=()=>new Promise(r=>setImmediate(r));await flush();ui.el('tab-history').emit('click');await flush();
  for(const key of ['soc','temp','voltage','power','vote']) {
    assert.equal(ui.el(key==='soc'?'historyValue-soc':'historyChartValue-'+key).textContent,'—');assert.equal(ui.el('historyMax-'+key).textContent,'—');
  }
  assert.equal(ui.el('historySocArc')['stroke-dasharray'],'0 100');
  assert.equal(ui.el('historyDuration').textContent,'—');assert.equal(ui.el('historySocGain').textContent,'—');
  assert.equal(ui.el('historyState').hidden,false);assert.match(ui.el('historyState').textContent,/未运行/);
  running='YES';error='STORAGE_ERROR';await ui.el('historyRefresh').emit('click');
  assert.equal(ui.el('historyState').hidden,false);assert.match(ui.el('historyState').textContent,/写入失败/);
  error='NONE';skipped=1;await ui.el('historyRefresh').emit('click');
  assert.equal(ui.el('historyState').hidden,false);assert.match(ui.el('historyState').textContent,/1 条记录摘要异常/);
  assert.equal(ui.el('historyError').textContent,'');
  assert.equal(ui.writes,0);
});

test('统计默认显示最近一次，开始充电自动切到当前，结束后保留本次，手动选择历史不被抢走',async()=>{
  const recent='1792340000-12345678-100000',old='1792330000-12345678-100000',current='1792350000-12345678-100000';
  let charging=false,hasCurrent=false,running='YES';const reads=[];
  const backend=cmd=>{
    if(!cmd.includes('charging-history.sh'))return;
    if(cmd.includes('--list')) {
      const rows=[...(hasCurrent?[current+',1792350000,1792350010,10000,70,71,2,'+(charging?'ACTIVE':'UNPLUGGED')]:[]),
        recent+',1792340000,1792340010,10000,50,60,2,UNPLUGGED',old+',1792330000,1792330010,10000,10,11,2,UNPLUGGED'];
      return 'HISTORY_RUNNING='+running+';HISTORY_ACTIVE='+(charging?current:'NONE')+';HISTORY_ERROR=NONE;HISTORY_MORE=NO;HISTORY_SESSIONS='+rows.join(':');
    }
    const id=/--read ([^ ]+)/.exec(cmd)[1];reads.push(id);
    const [epoch,soc]=id===current?[1792350000,70]:id===recent?[1792340000,50]:[1792330000,10];
    const data=epoch+',0,'+soc+',350,4500000,-2000000\n'+(epoch+10)+',10000,'+(soc+1)+',360,4510000,-3000000\n';
    return 'HISTORY_ID='+id+';HISTORY_TOTAL=2;HISTORY_DATA_B64='+Buffer.from(data).toString('base64');
  };
  const flush=()=>new Promise(r=>setImmediate(r)),ui=openWebUi({},undefined,backend);await flush();ui.el('tab-history').emit('click');await flush();
  assert.equal(ui.el('historySession').value,recent);assert.equal(ui.el('historyValue-soc').textContent,'51%');
  assert.equal(ui.el('historyChargeState').textContent,'充电已结束');assert.equal(ui.el('historyLive').textContent,'最近一次');
  assert.equal(ui.el('historyLive')['aria-pressed'],'true');
  const cached=reads.length;await ui.el('historyRefresh').emit('click');assert.equal(reads.length,cached,'完成记录沿用缓存');
  running='NO';await ui.el('historyRefresh').emit('click');
  assert.equal(ui.el('historySession').value,recent);assert.equal(ui.el('historyValue-soc').textContent,'51%','记录器停止仍能查看最近一次');
  running='YES';charging=hasCurrent=true;await ui.el('historyRefresh').emit('click');
  assert.equal(ui.el('historySession').value,current);assert.equal(ui.el('historyValue-soc').textContent,'71%');
  assert.equal(ui.el('historyChargeState').textContent,'正在记录');assert.equal(ui.el('historyLive').textContent,'实时');
  ui.el('historySession').value=old;ui.el('historySession').emit('change');await flush();await ui.el('historyRefresh').emit('click');
  assert.equal(ui.el('historySession').value,old);assert.equal(ui.el('historyValue-soc').textContent,'11%');
  assert.equal(ui.el('historyLive')['aria-pressed'],'false');
  ui.el('historyLive').emit('click');await flush();assert.equal(ui.el('historySession').value,current);
  ui.el('historyRangeStart').value='500';ui.el('historyRangeStart').emit('input');await ui.el('historyRangeStart').emit('change');await flush();
  charging=false;await ui.el('historyRefresh').emit('click');
  assert.equal(ui.el('historySession').value,current);assert.equal(ui.el('historyChargeState').textContent,'充电已结束');
  assert.equal(ui.el('historyRangeStart').value,'500','同一次充电结束后保留所选缩放范围');
  assert.equal(ui.el('historyLive').textContent,'最近一次');assert.equal(ui.el('historyError').textContent,'');
  const reopened=openWebUi({},undefined,backend);await flush();reopened.el('tab-history').emit('click');await flush();
  assert.equal(reopened.el('historySession').value,current);assert.equal(reopened.el('historyValue-soc').textContent,'71%');
  assert.equal(reopened.writes,0);
});

test('投票图表同步点选，全程峰值不随缩放改变，切换旧记录清空投票，双芯仅翻倍最高功率',async()=>{
  const active='1792340000-12345678-100000',old='1792330000-12345678-100000';
  const rows=['1792340000,0,20,450,4600000,-5000000,10000','1792340010,10000,21,350,4500000,-2000000,5000'];
  const ui=openWebUi({},undefined,cmd=>{
    if(!cmd.includes('charging-history.sh'))return;
    if(cmd.includes('--list'))return 'HISTORY_RUNNING=YES;HISTORY_ACTIVE='+active+';HISTORY_ERROR=NONE;HISTORY_MORE=NO;HISTORY_SESSIONS='+
      active+',1792340000,1792340010,10000,20,21,2,ACTIVE:'+old+',1792330000,1792330010,10000,10,11,1,UNPLUGGED';
    const match=/--read ([^ ]+)(?: (\d+) (\d+))?$/.exec(cmd),key=match[1];
    const data=key===old?['1792330000,0,10,320,4000000,-1000000']:rows.filter(line=>!match[2] || Number(line.split(',')[1])>=Number(match[2]));
    const maxima=key===old?'MAX,10,320,4000000,4000000000000,':'MAX,21,450,4600000,23000000000000,10000';
    return 'HISTORY_ID='+key+';HISTORY_TOTAL=2;HISTORY_DATA_B64='+Buffer.from(maxima+'\n'+data.join('\n')+'\n').toString('base64');
  });
  const flush=()=>new Promise(r=>setImmediate(r));await flush();ui.el('tab-history').emit('click');await flush();
  assert.equal(ui.el('historyChartValue-vote').textContent,'5000 mA');
  for(const [key,text] of [['soc','21 %'],['temp','45.0 °C'],['voltage','4.600 V'],['power','23.00 W'],['vote','10000 mA']])assert.equal(ui.el('historyMax-'+key).textContent,text);
  const canvas=ui.el('historyCanvas');assert.equal(canvas.width,720);
  ui.el('historyAxis-vote').emit('click');
  assert.ok(canvas.context.calls.some(call=>call.name==='fillText' && String(call.args[0]).endsWith('mA')));
  canvas.emit('pointerdown',{clientX:66,pointerId:1});assert.equal(ui.el('historyChartValue-vote').textContent,'10000 mA');
  ui.el('historyRangeStart').value='500';ui.el('historyRangeStart').emit('input');await ui.el('historyRangeStart').emit('change');await flush();
  assert.equal(ui.el('historyChartValue-vote').textContent,'5000 mA');assert.equal(ui.el('historyTable').children.length,1);
  assert.equal(ui.el('historyMax-temp').textContent,'45.0 °C');assert.equal(ui.el('historyMax-vote').textContent,'10000 mA');
  ui.el('historyDualCell').checked=true;ui.el('historyDualCell').emit('change');
  assert.equal(ui.el('historyMax-power').textContent,'46.00 W');assert.equal(ui.el('historyMax-vote').textContent,'10000 mA');
  ui.el('historySession').value=old;ui.el('historySession').emit('change');await flush();
  assert.equal(ui.el('historyChartValue-vote').textContent,'—');assert.equal(ui.el('historyMax-vote').textContent,'—');
  assert.equal(ui.el('historyMax-temp').textContent,'32.0 °C');assert.equal(ui.el('historyError').textContent,'');assert.equal(ui.writes,0);
});

test('合并图五条曲线各自缩放并共享时间位置，投票缺失处断线，切换纵轴保持全部曲线和选点',async()=>{
  const active='1792340000-12345678-100000';let reads=0;
  const raw=['1792340000,0,20,350,4500000,-2000000,1000','1792340001,1000,21,360,4510000,-3000000,',
    '1792340002,2000,22,370,4520000,-4000000,3000','1792340003,3000,23,380,4530000,-5000000,4000'];
  const ui=openWebUi({},undefined,cmd=>{
    if(!cmd.includes('charging-history.sh'))return;
    if(cmd.includes('--list'))return 'HISTORY_RUNNING=YES;HISTORY_ACTIVE='+active+';HISTORY_ERROR=NONE;HISTORY_MORE=NO;HISTORY_SESSIONS='+active+',1792340000,1792340003,3000,20,23,4,ACTIVE';
    reads++;return 'HISTORY_ID='+active+';HISTORY_TOTAL=4;HISTORY_DATA_B64='+Buffer.from(raw.join('\n')+'\n').toString('base64');
  });
  const flush=()=>new Promise(r=>setImmediate(r));await flush();ui.el('tab-history').emit('click');await flush();
  const canvas=ui.el('historyCanvas'), colors=['#1677e8','#16803c','#d32f2f','#d4aa00','#161616'];
  canvas.context.calls.length=0;ui.el('historyAxis-voltage').emit('click');
  const calls=canvas.context.calls;
  for(const color of colors) {
    const moves=calls.filter(c=>c.name==='moveTo' && c.stroke===color);
    assert.equal(moves[0].args[0],66,'每项第一个点都从同一时间位置开始');
    assert.ok(calls.some(c=>c.name==='stroke' && c.stroke===color),'切换后仍绘制全部曲线');
  }
  assert.ok(calls.filter(c=>c.name==='setLineDash').every(c=>c.args[0].length===0),'全部曲线和选点辅助线均为实线');
  const voteMoves=calls.filter(c=>c.name==='moveTo' && c.stroke==='#161616');
  assert.equal(voteMoves.length,2,'缺失的投票值使曲线断开');
  assert.ok(Math.abs(voteMoves[1].args[0]-(66+284*2000/300000))<1e-8);
  const voltageStart=calls.find(c=>c.name==='moveTo' && c.stroke==='#d4aa00');
  assert.equal(voltageStart.args[1],12+(1-(4.5-3)/2)*260,'电压使用 3–5V 独立刻度');
  canvas.emit('keydown',{key:'Home'});assert.equal(ui.el('historyChartValue-vote').textContent,'1000 mA');
  canvas.emit('keydown',{key:'ArrowRight'});assert.equal(ui.el('historyChartValue-vote').textContent,'—');
  const point=ui.el('historyPoint').textContent;
  const before=reads;ui.el('historyAxis-vote').emit('click');
  assert.equal(reads,before);assert.equal(ui.el('historyPoint').textContent,point);
  assert.equal(ui.el('historyAxis-voltage')['aria-pressed'],'false');
  assert.equal(ui.el('historyAxis-vote')['aria-pressed'],'true');
  assert.match(canvas['aria-label'],/纵轴为模块投票值（mA）/);
});

test('图表按真实时间选择、范围滑动立即响应与细节回读，双电芯显示持久化且不改原始记录',async()=>{
  const active='1792340000-12345678-100000',storage=new Map();
  const raw=['1792340000,0,20,350,4500000,-2000000','1792340000,200,21,360,4510000,-3000000',
    '1792340005,5000,22,370,4520000,-4000000','1792340010,10000,23,380,4530000,-5000000'];
  const calls=[],list='HISTORY_RUNNING=YES;HISTORY_ACTIVE='+active+';HISTORY_ERROR=NONE;HISTORY_MORE=NO;HISTORY_SESSIONS='+active+',1792340000,1792340010,10000,20,23,4,ACTIVE';
  const backend=cmd=>{
    if(!cmd.includes('charging-history.sh'))return;
    calls.push(cmd);if(cmd.includes('--list'))return list;
    const match=/--read ([^ ]+)(?: (\d+) (\d+))?$/.exec(cmd);
    const data=match[2]===undefined ? raw : raw.filter(line=>{const ms=Number(line.split(',')[1]);return ms>=Number(match[2]) && ms<=Number(match[3]);});
    return 'HISTORY_ID='+active+';HISTORY_TOTAL=4;HISTORY_DATA_B64='+Buffer.from(data.join('\n')+'\n').toString('base64');
  };
  const flush=()=>new Promise(r=>setImmediate(r)),ui=openWebUi({},undefined,backend,undefined,storage);await flush();
  ui.el('tab-history').emit('click');await flush();
  ui.el('historyCanvas').emit('pointerdown',{clientX:66+284*(2500/300000),pointerId:1});
  assert.equal(ui.el('historyValue-soc').textContent,'21%','2500ms 按真实距离选 200ms，而非按数组中点');
  assert.match(ui.el('historyPoint').textContent,/0:00:00\.200/);
  assert.equal(ui.el('historyChartValue-power').textContent,'13.53 W');
  ui.el('historyDualCell').checked=true;ui.el('historyDualCell').emit('change');
  assert.equal(ui.el('historyChartValue-power').textContent,'27.06 W');assert.equal(ui.el('historyChartValue-voltage').textContent,'4.510 V');
  assert.equal(ui.el('historyTable').children[3].children[4].textContent,'18.00 W');assert.equal(ui.writes,0);
  const before=calls.length;ui.el('historyRangeStart').value='500';ui.el('historyRangeStart').emit('input');
  assert.equal(calls.length,before,'滑动阶段只绘图，不等待后台读取');assert.equal(ui.el('historyTable').children.length,2);
  assert.equal(ui.el('historyValue-soc').textContent,'22%');assert.equal(ui.el('historyRangeStartTime').textContent,'0:00:05');
  await ui.timers.find(t=>t.ms===200).fn();assert.equal(calls.length,before,'拖动期间不排队刷新');
  await ui.el('historyRangeStart').emit('change');await flush();assert.ok(calls.some(cmd=>cmd.endsWith('--read '+active+' 5000 10000')));
  ui.el('historyCanvas').emit('keydown',{key:'End'});assert.equal(ui.el('historyChartValue-power').textContent,'45.30 W');
  const reopened=openWebUi({},undefined,backend,undefined,storage);await flush();reopened.el('tab-history').emit('click');await flush();
  assert.equal(reopened.el('historyDualCell').checked,true);assert.equal(reopened.el('historyChartValue-power').textContent,'45.30 W');
  assert.equal(raw[0],'1792340000,0,20,350,4500000,-2000000');
  reopened.el('historyDualCell').checked=false;reopened.el('historyDualCell').emit('change');assert.equal(reopened.el('historyChartValue-power').textContent,'22.65 W');
});

test('双指围绕中心缩放时间，手势中不读取，结束后读细节，缩放不改变整次最高值',async()=>{
  assert.match(html,/\.history-canvas \{[^}]*touch-action:none/,'图表手势交给应用处理，避免浏览器抢走双指操作');
  const active='1792340000-12345678-100000',calls=[];
  const raw=[0,75000,150000,225000,300000].map((ms,i)=>(1792340000+ms/1000)+','+ms+','+(20+i)+',350,4500000,-2000000,5000');
  const ui=openWebUi({},undefined,cmd=>{
    if(!cmd.includes('charging-history.sh'))return;
    calls.push(cmd);
    if(cmd.includes('--list'))return 'HISTORY_RUNNING=YES;HISTORY_ACTIVE='+active+';HISTORY_ERROR=NONE;HISTORY_MORE=NO;HISTORY_SESSIONS='+active+',1792340000,1792340300,300000,20,24,5,ACTIVE';
    const match=/--read [^ ]+(?: (\d+) (\d+))?$/.exec(cmd);
    const data=raw.filter(row=>!match[1] || Number(row.split(',')[1])>=Number(match[1]) && Number(row.split(',')[1])<=Number(match[2]));
    return 'HISTORY_ID='+active+';HISTORY_TOTAL=5;HISTORY_DATA_B64='+Buffer.from('MAX,90,500,4650000,100000000000000,12000\n'+data.join('\n')+'\n').toString('base64');
  });
  const flush=()=>new Promise(r=>setImmediate(r));await flush();ui.el('tab-history').emit('click');await flush();
  const canvas=ui.el('historyCanvas'),touch=(type,id,x)=>canvas.emit(type,{pointerType:'touch',pointerId:id,clientX:x,clientY:100,buttons:1});
  const before=calls.length;
  touch('pointerdown',1,137);touch('pointerdown',2,279);
  touch('pointermove',1,66);touch('pointermove',2,350);
  assert.equal(ui.el('historyRangeStart').value,'250');assert.equal(ui.el('historyRangeEnd').value,'750');
  assert.equal(ui.el('historyRangeStartTime').textContent,'0:01:15');assert.equal(ui.el('historyRangeEndTime').textContent,'0:03:45');
  assert.equal(ui.el('historyMax-temp').textContent,'50.0 °C');assert.equal(ui.el('historyMax-power').textContent,'100.00 W');
  await ui.timers.find(t=>t.ms===200).fn();assert.equal(calls.length,before,'双指移动不请求后台');
  touch('pointerup',1,66);touch('lostpointercapture',1,66);touch('pointerup',2,350);await flush();
  assert.ok(calls.some(cmd=>cmd.endsWith('--read '+active+' 75000 225000')));
  assert.equal(calls.length,before+2,'抬起与丢失捕获仅触发一次刷新');
  assert.equal(ui.el('historyMax-temp').textContent,'50.0 °C');assert.equal(ui.el('historyMax-vote').textContent,'12000 mA');
  touch('pointerdown',3,66);touch('pointerdown',4,350);touch('pointermove',3,137);touch('pointermove',4,279);
  assert.equal(ui.el('historyRangeStart').value,'0');assert.equal(ui.el('historyRangeEnd').value,'1000');
  touch('pointercancel',3,137);touch('pointerup',4,279);await flush();
  assert.equal(calls.at(-1),'sh /data/adb/modules/oplus-votable/charging-history.sh --read '+active);
});

test('双指缩放限制时间边界和最小范围，多指切换不跳变，结束后的单指仍能选点',async()=>{
  const active='1792340000-12345678-100000';
  const ui=openWebUi({},undefined,cmd=>{
    if(!cmd.includes('charging-history.sh'))return;
    if(cmd.includes('--list'))return 'HISTORY_RUNNING=YES;HISTORY_ACTIVE='+active+';HISTORY_ERROR=NONE;HISTORY_MORE=NO;HISTORY_SESSIONS='+active+',1792340000,1792340010,10000,20,21,2,ACTIVE';
    return 'HISTORY_ID='+active+';HISTORY_TOTAL=2;HISTORY_DATA_B64='+Buffer.from('1792340000,0,20,350,4500000,-2000000\n1792340010,10000,21,360,4510000,-3000000\n').toString('base64');
  });
  const flush=()=>new Promise(r=>setImmediate(r));await flush();ui.el('tab-history').emit('click');await flush();
  const canvas=ui.el('historyCanvas'),touch=(type,id,x)=>canvas.emit(type,{pointerType:'touch',pointerId:id,clientX:x,clientY:100,buttons:1});
  touch('pointerdown',1,207);touch('pointerdown',2,208);touch('pointermove',1,66);touch('pointermove',2,350);
  assert.equal(Number(ui.el('historyRangeEnd').value)-Number(ui.el('historyRangeStart').value),20);
  assert.ok(Number(ui.el('historyRangeStart').value)>=0);assert.ok(Number(ui.el('historyRangeEnd').value)<=1000);
  touch('pointerdown',3,200);const range=ui.el('historyRangeStart').value;
  touch('pointerup',1,66);assert.equal(ui.el('historyRangeStart').value,range,'换用剩余两指不会重置范围');
  touch('pointercancel',2,350);touch('pointerup',3,200);await flush();
  ui.el('historyRangeStart').value='0';ui.el('historyRangeStart').emit('input');
  ui.el('historyRangeEnd').value='1000';ui.el('historyRangeEnd').emit('input');await ui.el('historyRangeEnd').emit('change');await flush();
  touch('pointerdown',4,66);touch('pointerup',4,66);assert.equal(ui.el('historyValue-soc').textContent,'20%');
  assert.equal(ui.el('historyError').textContent,'');
});

test('双指缩放取消旧读取，慢响应不能覆盖新范围；空记录手势不阻断刷新',async()=>{
  const active='1792340000-12345678-100000';let release,reads=0;
  const payload='HISTORY_ID='+active+';HISTORY_TOTAL=2;HISTORY_DATA_B64='+Buffer.from('1792340000,0,20,350,4500000,-2000000\n1792340150,150000,21,360,4510000,-3000000\n').toString('base64');
  const ui=openWebUi({},undefined,cmd=>{
    if(!cmd.includes('charging-history.sh'))return;
    if(cmd.includes('--list'))return 'HISTORY_RUNNING=YES;HISTORY_ACTIVE='+active+';HISTORY_ERROR=NONE;HISTORY_MORE=NO;HISTORY_SESSIONS='+active+',1792340000,1792340300,300000,20,21,2,ACTIVE';
    return ++reads===1?new Promise(r=>{release=r;}):payload;
  });
  const flush=()=>new Promise(r=>setImmediate(r));await flush();ui.el('tab-history').emit('click');await flush();
  const canvas=ui.el('historyCanvas'),touch=(type,id,x)=>canvas.emit(type,{pointerType:'touch',pointerId:id,clientX:x,clientY:100,buttons:1});
  touch('pointerdown',1,137);touch('pointerdown',2,279);touch('pointermove',1,66);touch('pointermove',2,350);touch('pointerup',1,66);touch('pointerup',2,350);
  release(payload);await flush();await flush();
  assert.equal(reads,2);assert.equal(ui.el('historyRangeStart').value,'250');assert.equal(ui.el('historyRangeEnd').value,'750');
  const empty=openWebUi({},undefined,cmd=>cmd.includes('charging-history.sh')?'HISTORY_RUNNING=YES;HISTORY_ACTIVE=NONE;HISTORY_ERROR=NONE;HISTORY_MORE=NO;HISTORY_SESSIONS=NONE':undefined);
  await flush();empty.el('tab-history').emit('click');await flush();
  for(const type of ['pointerdown','pointermove','pointercancel']) for(const id of [1,2])empty.el('historyCanvas').emit(type,{pointerType:'touch',pointerId:id,clientX:100+id*50,clientY:100,buttons:1});
  await empty.el('historyRefresh').emit('click');assert.equal(empty.el('historyRefresh').disabled,false);assert.equal(empty.el('historyError').textContent,'');
});

test('图表慢请求期间丢弃自动刷新，长读取自动退避，存储不可用仍可切换双电芯',async()=>{
  const active='1792340000-12345678-100000';
  const list='HISTORY_RUNNING=YES;HISTORY_ACTIVE='+active+';HISTORY_ERROR=NONE;HISTORY_MORE=NO;HISTORY_SESSIONS='+active+',1792340000,1792340000,0,20,20,1,ACTIVE';
  const payload='HISTORY_ID='+active+';HISTORY_TOTAL=1;HISTORY_DATA_B64='+Buffer.from('1792340000,0,20,350,4500000,-2000000\n').toString('base64');
  let clock=0,release,calls=0;
  const originalNow=Date.now;Date.now=()=>clock;
  try {
    const ui=openWebUi({},undefined,cmd=>{
      if(!cmd.includes('charging-history.sh'))return;
      calls++;return cmd.includes('--list')?list:new Promise(resolve=>{release=resolve;});
    });
    const flush=()=>new Promise(r=>setImmediate(r));await flush();ui.el('tab-history').emit('click');await flush();
    const timer=ui.timers.find(t=>t.ms===200);
    for(let i=0;i<5;i++)await timer.fn();assert.equal(calls,2);
    clock=500;release(payload);await flush();assert.equal(calls,2,'完成慢读取后没有积压轮询');
    clock=1499;await timer.fn();assert.equal(calls,2);
    clock=1500;await timer.fn();await flush();assert.equal(calls,3,'500ms 请求留出三倍间隔后才重新轮询');
    Object.defineProperty(ui.window,'localStorage',{get(){throw new Error('存储被禁用');}});
    assert.doesNotThrow(()=>chargingHistory.createUI(async()=>payload,ui.doc));
    assert.equal(ui.el('historyDualCell').checked,false);
    ui.el('historyDualCell').checked=true;assert.doesNotThrow(()=>ui.el('historyDualCell').emit('change'));
  } finally { Date.now=originalNow; }
});

test('记录读取失败能重试，旧请求不能覆盖新选择的历史记录',async()=>{
  const active='1792340000-12345678-100000',old='1792330000-12345678-100000';
  let release, fail=false;
  const list='HISTORY_RUNNING=YES;HISTORY_ACTIVE='+active+';HISTORY_ERROR=NONE;HISTORY_MORE=NO;HISTORY_SESSIONS='+
    active+',1792340000,1792340000,0,20,20,1,ACTIVE:'+old+',1792330000,1792330000,0,10,10,1,UNPLUGGED';
  const ui=openWebUi({},undefined,cmd=>{
    if(!cmd.includes('charging-history.sh'))return;
    if(cmd.includes('--list'))return list;
    if(cmd.endsWith(active))return new Promise(r=>{release=r;});
    if(fail)throw new Error('暂时不可读');
    return 'HISTORY_ID='+old+';HISTORY_TOTAL=1;HISTORY_DATA_B64='+Buffer.from('1792330000,0,10,350,4500000,-2000000\n').toString('base64');
  });
  const flush=()=>new Promise(r=>setImmediate(r));await flush();ui.el('tab-history').emit('click');await flush();
  ui.el('historySession').value=old;ui.el('historySession').emit('change');
  release('invalid');await flush();await flush();
  assert.equal(ui.el('historyValue-soc').textContent,'10%');assert.equal(ui.el('historyError').textContent,'');
  fail=true;ui.el('historySession').emit('change');await flush();assert.match(ui.el('historyError').textContent,/暂时不可读/);
  fail=false;await ui.el('historyRefresh').emit('click');assert.equal(ui.el('historyValue-soc').textContent,'10%');
  assert.equal(ui.el('historyError').textContent,'');
});

test('间断充电一秒刷新阶段，暂停显示 MMI 停充，保存失败不报告成功且允许重试',async ()=>{
  const settings={PULSE_ENABLED:'YES',PULSE_STATE:'PAUSED',PULSE_REMAIN_MS:'1000',CONTROL_STATE:'RUNNING',ACTIVE_PROTOCOL:'UFCS',TARGET_RAW:'3000'};
  let fail=false;
  const ui=openWebUi(settings,field=>{if(fail && field==='pulse-charge')throw new Error('存储失败');});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.el('targetValueUFCS').textContent,'MMI 停充');
  assert.match(ui.el('pulseStatus').textContent,/MMI 停充.*1000/);
  ui.el('tab-control').emit('click');ui.entries.find(row=>row.dataset.detail==='pulse').emit('click');
  await new Promise(resolve=>setImmediate(resolve));
  settings.PULSE_STATE='CHARGING';settings.PULSE_REMAIN_MS='4500';
  await ui.timers.find(timer=>timer.ms===1000).fn();
  assert.match(ui.el('pulseStatus').textContent,/正常充电阶段.*4500/);
  fail=true;ui.el('pulseChargeInput').value='10';await ui.el('pulseChargeInput').emit('change');
  assert.match(ui.el('pulseSaveStatus').textContent,/保存失败.*存储失败/);
  assert.equal(ui.el('pulseChargeInput').disabled,false);assert.equal(ui.el('pulseChargeInput').value,'5');
  fail=false;ui.el('pulseChargeInput').value='10';await ui.el('pulseChargeInput').emit('change');
  assert.match(ui.el('pulseSaveStatus').textContent,/已保存并回读确认/);
});

test('UFCS 电量区间开关、弹窗添加、点击编辑六项参数、重开保留、删除和关闭回退',async ()=>{
  const settings={VOTE_INITIAL:'3000',UFCS_VOTE_MAX:'7000',INTERVAL_MS:'90'};
  const ui=openWebUi(settings);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.el('socSection').hidden,true);
  ui.el('socSwitch').checked=true; await ui.el('socSwitch').emit('change');
  assert.equal(ui.el('socSection').hidden,false);
  assert.match(ui.el('socList').children[0].textContent,/未添加/);
  ui.el('socAdd').emit('click');
  assert.equal(ui.el('socRangeDialog').open,true);
  ui.el('socStart').value='0'; ui.el('socEnd').value='20';
  await ui.el('socRangeForm').emit('submit');
  assert.equal(ui.el('socRangeDialog').open,false);
  assert.equal(settings.SOC_RANGES,'0,20,7000,3000,90,100,500,-50','新建区间以通用设置填入独立参数');
  ui.el('socList').children[0].emit('click');
  assert.equal(ui.el('socSettingsDialog').open,true);
  const values=[['socVoteMax','4200'],['socInitial','2000'],['socInterval','150'],['socRaise','200'],['socLower','100'],['socGap','-80']];
  for(const [id,value] of values) {
    ui.el(id+'Range').value=value; ui.el(id+'Range').emit('input');
    assert.equal(ui.el(id+'Input').value,value);
  }
  await ui.el('socSettingsForm').emit('submit');
  assert.equal(ui.el('socSettingsDialog').open,false);
  assert.equal(settings.SOC_RANGES,'0,20,4200,2000,150,200,100,-80');
  assert.equal(settings.VOTE_INITIAL,'3000'); assert.equal(settings.UFCS_VOTE_MAX,'7000'); assert.equal(settings.INTERVAL_MS,'90');
  const reopened=openWebUi(settings); await new Promise(resolve=>setImmediate(resolve));
  reopened.el('socList').children[0].emit('click');
  for(const [id,value] of values) assert.equal(reopened.el(id+'Input').value,value);
  await reopened.el('socDelete').emit('click');
  assert.equal(settings.SOC_RANGES,'NONE');
  assert.match(reopened.el('socList').children[0].textContent,/未添加/);
  reopened.el('socSwitch').checked=false; await reopened.el('socSwitch').emit('change');
  assert.equal(reopened.el('socSection').hidden,true);
});

test('区间弹窗拒绝重叠和越界输入，取消不保存，后端失败时保留编辑内容并允许重试',async ()=>{
  let fail=false;
  const settings={SOC_ENABLED:'YES',SOC_RANGES:'0,20,9000,1000,100,100,500,-50'};
  const ui=openWebUi(settings,field=>{if(fail && field==='soc-range-set') throw new Error('存储不可写');});
  await new Promise(resolve=>setImmediate(resolve));
  ui.el('socAdd').emit('click');
  await ui.el('socRangeForm').emit('submit');
  assert.match(ui.el('socRangeError').textContent,/重叠/); assert.equal(ui.writes,0);
  ui.el('socStart').value='21';ui.el('socEnd').value='101';
  await ui.el('socRangeForm').emit('submit'); assert.match(ui.el('socRangeError').textContent,/0–100/);
  ui.el('socRangeCancel').emit('click'); assert.equal(ui.el('socRangeDialog').open,false);
  ui.el('socList').children[0].emit('click');
  ui.el('socGapInput').value='1'; await ui.el('socSettingsForm').emit('submit');
  assert.match(ui.el('socSettingsError').textContent,/截止压差/); assert.equal(ui.writes,0);
  ui.el('socGapInput').value='-100'; fail=true;
  await ui.el('socSettingsForm').emit('submit');
  assert.equal(ui.el('socSettingsDialog').open,true);
  assert.match(ui.el('socSettingsError').textContent,/存储不可写/);
  assert.equal(ui.el('socGapInput').value,'-100'); assert.equal(ui.el('socSettingsSave').disabled,false);
  fail=false; await ui.el('socSettingsForm').emit('submit');
  assert.equal(ui.el('socSettingsDialog').open,false);
  assert.equal(settings.SOC_RANGES,'0,20,9000,1000,100,100,500,-100');
});

test('UFCS 可保存 4660mV，PPS 拒绝相同值',async ()=>{
  const settings={};const ui=openWebUi(settings); await new Promise(resolve=>setImmediate(resolve));
  ui.el('limitInputUFCS').value='4660'; await ui.el('limitInputUFCS').emit('change');
  assert.equal(settings.UFCS_LIMIT_MV,'4660');
  assert.equal(ui.el('limitInputUFCS').value,'4660');
  ui.el('limitInputPPS').value='4660'; await ui.el('limitInputPPS').emit('change');
  assert.equal(ui.writes,1); assert.equal(settings.PPS_LIMIT_MV,undefined);
});

test('温控开关和三组滑条输入保存回读，边界生效，重开保留',async ()=>{
  const settings={};
  const ui=openWebUi(settings);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.el('thermalSwitch').checked,false);
  for(const [id,value] of [['thermalLimit','45'],['thermalVote','1000'],['thermalGap','2']]) {
    assert.equal(ui.el(id+'Range').value,value);
    assert.equal(ui.el(id+'Input').value,value);
  }
  for(const [id,value] of [['thermalVote','499'],['thermalVote','5001'],['thermalGap','0'],['thermalGap','6'],['thermalLimit','60.5']]) {
    ui.el(id+'Input').value=value;
    await ui.el(id+'Input').emit('change');
  }
  assert.equal(ui.writes,0,'非法输入不得写入后台');
  for(const [id,value] of [['thermalLimit','60'],['thermalVote','500'],['thermalGap','5']]) {
    ui.el(id+'Range').value=value;
    ui.el(id+'Range').emit('input');
    assert.equal(ui.el(id+'Input').value,value);
    await ui.el(id+'Range').emit('change');
    assert.match(ui.el('thermalSaveStatus').textContent,/已保存并回读确认/);
  }
  ui.el('thermalVoteInput').value='5000';
  ui.el('thermalVoteInput').emit('input');
  assert.equal(ui.el('thermalVoteRange').value,'5000');
  await ui.el('thermalVoteInput').emit('change');
  ui.el('thermalSwitch').checked=true;
  await ui.el('thermalSwitch').emit('change');
  const reopened=openWebUi(settings);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reopened.el('thermalSwitch').checked,true);
  assert.equal(reopened.el('thermalLimitInput').value,'60');
  assert.equal(reopened.el('thermalVoteInput').value,'5000');
  assert.equal(reopened.el('thermalGapInput').value,'5');
});

test('温度页每秒独立刷新温度和状态，保留正在编辑的值，后台或离页后停止刷新',async ()=>{
  const settings={THERMAL_ENABLED:'YES',THERMAL_STATE:'LIMITED',THERMAL_ACTIVE:'YES',THERMAL_TEMP_DECI:'450'};
  let reads=0, fail=false;
  const ui=openWebUi(settings,undefined,cmd=>{
    if(cmd.endsWith('--thermal-status')) { reads++; if(fail) throw new Error('读取失败'); }
  });
  await new Promise(resolve=>setImmediate(resolve));
  const tick=ui.timers.find(item=>item.ms===1000).fn;
  await tick(); assert.equal(reads,0);
  ui.el('tab-control').emit('click');
  ui.entries.find(item=>item.dataset.detail==='thermal').emit('click');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.el('thermalTemp').textContent,'45.0°C');
  assert.match(ui.el('thermalStatus').textContent,/43°C/);
  settings.THERMAL_TEMP_DECI='429'; settings.THERMAL_STATE='NORMAL';
  ui.doc.activeElement=ui.el('thermalGapInput'); ui.el('thermalGapInput').value='5';
  await tick();
  assert.equal(ui.el('thermalTemp').textContent,'42.9°C');
  assert.equal(ui.el('thermalGapInput').value,'5','轮询不能覆盖正在输入的草稿');
  ui.doc.activeElement=null;
  fail=true; await tick();
  assert.equal(ui.el('thermalTemp').textContent,'—');
  assert.match(ui.el('thermalStatus').textContent,/读取失败/);
  const before=reads;
  ui.doc.hidden=true; await tick(); assert.equal(reads,before);
  ui.doc.hidden=false; ui.el('tab-overview').emit('click'); await tick(); assert.equal(reads,before);
});

test('温控保存期间禁止并发修改，失败时恢复实际值且不显示成功',async ()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const ui=openWebUi({},field=>field==='thermal-vote'?pending:undefined);
  await new Promise(resolve=>setImmediate(resolve));
  ui.el('thermalVoteInput').value='500';
  const saving=ui.el('thermalVoteInput').emit('change');
  assert.equal(ui.el('thermalSwitch').disabled,true);
  assert.equal(ui.el('thermalGapRange').disabled,true);
  ui.el('thermalGapInput').value='5'; await ui.el('thermalGapInput').emit('change');
  assert.equal(ui.writes,1);
  release(); await saving;
  assert.equal(ui.el('thermalVoteInput').value,'500');
  assert.equal(ui.el('thermalSwitch').disabled,false);
  const failed=openWebUi({},()=>{throw new Error('存储不可写');});
  await new Promise(resolve=>setImmediate(resolve));
  failed.el('thermalVoteInput').value='500'; await failed.el('thermalVoteInput').emit('change');
  assert.match(failed.el('thermalSaveStatus').textContent,/失败.*存储不可写/);
  assert.equal(failed.el('thermalVoteInput').value,'1000');
  assert.equal(failed.el('thermalVoteInput').disabled,false);
});

test('Tab 和控制设置直接原位切换，浏览器返回不产生中间记录', async ()=>{
  const ui=openWebUi();
  const {el,entries,backs,location,initialUrl}=ui;
  assert.equal(el('page-overview').hidden,false);
  assert.equal(el('page-control').hidden,true);
  el('tab-control').emit('click');
  assert.equal(el('page-control').hidden,false);
  assert.equal(el('control-index').hidden,false);
  assert.equal(el('bottomNav').hidden,false);
  for (let i=0;i<entries.length;i++) {
    entries[i].emit('click');
    assert.equal(el('control-index').hidden,true);
    assert.equal(el('bottomNav').hidden,true);
    for(const id of ['UFCS','PPS','advanced','thermal','pulse']) {
      assert.equal(el('control-detail-'+id).hidden,id!==entries[i].dataset.detail);
    }
    backs[i].emit('click');
    assert.equal(el('control-index').hidden,false);
    assert.equal(el('bottomNav').hidden,false);
  }
  el('tab-diagnostics').emit('click');
  assert.equal(el('page-diagnostics').hidden,false);
  assert.equal(ui.scans,0,'进入诊断不能自动扫描全部目录');
  assert.equal(ui.writes,0,'导航不应触发充电参数写入');
  assert.equal(location.hash,initialUrl,'导航期间不得更新 URL');
  el('tab-logs').emit('click');
  assert.equal(el('page-logs').hidden,false);
});

test('UFCS/PPS 分别恢复新默认值、保存后回读，重开保留，且不修改另一协议或高级参数',async ()=>{
  for(const [key,mv,vote] of [['UFCS','4560','10900'],['PPS','4460','5800']]) {
    const settings={UFCS_LIMIT_MV:'4200',UFCS_VOTE_MAX:'7000',PPS_LIMIT_MV:'4400',PPS_VOTE_MAX:'4800',VOTE_INITIAL:'3000'};
    const other=key==='UFCS'?'PPS':'UFCS';
    const before=[settings[other+'_LIMIT_MV'],settings[other+'_VOTE_MAX']];
    let release;
    const pending=new Promise(resolve=>{release=resolve;});
    const ui=openWebUi(settings,field=>field==='limit-set'?pending:undefined);
    await new Promise(resolve=>setImmediate(resolve));
    const resetting=ui.el('protoReset'+key).emit('click');
    for(const prefix of ['protoReset','limitRange','limitInput','voteMaxRange','voteMaxInput','protoSwitch']) {
      assert.equal(ui.el(prefix+key).disabled,true);
    }
    await ui.el('protoReset'+key).emit('click');
    assert.equal(ui.writes,1,'恢复过程中不得重复提交');
    release();
    await resetting;
    assert.equal(settings[key+'_LIMIT_MV'],mv);
    assert.equal(settings[key+'_VOTE_MAX'],vote);
    assert.deepEqual([settings[other+'_LIMIT_MV'],settings[other+'_VOTE_MAX']],before);
    assert.equal(settings.VOTE_INITIAL,'3000');
    assert.match(ui.el('protoSaveStatus'+key).textContent,/回读确认/);
    assert.equal(ui.el('protoReset'+key).disabled,false);
    const reopened=openWebUi(settings);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(reopened.el('limitInput'+key).value,mv);
    assert.equal(reopened.el('voteMaxInput'+key).value,vote);
  }
});

test('协议恢复默认中途失败或回读不一致时不能报告成功，界面显示实际保存值',async ()=>{
  const settings={UFCS_LIMIT_MV:'4200',UFCS_VOTE_MAX:'7000'};
  const ui=openWebUi(settings,field=>{
    if(field==='vote-max-set') throw new Error('保存失败');
  });
  await new Promise(resolve=>setImmediate(resolve));
  await ui.el('protoResetUFCS').emit('click');
  assert.match(ui.el('protoSaveStatusUFCS').textContent,/未完成/);
  assert.equal(ui.el('limitInputUFCS').value,'4560');
  assert.equal(ui.el('voteMaxInputUFCS').value,'7000');
  assert.equal(ui.el('protoResetUFCS').disabled,false);
  const racedSettings={};
  const raced=openWebUi(racedSettings,field=>{
    if(field==='vote-max-set') racedSettings.UFCS_LIMIT_MV='4300';
  });
  await raced.el('protoResetUFCS').emit('click');
  assert.match(raced.el('protoSaveStatusUFCS').textContent,/回读值不一致/);
  assert.equal(raced.el('limitInputUFCS').value,'4300');
});

test('概览读取未结束时点击日志，日志立即独立读取；历史日志不多读当前文件',async ()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const calls=[];
  const ui=openWebUi({},undefined,cmd=>{
    calls.push(cmd);
    if(cmd.includes('charge-test.sh') && cmd.endsWith('--status')) return pending;
    if(cmd.includes('log-reader.sh') && cmd.endsWith('--status')) return 'WATCHDOG=RUNNING;CURRENT_BYTES=99';
    if(cmd.endsWith('--latest')) return 'epoch=1000 state=CONTROL_READY';
    if(cmd.endsWith('--previous')) return 'epoch=900 state=CONTROL_STOPPED';
  });
  ui.el('tab-logs').emit('click');
  await new Promise(resolve=>setImmediate(resolve));
  try {
    assert.ok(calls.some(cmd=>cmd.endsWith('--latest')),'日志不能等待概览读取完成');
    assert.match(ui.el('count').textContent,/1 \/ 1/);
    calls.length=0;
    ui.el('source').value='previous';
    await ui.el('source').emit('change');
    assert.ok(calls.some(cmd=>cmd.endsWith('--previous')));
    assert.equal(calls.some(cmd=>cmd.endsWith('--latest')),false);
    assert.equal(calls.some(cmd=>cmd.includes('--negotiation')),false);
  } finally {
    release();
    await new Promise(resolve=>setImmediate(resolve));
  }
});

test('概览不再读取协商卡片，进入诊断页仍能获取当前协议投票快照',async ()=>{
  let online=true;const calls=[];
  const ui=openWebUi({},undefined,cmd=>{
    calls.push(cmd);
    if(cmd.includes('charge-test.sh') && cmd.endsWith('--status')) return 'CONTROL_STATE=RUNNING;ACTIVE_PROTOCOL=UFCS;TARGET_RAW=8500;MONITOR_ENABLED=YES';
    if(cmd.endsWith('--protocol')) return 'UFCS=1;VOOC=0;PPS=0;USB_ONLINE=1;POWER=YES';
    if(cmd.endsWith('--negotiation')) return online
      ? 'USB_ONLINE=1;VOTE_PROTOCOL=UFCS;VOTE_EFFECTIVE=8000;VOTE_OWNER=TEST;VOTE_FORCE_ACTIVE=1;VOTE_FORCE_VAL=8500'
      : 'USB_ONLINE=0;VOTE_PROTOCOL=NONE';
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.some(cmd=>cmd.endsWith('--negotiation')),false);
  assert.notEqual(ui.el('stateName').textContent,'读取中…');
  ui.el('tab-diagnostics').emit('click');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.el('diagEffective').textContent,'8000');assert.equal(ui.el('diagForceVal').textContent,'8500');
  assert.equal(ui.el('diagForceActive').textContent,'1 · 已开启');
  online=false;
  ui.el('tab-overview').emit('click');ui.el('tab-diagnostics').emit('click');await new Promise(resolve=>setImmediate(resolve));
  for(const id of ['diagEffective','diagForceVal','diagForceActive'])assert.equal(ui.el(id).textContent,'—');
});

test('恢复默认保存七项参数，阻止并发修改，重开页面仍显示默认值',async ()=>{
  const settings={VOTE_INITIAL:'4200',INTERVAL_MS:'90',RAISE_STEP:'180',
    LOWER_STEP:'170',CUTOFF_GAP_MV:'-60',UFCS_LIMIT_MV:'4200',PPS_VOTE_MAX:'5000'};
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const ui=openWebUi(settings,()=>pending);
  await new Promise(resolve=>setImmediate(resolve));
  const values=[['advInitial','2000'],['advInterval','100'],['advRaise','100'],
    ['advLower','1000'],['advGap','-50'],['advEarlyGap','-10'],['advEarlyStep','200']];
  const resetting=ui.el('advReset').emit('click');
  assert.equal(ui.el('advReset').disabled,true);
  for (const [id] of values) {
    assert.equal(ui.el(id+'Input').disabled,true);
    assert.equal(ui.el(id+'Range').disabled,true);
  }
  await ui.el('advReset').emit('click');
  ui.el('advRaiseInput').value='200';
  await ui.el('advRaiseInput').emit('change');
  assert.equal(ui.writes,1,'恢复期间不得并发保存');
  release();
  await resetting;
  assert.equal(ui.writes,7);
  assert.equal(ui.el('advReset').disabled,false);
  assert.match(ui.el('advSaveStatus').textContent,/已恢复默认并回读确认/);
  assert.equal(settings.UFCS_LIMIT_MV,'4200');
  assert.equal(settings.PPS_VOTE_MAX,'5000');
  const reopened=openWebUi(settings);
  await new Promise(resolve=>setImmediate(resolve));
  for (const [id,value] of values) {
    for (const page of [ui,reopened]) {
      assert.equal(page.el(id+'Input').value,value);
      assert.equal(page.el(id+'Range').value,value);
      assert.equal(page.el(id+'Value').textContent,value);
      assert.equal(page.el(id+'Input').disabled,false);
    }
  }
});

test('恢复中途保存失败时提示未完成，显示实际值并允许重试',async ()=>{
  const settings={VOTE_INITIAL:'4200',INTERVAL_MS:'90',RAISE_STEP:'180',
    LOWER_STEP:'170',CUTOFF_GAP_MV:'-60'};
  let fail=true;
  const ui=openWebUi(settings,field=>{
    if (fail && field==='interval') throw new Error('保存失败');
  });
  await new Promise(resolve=>setImmediate(resolve));
  await ui.el('advReset').emit('click');
  assert.match(ui.el('advSaveStatus').textContent,/恢复默认未完成/);
  assert.equal(ui.el('advInitialInput').value,'2000');
  assert.equal(ui.el('advIntervalInput').value,'90');
  assert.equal(ui.el('advReset').disabled,false);
  assert.equal(ui.el('advLowerInput').disabled,false);
  fail=false;
  await ui.el('advReset').emit('click');
  assert.match(ui.el('advSaveStatus').textContent,/已恢复默认并回读确认/);
});

test('恢复默认回读不一致时不得报告成功',async ()=>{
  const settings={VOTE_INITIAL:'4200'};
  const ui=openWebUi(settings,field=>{
    if (field==='cutoff-gap') settings.VOTE_INITIAL='3000';
  });
  await new Promise(resolve=>setImmediate(resolve));
  await ui.el('advReset').emit('click');
  assert.match(ui.el('advSaveStatus').textContent,/恢复默认未完成.*回读值不一致/);
  assert.equal(ui.el('advInitialInput').value,'3000');
  assert.equal(ui.el('advReset').disabled,false);
});

test('高级参数保存后重开 WebUI，滑动条、输入框和数值显示均恢复已保存值',async ()=>{
  const settings={};
  const ui=openWebUi(settings);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.el('advLowerInput').value,'500');
  for (const [id,value] of [['advRaise','501'],['advLower','99']]) {
    ui.el(id+'Input').value=value;
    await ui.el(id+'Input').emit('change');
  }
  assert.equal(ui.writes,0,'越界步进不得写入');
  const values=[['advInitial','4200'],['advInterval','90'],['advRaise','180'],
    ['advLower','170'],['advGap','-60']];
  for (const [id,value] of values) {
    ui.el(id+'Input').value=value;
    await ui.el(id+'Input').emit('change');
    assert.match(ui.el('advSaveStatus').textContent,/已保存并回读确认/);
  }
  assert.equal(ui.writes,5);
  const reopened=openWebUi(settings);
  await new Promise(resolve=>setImmediate(resolve));
  reopened.el('tab-control').emit('click');
  reopened.entries[2].emit('click');
  for (const [id,value] of values) {
    assert.equal(reopened.el(id+'Input').value,value,id+' 输入框');
    assert.equal(reopened.el(id+'Range').value,value,id+' 滑动条');
    assert.equal(reopened.el(id+'Value').textContent,value,id+' 显示值');
  }
  assert.equal(reopened.writes,0,'重新打开页面不得写入默认参数');
});

test('提前降流两项联动，0 时禁止调步进，保存与重开持久化，关闭保留步进且恢复当前预设',async()=>{
  const settings={},flush=()=>new Promise(r=>setImmediate(r)),ui=openWebUi(settings);await flush();
  assert.equal(ui.el('advEarlyGapInput').value,'0');assert.equal(ui.el('advEarlyStepInput').value,'0');
  assert.equal(ui.el('advEarlyStepInput').disabled,true);
  ui.el('advEarlyStepInput').value='100';await ui.el('advEarlyStepInput').emit('change');assert.equal(ui.writes,0);
  for(const raw of ['-51','1','-1.5']) {
    ui.el('advEarlyGapInput').value=raw;await ui.el('advEarlyGapInput').emit('change');
  }
  assert.equal(ui.writes,0);
  ui.el('advEarlyGapRange').value='-50';ui.el('advEarlyGapRange').emit('input');
  assert.equal(ui.el('advEarlyGapInput').value,'-50');assert.equal(ui.el('advEarlyStepInput').disabled,true,'仅拖动草稿不解锁');
  await ui.el('advEarlyGapRange').emit('change');assert.equal(ui.el('advEarlyStepInput').disabled,false);
  for(const raw of ['-1','1001','1.5']) {ui.el('advEarlyStepInput').value=raw;await ui.el('advEarlyStepInput').emit('change');}
  assert.equal(ui.writes,1);
  for(const value of ['0','1000','50']) {
    ui.el('advEarlyStepInput').value=value;ui.el('advEarlyStepInput').emit('input');
    assert.equal(ui.el('advEarlyStepRange').value,value);await ui.el('advEarlyStepInput').emit('change');
    assert.equal(settings.EARLY_STEP_MA,value);
  }
  const reopened=openWebUi(settings);await flush();
  assert.equal(reopened.el('advEarlyGapInput').value,'-50');assert.equal(reopened.el('advEarlyStepInput').value,'50');
  assert.equal(reopened.el('advEarlyStepInput').disabled,false);
  reopened.el('advEarlyGapInput').value='0';await reopened.el('advEarlyGapInput').emit('change');
  assert.equal(reopened.el('advEarlyStepInput').disabled,true);assert.equal(settings.EARLY_STEP_MA,'50');
  await reopened.el('advReset').emit('click');
  assert.equal(settings.EARLY_GAP_MV,'-10');assert.equal(settings.EARLY_STEP_MA,'200');assert.equal(reopened.el('advEarlyStepInput').disabled,false);
});

test('提前降流压差保存中锁定配套步进，失败保持实际值并允许重试',async()=>{
  let release,fail=true;
  const ui=openWebUi({},field=>field==='early-gap'?new Promise((resolve,reject)=>{release=()=>fail?reject(new Error('存储不可写')):resolve();}):undefined);
  await new Promise(r=>setImmediate(r));ui.el('advEarlyGapInput').value='-10';
  let pending=ui.el('advEarlyGapInput').emit('change');await new Promise(r=>setImmediate(r));
  assert.equal(ui.el('advEarlyStepInput').disabled,true);ui.el('advEarlyStepInput').value='20';await ui.el('advEarlyStepInput').emit('change');assert.equal(ui.writes,1);
  release();await pending;assert.equal(ui.el('advEarlyGapInput').value,'0');assert.equal(ui.el('advEarlyStepInput').disabled,true);
  assert.match(ui.el('advSaveStatus').textContent,/失败.*存储不可写/);
  fail=false;ui.el('advEarlyGapInput').value='-10';pending=ui.el('advEarlyGapInput').emit('change');await new Promise(r=>setImmediate(r));release();await pending;
  assert.equal(ui.el('advEarlyStepInput').disabled,false);
});


test('异常区间响应只影响区间设置，控制状态及其它设置仍可刷新',async()=>{
  const ui=openWebUi({SOC_ENABLED:'YES',SOC_RANGES:'0,20',THERMAL_ENABLED:'YES',PULSE_ENABLED:'YES'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.doesNotMatch(ui.el('error').textContent,/区间参数响应无效/);
  assert.equal(ui.el('monitorSwitch').checked,true);
  assert.equal(ui.el('thermalSwitch').checked,true);
  assert.equal(ui.el('pulseSwitch').checked,true);
  assert.equal(ui.el('socSwitch').disabled,true);
  assert.match(ui.el('socStatus').textContent,/区间参数响应无效/);
});

test('原生回调桥接不会同步阻塞子页、日志导航和滑条保存',async()=>{
  let synchronous=0;
  const ui=openWebUi({},undefined,undefined,exec=>(cmd,options,callback)=>{
    if (!callback) {
      synchronous++;
      const start=performance.now();while(performance.now()-start<30){};
      return exec(cmd);
    }
    exec(cmd).then(stdout=>ui.window[callback](0,stdout,''));
  });
  await new Promise(resolve=>setImmediate(resolve));
  ui.el('tab-control').emit('click');
  let start=performance.now();ui.entries.find(row=>row.dataset.detail==='UFCS').emit('click');
  const detailMs=performance.now()-start;
  start=performance.now();ui.el('tab-logs').emit('click');const logMs=performance.now()-start;
  ui.el('advRaiseRange').value='200';ui.el('advRaiseRange').emit('input');
  start=performance.now();const saving=ui.el('advRaiseRange').emit('change');const saveMs=performance.now()-start;
  await saving;
  // 慢桥接下只约束事件处理时长，后台完成时间不计入点击响应。
  assert.equal(synchronous,0,'所有后台调用应使用回调，单参数接口会阻塞 WebView');
  assert.ok(detailMs<20 && logMs<20 && saveMs<20);
});

test('后台刷新不回写正在拖动的协议和通用参数滑条',async()=>{
  const ui=openWebUi();await new Promise(resolve=>setImmediate(resolve));
  for(const id of ['limitUFCS','voteMaxUFCS','advRaise']) {
    const prefix=id.endsWith('UFCS')?id.slice(0,-4):id;
    const range=ui.el(id.endsWith('UFCS')?prefix+'RangeUFCS':id+'Range');
    const input=ui.el(id.endsWith('UFCS')?prefix+'InputUFCS':id+'Input');
    const value=id==='limitUFCS'?'4600':id==='voteMaxUFCS'?'8000':'200';
    ui.doc.activeElement=range;range.value=value;range.emit('input');
    await ui.el('refresh').emit('click');
    assert.equal(range.value,value,id+' 滑条不应被轮询拉回');assert.equal(input.value,value);
  }
});


test('汇总响应不完整时独立重读区间，不丢失已保存列表',async()=>{
  const settings={SOC_ENABLED:'YES',SOC_RANGES:'0,20,9000,1000,100,100,500,-50|60,80,5000,1200,80,100,500,-80'};
  let reads=0;
  const ui=openWebUi(settings,undefined,cmd=>{
    if(cmd.endsWith('--status') && cmd.includes('charge-test.sh'))
      return 'CONTROL_STATE=STOPPED;MONITOR_ENABLED=YES;SOC_ENABLED=YES;SOC_CONFIG_VALID=YES;SOC_RANGES=0,20';
    if(cmd.endsWith('--soc-status')) reads++;
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1);assert.equal(ui.el('error').textContent,'');
  assert.equal(ui.el('socList').children.length,2);assert.equal(ui.el('socSwitch').disabled,false);
  ui.el('socList').children[1].emit('click');
  assert.equal(ui.el('socGapInput').value,'-80');assert.equal(ui.writes,0);
});

test('流式桥接保留全部状态行，检查退出码并清理回调',async()=>{
  let count=0,fail=false;
  const ui=openWebUi({},undefined,undefined,(exec,window)=>{
    window.ksu.spawn=(command,args,options,name)=>{
      count++;assert.equal(args,'[]');assert.equal(options,'{}');
      exec(command).then(stdout=>{
        const callback=window[name];
        if(fail && command.includes('--raise-step-set')) {
          callback.stderr.emit('data','存储失败');callback.emit('exit',2);return;
        }
        for(const line of stdout.replaceAll(';','\n').split('\n')) callback.stdout.emit('data',line);
        callback.emit('exit',0);
      });
    };
    return ()=>{assert.fail('有流式接口时不能使用阻塞 exec');};
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(count>=3);assert.equal(ui.el('socSwitch').disabled,false);
  ui.el('advRaiseInput').value='200';await ui.el('advRaiseInput').emit('change');
  assert.match(ui.el('advSaveStatus').textContent,/回读确认/);
  fail=true;ui.el('advRaiseInput').value='300';await ui.el('advRaiseInput').emit('change');
  assert.match(ui.el('error').textContent,/errno=2.*存储失败/);
  assert.equal(Object.keys(ui.window).filter(key=>key.startsWith('oplusCommand')).length,0);
});

test('真机旧响应空列表为竖线时开关可开启，已保存区间末尾分隔符不产生空行',async()=>{
  const rows=['|','0,20,9000,1000,100,100,500,-50|',
    '0,20,9000,1000,100,100,500,-50|60,80,5000,1200,80,100,500,-80|'];
  for(const [i,raw] of rows.entries()) {
    const settings={SOC_ENABLED:'NO',SOC_RANGES:raw};
    const ui=openWebUi(settings);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ui.el('socSwitch').disabled,false,raw);
    assert.doesNotMatch(ui.el('socStatus').textContent,/无效/);
    ui.el('socSwitch').checked=true;await ui.el('socSwitch').emit('change');
    assert.equal(settings.SOC_ENABLED,'YES');assert.equal(ui.el('socSwitch').disabled,false);
    assert.equal(ui.el('socAdd').disabled,false);
    assert.equal(ui.el('socList').children.length,i || 1);
    if(i===2) {
      ui.el('socList').children[1].emit('click');
      assert.equal(ui.el('socGapInput').value,'-80');
    }
  }
  for(const raw of ['', '||', '0,20|', '0,20,9000,1000,100,100,500,-50||60,80,5000,1200,80,100,500,-80']) {
    const ui=openWebUi({SOC_RANGES:raw});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ui.el('socSwitch').disabled,true,raw);
  }
});

test('温度伪装开关、滑条和输入框保存成功，展示 horae 命令结果，重开保留',async()=>{
  const settings={};const ui=openWebUi(settings);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.el('fakeSwitch').checked,false);
  assert.match(ui.el('fakeHoraeStatus').textContent,/尚无执行记录/);
  ui.el('fakeSwitch').checked=true;await ui.el('fakeSwitch').emit('change');
  assert.equal(settings.FAKETEMP_ENABLED,'YES');assert.equal(ui.el('error').textContent,'');
  assert.match(ui.el('fakeSaveStatus').textContent,/回读确认/);
  assert.match(ui.el('fakeHoraeStatus').textContent,/已发送开启测试模式/);
  ui.el('fakeValueRange').value='35.5';ui.el('fakeValueRange').emit('input');
  assert.equal(ui.el('fakeValueInput').value,'35.5');await ui.el('fakeValueRange').emit('change');
  assert.equal(settings.FAKETEMP_VALUE_DECI,'355');assert.match(ui.el('fakeSaveStatus').textContent,/回读确认/);
  const reopened=openWebUi(settings);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reopened.el('fakeSwitch').checked,true);assert.equal(reopened.el('fakeValueInput').value,'35.5');
  reopened.el('fakeSwitch').checked=false;await reopened.el('fakeSwitch').emit('change');
  assert.equal(settings.FAKETEMP_ENABLED,'NO');assert.match(reopened.el('fakeHoraeStatus').textContent,/已发送恢复正常模式/);
});

test('horae 应用结果不成功时页面不能报告保存成功，并显示失败状态',async()=>{
  const settings={FAKETEMP_ENABLED:'YES',FAKETEMP_STATE:'PENDING',FAKETEMP_HORAE_STATE:'ERROR'};
  const ui=openWebUi(settings);await new Promise(resolve=>setImmediate(resolve));
  assert.match(ui.el('fakeHoraeStatus').textContent,/失败或超时/);
  ui.el('fakeValueInput').value='35';await ui.el('fakeValueInput').emit('change');
  assert.match(ui.el('fakeSaveStatus').textContent,/未应用成功/);
  assert.doesNotMatch(ui.el('fakeSaveStatus').textContent,/已保存并回读确认/);
  assert.equal(ui.el('fakeSwitch').disabled,false);
});

test('自适应伪装默认关闭，开启后与固定温度互斥，并显示真实温度和写入值',async()=>{
  const settings={FAKETEMP_ENABLED:'YES'};const ui=openWebUi(settings);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.el('fakeAdaptiveSwitch').checked,false);
  assert.equal(ui.el('fakeOffsetInput').value,'5');
  ui.el('fakeAdaptiveSwitch').checked=true;await ui.el('fakeAdaptiveSwitch').emit('change');
  assert.equal(ui.el('fakeAdaptiveSwitch').checked,true);
  assert.equal(ui.el('fakeSwitch').checked,false);
  assert.equal(ui.el('fakeValueInput').disabled,true);
  assert.equal(ui.el('fakeTag').textContent,'自适应');
  assert.match(ui.el('fakeAdaptiveReading').textContent,/40\.0°C → 伪装温度 35\.0°C/);
  ui.el('fakeOffsetRange').value='20';ui.el('fakeOffsetRange').emit('input');
  assert.equal(ui.el('fakeOffsetInput').value,'20');
  assert.equal(ui.el('fakeOffsetValue').textContent,'20');
  await ui.el('fakeOffsetRange').emit('change');
  assert.equal(settings.FAKETEMP_OFFSET_C,'20');
  assert.match(ui.el('fakeAdaptiveReading').textContent,/40\.0°C → 伪装温度 20\.0°C/);
  const reopened=openWebUi(settings);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reopened.el('fakeAdaptiveSwitch').checked,true);
  assert.equal(reopened.el('fakeOffsetInput').value,'20');
  reopened.el('fakeSwitch').checked=true;await reopened.el('fakeSwitch').emit('change');
  assert.equal(reopened.el('fakeAdaptiveSwitch').checked,false);
  assert.equal(reopened.el('fakeSwitch').checked,true);
  assert.equal(reopened.el('fakeValueInput').disabled,false);
  assert.match(reopened.el('fakeSaveStatus').textContent,/回读确认/);
});

test('自适应温差输入接受 0，拒绝空值、越界与非整数，关闭时修改不启用伪装',async()=>{
  const settings={};const ui=openWebUi(settings);await new Promise(resolve=>setImmediate(resolve));
  ui.el('fakeOffsetInput').value='0';ui.el('fakeOffsetInput').emit('input');
  await ui.el('fakeOffsetInput').emit('change');
  assert.equal(settings.FAKETEMP_OFFSET_C,'0');assert.equal(ui.el('fakeAdaptiveSwitch').checked,false);
  const writes=ui.writes;
  for(const value of ['','-1','21','1.5','1;echo bad']) {
    ui.el('fakeOffsetInput').value=value;await ui.el('fakeOffsetInput').emit('change');
    assert.match(ui.el('fakeSaveStatus').textContent,/0–20/);assert.equal(ui.writes,writes);
  }
});

test('自适应温度读取失败时显示异常和空读数，不能报告成功',async()=>{
  const settings={FAKETEMP_ENABLED:'NO',FAKETEMP_ADAPTIVE_ENABLED:'YES',FAKETEMP_STATE:'SENSOR_ERROR',
    FAKETEMP_HORAE_STATE:'NORMAL_SENT',FAKETEMP_REAL_DECI:'UNKNOWN',FAKETEMP_TARGET_DECI:'UNKNOWN'};
  const ui=openWebUi(settings);await new Promise(resolve=>setImmediate(resolve));
  assert.match(ui.el('fakeStatus').textContent,/读取异常/);
  assert.match(ui.el('fakeAdaptiveReading').textContent,/等待有效/);
  ui.el('fakeOffsetInput').value='10';await ui.el('fakeOffsetInput').emit('change');
  assert.match(ui.el('fakeSaveStatus').textContent,/未应用成功/);
  assert.equal(ui.el('fakeAdaptiveSwitch').disabled,false);
});

test('自适应温度每秒刷新，保留草稿，切模式后丢弃旧响应且离页不再读取',async()=>{
  const settings={FAKETEMP_ENABLED:'NO',FAKETEMP_ADAPTIVE_ENABLED:'YES',FAKETEMP_STATE:'APPLIED',
    FAKETEMP_HORAE_STATE:'TEST_SENT',FAKETEMP_REAL_DECI:'400',FAKETEMP_TARGET_DECI:'350'};
  let hold=false, release, reads=0;
  const old='FAKETEMP_ENABLED=NO;FAKETEMP_ADAPTIVE_ENABLED=YES;FAKETEMP_VALUE_DECI=360;FAKETEMP_OFFSET_C=5;FAKETEMP_STATE=APPLIED;FAKETEMP_HORAE_STATE=TEST_SENT;FAKETEMP_REAL_DECI=400;FAKETEMP_TARGET_DECI=350;';
  const ui=openWebUi(settings,undefined,cmd=>{
    if(cmd.endsWith('--faketemp-status')) {
      reads++;
      if(hold) {hold=false;return new Promise(resolve=>{release=()=>resolve(old);});}
    }
  });
  const flush=()=>new Promise(resolve=>setImmediate(resolve));await flush();
  const tick=ui.timers.find(item=>item.ms===1000).fn;
  ui.el('tab-control').emit('click');ui.entries.find(item=>item.dataset.detail==='faketemp').emit('click');await flush();
  settings.FAKETEMP_REAL_DECI='410';settings.FAKETEMP_TARGET_DECI='360';
  ui.doc.activeElement=ui.el('fakeOffsetInput');ui.el('fakeOffsetInput').value='12';await tick();
  assert.match(ui.el('fakeAdaptiveReading').textContent,/41\.0°C → 伪装温度 36\.0°C/);
  assert.equal(ui.el('fakeOffsetInput').value,'12');ui.doc.activeElement=null;
  hold=true;const pending=tick();await flush();
  ui.el('fakeSwitch').checked=true;await ui.el('fakeSwitch').emit('change');
  release();await pending;
  assert.equal(ui.el('fakeSwitch').checked,true);assert.equal(ui.el('fakeAdaptiveSwitch').checked,false);
  const before=reads;ui.doc.hidden=true;await tick();assert.equal(reads,before);
  ui.doc.hidden=false;ui.el('tab-overview').emit('click');await tick();assert.equal(reads,before);
});

test('自适应响应温差、互斥标记或真实/写入温度损坏时不能报告成功',async()=>{
  const base={FAKETEMP_ENABLED:'NO',FAKETEMP_ADAPTIVE_ENABLED:'YES',FAKETEMP_VALUE_DECI:'360',
    FAKETEMP_OFFSET_C:'5',FAKETEMP_STATE:'APPLIED',FAKETEMP_HORAE_STATE:'TEST_SENT',
    FAKETEMP_REAL_DECI:'400',FAKETEMP_TARGET_DECI:'350'};
  for(const bad of [{FAKETEMP_OFFSET_C:''},{FAKETEMP_ENABLED:'YES'},{FAKETEMP_REAL_DECI:'UNKNOWN'},
    {FAKETEMP_TARGET_DECI:'999999999'},{FAKETEMP_TARGET_DECI:'340'}]) {
    const ui=openWebUi({...base},undefined,cmd=>cmd.endsWith('--faketemp-status')
      ? Object.entries({...base,...bad}).map(([key,value])=>key+'='+value).join(';'):undefined);
    await new Promise(resolve=>setImmediate(resolve));
    ui.el('fakeOffsetInput').value='5';await ui.el('fakeOffsetInput').emit('change');
    assert.match(ui.el('fakeSaveStatus').textContent,/响应无效|回读值不一致/);
    assert.doesNotMatch(ui.el('fakeSaveStatus').textContent,/已保存并回读确认/);
  }
});
