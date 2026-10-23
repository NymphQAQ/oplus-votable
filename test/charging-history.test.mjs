import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const H=require('../webroot/charging-history.js');
const source=readFileSync(new URL('../charging-history.sh',import.meta.url),'utf8');
const boot='12345678-1234-1234-1234-123456789012';
const id='1792340000-12345678-100000';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,label) {
  for(let i=0;i<150;i++){if(fn())return;await sleep(20);}
  assert.fail('等待超时：'+label);
}
function fixture(t,{int32=false}={}) {
  const base=mkdtempSync(join(tmpdir(),'opv-history-'));
  const children=[];
  const data=join(base,'data'),sys=join(base,'power_supply'),bin=join(base,'bin'),dir=join(data,'charging-history'),votes=join(base,'votes');
  for(const d of [data,dir,bin,...['UFCS_CURR','PPS_CURR'].map(n=>join(votes,n)),...['battery','usb','wireless','ac'].map(n=>join(sys,n))])mkdirSync(d,{recursive:true});
  const put=(p,v)=>writeFileSync(p,String(v));
  for(const [n,v] of Object.entries({capacity:20,temp:350,voltage_now:4500000,current_now:-2000,model_name:'oplus battery',status:'Charging'}))put(join(sys,'battery',n),v);
  for(const s of ['usb','wireless','ac'])put(join(sys,s,'online'),0);
  put(join(base,'boot'),boot);put(join(base,'uptime'),'100.000 1');put(join(base,'epoch'),1792340000);
  put(join(bin,'date'),'#!/bin/sh\ncat "'+join(base,'epoch')+'"\n');
  put(join(bin,'sleep'),'#!/bin/sh\nprintf "%s\\n" "$1" >> "'+join(base,'sleep-args')+'"\n/bin/sleep 0.04\n');
  for(const n of ['date','sleep'])chmodSync(join(bin,n),0o755);
  const shell=join(base,'charging-history.sh');
  put(join(base,'cmdline'),'sh\0'+shell+'\0--run\0');
  let script=source.replaceAll('/data/adb/oplus-votable',data).replaceAll('/sys/class/power_supply',sys)
    .replaceAll('/proc/oplus-votable',votes)
    .replaceAll('/proc/sys/kernel/random/boot_id',join(base,'boot')).replaceAll('/proc/uptime',join(base,'uptime'))
    .replaceAll('/proc/$pid/cmdline',join(base,'cmdline'));
  // Android mksh 的 test 数字比较使用有符号 32 位整数。
  if(int32)script=`int32_test() {
    if command [ "$#" = 4 ]; then
      case "$2" in
        -eq|-ne|-lt|-le|-gt|-ge)
          set -- "$((($1 + 2147483648) % 4294967296 - 2147483648))" "$2" "$((($3 + 2147483648) % 4294967296 - 2147483648))" ']';;
      esac
    fi
    command [ "$@"
  }
`+script.replaceAll('[ ','int32_test ');
  put(shell,script);
  const env={...process.env,PATH:bin+':'+process.env.PATH};
  const cmd=(...args)=>spawnSync('sh',[shell,...args],{encoding:'utf8',env,timeout:5000});
  const list=()=>H.parseList(cmd('--list').stdout);
  const clock=ms=>{put(join(base,'uptime'),(ms/1000).toFixed(3)+' 1');put(join(base,'epoch'),1792340000+Math.floor((ms-100000)/1000));};
  const start=()=>{
    const child=spawn('sh',[shell,'--run'],{env,stdio:'ignore'});
    children.push(child);
    return child;
  };
  t.after(async()=>{
    await Promise.all(children.map(child=>new Promise(resolve=>{
      if(child.exitCode!==null||child.signalCode!==null)return resolve();
      child.once('exit',resolve);child.kill('SIGTERM');
    })));
    rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:20});
  });
  return {base,data,sys,dir,votes,put,shell,cmd,list,clock,start};
}

