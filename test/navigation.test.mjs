import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';

const dir=resolve(fileURLToPath(new URL('..',import.meta.url)));
const html=readFileSync(join(dir,'webroot/index.html'),'utf8');
const script=readFileSync(join(dir,'webroot/app.js'),'utf8');
const require=createRequire(import.meta.url);
const parser=require('../webroot/log-utils.js');

function mockElement(id='') {
  const listeners=new Map();
  return {
    id, hidden:false, disabled:false, checked:false, value:'', textContent:'',
    className:'', dataset:{}, style:{}, tabIndex:0, children:[],
    addEventListener(type,fn) { listeners.set(type,fn); },
    emit(type) { return listeners.get(type)?.({preventDefault(){}}); },
    setAttribute(name,value) { this[name]=value; },
    getAttribute() { return '测试输入框'; },
    append(...items) { this.children.push(...items); },
    appendChild(node) { this.children.push(node); return node; },
    replaceChildren(...items) { this.children=[...items]; },
    querySelectorAll() { return []; },
    focus() {},
    remove() {},
  };
}

function openWebUi(settings={},onSet,onCommand) {
  const ids=[...html.matchAll(/id="([^"]+)"/g)].map(x=>x[1]);
  assert.equal(new Set(ids).size,ids.length,'DOM id 不得重复');
  const map=new Map(ids.map(id=>[id,mockElement(id)]));
  for (const [tag] of html.matchAll(/<input\b[^>]*>/g)) {
    const id=/id="([^"]+)"/.exec(tag)?.[1];
    if (id) map.get(id).value=/value="([^"]*)"/.exec(tag)?.[1] || '';
  }
  const entries=['UFCS','PPS','advanced'].map(id=>{
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
    scrollTo(){},
    ksu:{async exec(cmd) {
      const response=await onCommand?.(cmd);
      if(response !== undefined) return response;
      if(cmd.includes('--votables')) {scans++;return 'VOTABLES_UNAVAILABLE';}
      const setter=/--(vote-initial|interval|raise-step|lower-step|cutoff-gap)-set (-?\d+)$/.exec(cmd);
      if(setter) {
        const keys={'vote-initial':'VOTE_INITIAL',interval:'INTERVAL_MS',
          'raise-step':'RAISE_STEP','lower-step':'LOWER_STEP','cutoff-gap':'CUTOFF_GAP_MV'};
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
      if(cmd.endsWith('--status')&&cmd.includes('charge-test.sh')) return [
        'CONTROL_STATE=STOPPED','PHASE=IDLE','REASON=WAITING_PROTOCOL',
        'MONITOR_ENABLED=YES','ACTIVE_PROTOCOL=NONE','ONLINE_PROTOCOL=NONE',
        'UFCS_ENABLED=YES','UFCS_LIMIT_MV=4560','UFCS_VOTE_MAX=9000',
        'PPS_ENABLED=YES','PPS_LIMIT_MV=4500','PPS_VOTE_MAX=5000',
        'VOTE_INITIAL=1000','INTERVAL_MS=100','RAISE_STEP=100',
        'LOWER_STEP=500','CUTOFF_GAP_MV=-50',
        ...Object.entries(settings).map(([key,value])=>key+'='+value),
      ].join(';');
      if(cmd.includes('--protocol')) return 'UFCS=0;VOOC=0;PPS=0;USB_ONLINE=0;POWER=NO';
      if(cmd.includes('--battery')) return 'BATTERY_TEMP_DECI=340;BATTERY_VOLTAGE_UV=4300000;POWER=UNPLUGGED';
      if(cmd.includes('--negotiation')) return 'USB_ONLINE=0;USB_VOLTAGE_UV=UNKNOWN;VOTE_PROTOCOL=NONE';
      if(cmd.includes('--votes')) return 'VOTES_UNAVAILABLE';
      return 'NO_LOGS_YET';
    }},
  };
  const initialUrl='#legacy-diagnostics';
  const location={hash:initialUrl};
  const history={pushState(){assert.fail('不允许 pushState');},
    replaceState(){assert.fail('不允许 replaceState');}};
  runInNewContext(script,{
    window,document:doc,location,history,navigator:{},setInterval(fn,ms){timers.push({fn,ms});},setTimeout(){},
    console, Date, Promise,
  });
  const el=id=>map.get(id);
  return {el,entries,backs,location,initialUrl,doc,timers,
    get writes(){return writes;},get scans(){return scans;}};
}

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
    for(const id of ['UFCS','PPS','advanced']) {
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
  for(const [key,mv,vote] of [['UFCS','4560','9000'],['PPS','4500','5000']]) {
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

test('概览四项显示真实 USB 读数和模块目标，断开 USB 后隐藏残留',async ()=>{
  let online=true;
  const ui=openWebUi({},undefined,cmd=>{
    if(cmd.includes('charge-test.sh') && cmd.endsWith('--status')) return 'CONTROL_STATE=RUNNING;ACTIVE_PROTOCOL=UFCS;TARGET_RAW=8500;MONITOR_ENABLED=YES';
    if(cmd.endsWith('--protocol')) return 'UFCS=1;VOOC=0;PPS=0;USB_ONLINE=1;POWER=YES';
    if(cmd.endsWith('--negotiation')) return online
      ? 'USB_ONLINE=1;USB_VOLTAGE_UV=8900000;USB_VOLTAGE_MAX_UV=11000000;USB_INPUT_LIMIT_UA=1200000'
      : 'USB_ONLINE=0;USB_VOLTAGE_UV=8900000;USB_VOLTAGE_MAX_UV=11000000;USB_INPUT_LIMIT_UA=1200000';
  });
  await new Promise(resolve=>setImmediate(resolve));
  for(const [id,value] of [['negVoltage','8.90 V'],['negVoltageMax','11.00 V'],['negInputLimit','1.20 A'],['negTarget','8500 mA']]) {
    assert.equal(ui.el(id).textContent,value);
  }
  online=false;
  await ui.el('negRefresh').emit('click');
  for(const id of ['negVoltage','negVoltageMax','negInputLimit','negTarget']) assert.equal(ui.el(id).textContent,'—');
});

test('恢复默认保存五项参数，阻止并发修改，重开页面仍显示默认值',async ()=>{
  const settings={VOTE_INITIAL:'4200',INTERVAL_MS:'90',RAISE_STEP:'180',
    LOWER_STEP:'170',CUTOFF_GAP_MV:'-60',UFCS_LIMIT_MV:'4200',PPS_VOTE_MAX:'5000'};
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const ui=openWebUi(settings,()=>pending);
  await new Promise(resolve=>setImmediate(resolve));
  const values=[['advInitial','1000'],['advInterval','100'],['advRaise','100'],
    ['advLower','500'],['advGap','-50']];
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
  assert.equal(ui.writes,5);
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
  assert.equal(ui.el('advInitialInput').value,'1000');
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