test('仅记录同次开机、存活进程且节点匹配的 UFCS/PPS 强制投票，撤销和旧数据留空',async t=>{
  const f=fixture(t),lease=join(f.data,'active-test.lease');
  const setVote=(proto,target,active=1)=>{
    f.put(lease,[boot,100,process.pid,target,proto].join(' '));
    const node=join(f.votes,proto==='ufcs'?'UFCS_CURR':'PPS_CURR');
    f.put(join(node,'force_active'),active);f.put(join(node,'force_val'),target);
  };
  setVote('ufcs',9000);f.put(join(f.sys,'usb/online'),1);f.start();
  await waitFor(()=>f.list().sessions.length===1,'开始采样');const key=f.list().active;
  const read=()=>H.parseRecords(f.cmd('--read',key).stdout,key);
  assert.equal(read().rows[0].vote,9000);
  let tick=100000;
  const next=async expected=>{
    tick+=200;f.clock(tick);
    await waitFor(()=>read().rows.at(-1).elapsed===tick-100000,'投票采样推进');
    assert.equal(read().rows.at(-1).vote,expected);
  };
  setVote('ufcs',9000,0);await next(null);
  setVote('ufcs',8000);f.put(join(f.votes,'UFCS_CURR/force_val'),7000);await next(null);
  setVote('pps',5000);await next(5000);
  setVote('ufcs',0);await next(0);
  f.put(lease,['abcdefab',100,process.pid,0,'ufcs'].join(' '));await next(null);
  setVote('ufcs',9000);f.put(lease,[boot,100,999999999,9000,'ufcs'].join(' '));await next(null);
  setVote('ufcs',9000);f.put(lease,[boot,100,process.pid,9000,'../../bad'].join(' '));await next(null);
  assert.equal(read().maxima.vote,9000);
  assert.equal(readFileSync(join(f.votes,'UFCS_CURR/force_val'),'utf8'),'9000','采样只读投票节点');
});

test('连接创建记录，满电和间断阶段不拆分，拔线结束，再连接保存新记录',async t=>{
  const f=fixture(t);f.start();
  await waitFor(()=>f.list().running,'后台启动');assert.equal(f.list().active,'NONE');
  f.put(join(f.sys,'usb/online'),1);
  await waitFor(()=>f.list().sessions.length===1,'开始记录');
  let state=f.list();const first=state.active;
  const data=H.parseRecords(f.cmd('--read',first).stdout,first);
  assert.equal(data.rows[0].soc,20);assert.equal(data.rows[0].temp,35);
  assert.equal(data.rows[0].voltage,4.5);assert.equal(data.rows[0].power,9,'OPLUS mA 先换算为 µA');
  f.put(join(f.sys,'battery/status'),'Not charging');f.clock(102000);
  await sleep(160);assert.equal(f.list().active,first,'连接时暂停充电仍为同一次记录');
  f.put(join(f.sys,'battery/status'),'Full');f.put(join(f.sys,'battery/capacity'),100);f.clock(104000);await sleep(150);
  assert.equal(f.list().sessions.length,1);
  f.put(join(f.sys,'usb/online'),0);f.clock(106000);
  await waitFor(()=>f.list().active==='NONE','拔线结束');
  state=f.list();assert.equal(state.sessions[0].state,'UNPLUGGED');assert.equal(state.sessions[0].duration,6000);
  assert.equal(state.sessions[0].lastSoc,100);
  f.clock(108000);f.put(join(f.sys,'wireless/online'),1);
  await waitFor(()=>f.list().sessions.length===2,'无线充电创建新记录');
  assert.notEqual(f.list().active,first);
  assert.ok(existsSync(join(f.dir,first+'.csv')),'旧记录保留');
});

test('标准 µA、未知传感器、时钟倒退与采样中断正确处理，不写任何电池节点',async t=>{
  const f=fixture(t);
  f.put(join(f.sys,'battery/model_name'),'standard');f.put(join(f.sys,'battery/current_now'),-2000000);
  f.put(join(f.sys,'usb/online'),1);f.start();
  await waitFor(()=>f.list().sessions.length===1,'记录创建');const first=f.list().active;
  assert.equal(H.parseRecords(f.cmd('--read',first).stdout,first).rows[0].power,9);
  f.put(join(f.sys,'battery/temp'),'invalid');f.put(join(f.sys,'battery/current_now'),'invalid');f.clock(102000);
  await waitFor(()=>H.parseRecords(f.cmd('--read',first).stdout,first).rows.at(-1).temp===null,'无效温度留空');
  assert.equal(H.parseRecords(f.cmd('--read',first).stdout,first).rows.at(-1).power,null);
  f.clock(101000);await waitFor(()=>f.list().sessions.length===2,'单调时钟倒退拆分');
  f.clock(120000);await waitFor(()=>f.list().sessions.length===3,'采样中断拆分');
  assert.equal(f.list().sessions.filter(s=>s.state==='INTERRUPTED').length,2);
  assert.equal(readFileSync(join(f.sys,'battery/current_now'),'utf8'),'invalid');
  assert.equal(readFileSync(join(f.sys,'usb/online'),'utf8'),'1');
  assert.doesNotMatch(source,/\b(?:chmod|printf|echo)\b[^\n]*>\s*[^\n]*(?:\$B|\/sys\/|\/proc\/oplus)/);
});

test('独立记录器以 0.2 秒为目标间隔，保存真实毫秒和一次归一化后的节点值',async t=>{
  const f=fixture(t);f.put(join(f.sys,'usb/online'),1);
  f.put(join(f.sys,'battery/capacity'),'020');f.put(join(f.sys,'battery/temp'),'-005');
  f.put(join(f.sys,'battery/voltage_now'),'04500000');f.put(join(f.sys,'battery/current_now'),'-02000');
  f.start();await waitFor(()=>f.list().sessions.length===1,'记录创建');const key=f.list().active;
  f.clock(100200);
  await waitFor(()=>H.parseRecords(f.cmd('--read',key).stdout,key).rows.at(-1).elapsed===200,'毫秒时间');
  const p=H.parseRecords(f.cmd('--read',key).stdout,key).rows.at(-1);
  assert.equal(p.soc,20);assert.equal(p.temp,-0.5);assert.equal(p.voltage,4.5);assert.equal(p.power,9);
  await sleep(100);
  const data=H.parseRecords(f.cmd('--read',key).stdout,key);
  assert.equal(new Set(data.rows.map(p=>p.elapsed)).size,data.rows.length,'单调时钟未前进时不写重复时间点');
  assert.ok(readFileSync(join(f.base,'sleep-args'),'utf8').trim().split('\n').every(v=>v==='0.2'));
  assert.doesNotMatch(source,/sleep 2\b/);
});

test('单实例、同次启动短暂停止后续记，重启后保留旧数据并新建记录',async t=>{
  const f=fixture(t);f.put(join(f.sys,'usb/online'),1);f.start();
  await waitFor(()=>f.list().sessions.length===1,'首次记录');const first=f.list().active;
  assert.equal(f.cmd('--run').status,0,'重复实例立即退出');
  assert.equal(f.cmd('--stop').status,0);await waitFor(()=>!f.list().running,'停止记录器');
  assert.equal(f.list().sessions[0].state,'INTERRUPTED');
  f.clock(102000);f.start();await waitFor(()=>f.list().running && f.list().active===first,'同启动短中断续记');
  assert.equal(f.list().sessions.length,1);
  f.cmd('--stop');await waitFor(()=>!f.list().running,'停止');
  f.put(join(f.base,'boot'),'abcdefab-1234-1234-1234-123456789012');f.clock(2000);f.start();
  await waitFor(()=>f.list().sessions.length===2,'重启另建记录');
  assert.ok(existsSync(join(f.dir,first+'.csv')));
});

test('历史翻页、长记录抽样保留首尾、路径和链接校验、单行传输',t=>{
  const f=fixture(t);
  for(let i=0;i<23;i++) {
    const key=(1792340000+i)+'-12345678-100000';
    f.put(join(f.dir,key+'.meta'),key+','+(1792340000+i)+','+(1792340001+i)+',1000,20,21,1,UNPLUGGED\n');
  }
  assert.equal(f.list().sessions.length,20);assert.equal(f.list().more,true);
  const older=H.parseList(f.cmd('--list','20').stdout);assert.equal(older.sessions.length,3);assert.equal(older.more,false);
  const csv=Array.from({length:10000},(_,i)=>[1792340000+i,i*2000,20,350,4500000,-2000000].join(',')).join('\n')+'\n';
  f.put(join(f.dir,id+'.csv'),csv);
  const result=f.cmd('--read',id);assert.equal(result.status,0);assert.equal(result.stdout.trim().split('\n').length,1);
  const parsed=H.parseRecords(result.stdout,id);assert.equal(parsed.total,10000);assert.ok(parsed.rows.length<=1201);
  assert.equal(parsed.rows[0].elapsed,0);assert.equal(parsed.rows.at(-1).elapsed,19998000);
  assert.equal(readFileSync(join(f.dir,id+'.csv'),'utf8'),csv,'抽样不改写原始数据');
  for(const args of [['--read','../events.log'],['--read',id+';id'],['--read','1792340000-12345678'],['--list','-1'],['--list','1;id'],['--read',id,'extra'],
    ['--read',id,'0'],['--read',id,'-1','2'],['--read',id,'3','2'],['--read',id,'0','2;id'],['--read',id,'0','1000000000000000']])assert.equal(f.cmd(...args).status,2);
  rmSync(join(f.dir,id+'.csv'));symlinkSync(join(f.base,'epoch'),join(f.dir,id+'.csv'));
  assert.equal(f.cmd('--read',id).status,3);
});

test('空、零字节和损坏摘要不阻断有效记录，也不占翻页名额或改写原始文件',t=>{
  const f=fixture(t), good=[];
  for(let i=0;i<23;i++) {
    const key=(1792340000+i)+'-12345678-100000';good.push(key);
    f.put(join(f.dir,key+'.meta'),key+','+(1792340000+i)+','+(1792340001+i)+',1000,20,21,1,UNPLUGGED\n');
  }
  const bad=[()=>'',()=>Buffer.alloc(76),key=>key+',1792340000',
    key=>key+',1792340000,1792340001,1000,20,21,1,BROKEN\n',
    key=>key+',1792340000,1792340001,no,20,21,1,UNPLUGGED\n',
    key=>key+',1792340000,1792340001,1000,4294967296,21,1,UNPLUGGED\n',
    key=>key+',1792340000,1792340001,1000,20,21,0,UNPLUGGED\n',
    key=>id+',1792340000,1792340001,1000,20,21,1,UNPLUGGED\n'];
  const originals=bad.map((make,i)=>{
    const key=(1792340100+i)+'-12345678-100000',path=join(f.dir,key+'.meta');
    f.put(path,make(key));return [path,readFileSync(path)];
  });
  const first=f.list();assert.equal(first.sessions.length,20);assert.equal(first.more,true);assert.equal(first.skipped,bad.length);
  assert.deepEqual(first.sessions.map(s=>s.id),good.toReversed().slice(0,20));
  const second=H.parseList(f.cmd('--list','20').stdout);
  assert.equal(second.more,false);assert.equal(second.skipped,bad.length);assert.deepEqual(second.sessions.map(s=>s.id),good.toReversed().slice(20));
  for(const [path,bytes] of originals)assert.deepEqual(readFileSync(path),bytes,'损坏摘要仍原样保留');
});

test('真实时间桶保留五项极值和低谷，窗口取完整原始点，全程峰值独立于窗口',t=>{
  const f=fixture(t);
  const rows=Array.from({length:10000},(_,i)=>[1792340000+Math.floor(i/5),i*200+(i>=5000?60000:0),20,350,4500000,-2000000,5000]);
  const changes=[[1101,2,0],[1102,2,100],[1103,3,-500],[1104,3,1500],[1105,4,1000000],[1106,4,20000000],[1107,5,0],[1108,5,-100000000],[1109,6,0],[1110,6,13500],[1111,6,'']];
  for(const [i,col,value] of changes)rows[i][col]=value;
  const csv=rows.map(r=>r.join(',')).join('\n')+'\n';f.put(join(f.dir,id+'.csv'),csv);
  const payload=f.cmd('--read',id).stdout,all=H.parseRecords(payload,id);
  assert.equal(all.total,10000);assert.ok(all.rows.length<=1201);
  assert.deepEqual(all.maxima,{soc:100,temp:150,voltage:20,power:450,vote:13500});
  for(const [i] of changes)assert.ok(all.rows.some(p=>p.elapsed===rows[i][1]),'保留极值所在时刻 '+i);
  assert.deepEqual(all.rows.map(p=>p.elapsed),all.rows.map(p=>p.elapsed).toSorted((a,b)=>a-b));
  assert.equal(new Set(all.rows.map(p=>p.elapsed)).size,all.rows.length,'多项共用极值不重复');
  const near=H.parseRecords(f.cmd('--read',id,'220000','222000').stdout,id);
  assert.equal(near.total,10000);assert.equal(near.rows.length,11,'小窗口返回全部原始点');
  assert.equal(near.rows[0].elapsed,220000);assert.equal(near.rows.at(-1).elapsed,222000);
  const large=H.parseRecords(f.cmd('--read',id,'200000','1800000').stdout,id);
  assert.ok(large.rows.length<=1201);assert.ok(large.rows.every(p=>p.elapsed>=200000 && p.elapsed<=1800000));
  for(const [i] of changes)assert.ok(large.rows.some(p=>p.elapsed===rows[i][1]));
  const none=H.parseRecords(f.cmd('--read',id,'2100000','2200000').stdout,id);assert.equal(none.rows.length,0);assert.equal(none.total,10000);
  assert.deepEqual(none.maxima,all.maxima,'窗口外的峰值也完整保留');
  assert.deepEqual(H.parseRecords(f.cmd('--read',id,'0','200').stdout,id).maxima,all.maxima);
  f.put(join(f.dir,id+'.meta'),id+',1792340000,1792342000,'+rows.at(-1)[1]+',20,20,10000,UNPLUGGED\n');
  assert.equal(f.cmd('--read',id).stdout,payload,'匹配提交行数的元数据走单次扫描，结果一致');
  f.put(join(f.dir,id+'.meta'),id+',1792340000,1792340000,0,20,20,9999,ACTIVE\n');
  assert.equal(f.cmd('--read',id).stdout,payload,'元数据尚未提交时回退，不使用过期时间范围');
  assert.equal(readFileSync(join(f.dir,id+'.csv'),'utf8'),csv,'全程与窗口读取均不更改原始 CSV');
});

test('Android 32 位数字比较下，全程与大时间窗口均能读取且拒绝逆序范围',t=>{
  const f=fixture(t,{int32:true});
  const csv='1792340000,0,20,350,4500000,-2000000\n1792340001,1000,21,350,4500000,-2000000\n';
  f.put(join(f.dir,id+'.csv'),csv);
  f.put(join(f.dir,id+'.meta'),id+',1792340000,1792340001,1000,20,21,2,UNPLUGGED\n');
  for(const args of [[],['0','999999999999999'],['2147483648','999999999999999']]) {
    const result=f.cmd('--read',id,...args);
    assert.equal(result.status,0,result.stderr+' '+args.join(' '));
    assert.equal(H.parseRecords(result.stdout,id).rows.length,args[0]==='2147483648'?0:2);
  }
  assert.equal(f.cmd('--read',id,'2147483648','2147483647').status,2);
  assert.equal(readFileSync(join(f.dir,id+'.csv'),'utf8'),csv);
});

test('读取忽略未完成的末行，完成后可读取；崩溃留下半行时另建记录并保留原文件',async t=>{
  const f=fixture(t);const path=join(f.dir,id+'.csv');
  const committed='1792340000,0,20,350,4500000,-2000000\n1792340000,200,20,350,4500000,-2000000\n';
  f.put(path,committed+'1792340000,400,20');
  let data=H.parseRecords(f.cmd('--read',id).stdout,id);assert.equal(data.total,2);assert.equal(data.rows.length,2);
  f.put(path,committed+'1792340000,400,20,350,4500000,-2000000\n');
  data=H.parseRecords(f.cmd('--read',id).stdout,id);assert.equal(data.total,3);assert.equal(data.rows.at(-1).elapsed,400);
  f.put(join(f.sys,'usb/online'),1);f.clock(101000);f.start();
  await waitFor(()=>f.list().sessions.length===1,'创建活动记录');const key=f.list().active;
  f.cmd('--stop');await waitFor(()=>!f.list().running,'停止记录器');
  const activePath=join(f.dir,key+'.csv'),partial=readFileSync(activePath,'utf8')+'1792340001,50';f.put(activePath,partial);
  f.clock(102000);f.start();await waitFor(()=>f.list().sessions.length===2,'半行后新建会话');
  assert.notEqual(f.list().active,key);assert.equal(readFileSync(activePath,'utf8'),partial,'崩溃半行也不截断删除');
  assert.equal(f.list().sessions.find(s=>s.id===key).state,'INTERRUPTED');
});

test('长会话重启记录器从最后已提交行续记，目录和锁链接不会被跟随',async t=>{
  const f=fixture(t);f.put(join(f.sys,'usb/online'),1);f.start();
  await waitFor(()=>f.list().sessions.length===1,'首次采样');const key=f.list().active;
  for(const ms of [108000,116000]) {
    f.clock(ms);await waitFor(()=>H.parseRecords(f.cmd('--read',key).stdout,key).rows.at(-1).elapsed===ms-100000,'长会话推进');
  }
  f.cmd('--stop');await waitFor(()=>!f.list().running,'停止');f.clock(118000);f.start();
  await waitFor(()=>f.list().running && H.parseRecords(f.cmd('--read',key).stdout,key).rows.at(-1).elapsed===18000,'从末行续记');
  assert.equal(f.list().sessions.length,1);
  f.cmd('--stop');await waitFor(()=>!f.list().running,'再次停止');
  symlinkSync(join(f.base,'epoch'),join(f.dir,'.lock'));assert.equal(f.cmd('--run').status,4);rmSync(join(f.dir,'.lock'));
  const moved=join(f.base,'elsewhere');mkdirSync(moved);rmSync(f.dir,{recursive:true});symlinkSync(moved,f.dir);
  assert.equal(f.cmd('--read',key).status,2);assert.equal(f.cmd('--run').status,2);
});

test('曲线兼容单点、缺失值和相同数值，拒绝伪造编号、越界和逆序数据',()=>{
  const pack=(csv,key=id)=>'HISTORY_ID='+key+';HISTORY_TOTAL=2;HISTORY_DATA_B64='+Buffer.from(csv).toString('base64');
  const rows=H.parseRecords(pack('1792340000,0,20,350,4500000,-2000000\n1792340002,2000,,350,,\n'),id).rows;
  for(const key of ['soc','temp','voltage','power']) {
    const c=H.chart(rows,key);assert.ok(Number.isFinite(c.min));assert.ok(c.max>c.min);
    for(const point of c.points.filter(Boolean))assert.ok(Number.isFinite(point.elapsed) && Number.isFinite(point.value));
    assert.equal(H.chart([rows[0]],key).points.length,1);
  }
  for(const csv of ['1792340000,0,101,350,4500000,1\n','1792340000,2,20,350,4500000,1\n1792340002,1,20,350,4500000,1\n','<script>'])assert.throws(()=>H.parseRecords(pack(csv),id));
  assert.throws(()=>H.parseRecords(pack('1792340000,0,20,350,4500000,1\n','bad'),id));
  assert.throws(()=>H.parseList('HISTORY_RUNNING=YES;HISTORY_ACTIVE=../x;HISTORY_MORE=NO;HISTORY_ERROR=NONE;HISTORY_SESSIONS=NONE'));
});
