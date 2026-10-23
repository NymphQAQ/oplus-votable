import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const H=createRequire(import.meta.url)('../webroot/charging-history.js');

test('各曲线使用自身单位和刻度，保留真实时间并为峰值留出空间',()=>{
  const rows=[0,200,5000,10000].map((elapsed,i)=>({elapsed,soc:20+i,temp:35+i,voltage:4.5,power:20+i}));
  assert.equal(H.nearestIndex(rows,2500),1);
  assert.equal(H.nearestIndex(rows,4999),2);
  for(const [key,min,max] of [['soc',0,100],['temp',30,50],['voltage',3,5],['power',0,30]]) {
    const chart=H.chart(rows,key);
    assert.equal(chart.min,min);assert.equal(chart.max,max);
    assert.deepEqual(chart.points.map(p=>p.elapsed),[0,200,5000,10000]);
  }
  assert.equal(H.powerLimit([],false),30);
  assert.equal(H.powerLimit([{power:25}],false),30);
  assert.equal(H.powerLimit([{power:30}],false),40);
  assert.equal(H.powerLimit([{power:25}],true),60);
  assert.ok(H.chart([{temp:-5},{temp:65}],'temp').min<-5);
  assert.ok(H.chart([{temp:-5},{temp:65}],'temp').max>65);
  assert.ok(H.chart([{voltage:8.5}],'voltage').max>8.5,'整包电压不被 5V 刻度裁掉');
});

test('时间分桶保留尖峰、低谷、首尾与缺失值断线，不取平均',()=>{
  const rows=Array.from({length:1201},(_,i)=>({elapsed:i*200,power:10}));
  rows[201].power=99;rows[202].power=0;rows[600].power=null;
  const result=H.chart(rows,'power',{width:10});
  assert.equal(result.points[0].elapsed,0);assert.equal(result.points.at(-1).elapsed,240000);
  assert.ok(result.points.some(p=>p?.value===99));assert.ok(result.points.some(p=>p?.value===0));
  assert.ok(result.points.includes(null));assert.ok(result.points.length<20);
  const window=H.chart(rows,'power',{from:40000,to:41000,width:500});
  assert.deepEqual(window.points.map(p=>p.elapsed),[40000,40200,40400,40600,40800,41000]);
  assert.ok(window.points.some(p=>p.value===99));
});

test('双电芯只变换显示功率，电压与原始数据不变',()=>{
  const rows=[{elapsed:0,power:9,voltage:4.5},{elapsed:200,power:null,voltage:null}];
  const original=JSON.stringify(rows);
  assert.equal(H.displayValue(rows[0],'power',true),18);
  assert.equal(H.displayValue(rows[0],'voltage',true),4.5);
  assert.equal(H.displayValue(rows[1],'power',true),null);
  assert.equal(H.chart(rows,'power',{dualCell:true}).points[0].value,18);
  assert.equal(H.chart(rows,'voltage',{dualCell:true}).points[0].value,4.5);
  assert.equal(JSON.stringify(rows),original);
});

test('投票曲线按 mA 独立缩放，兼容旧六列、混合记录和峰值摘要，拒绝越界',()=>{
  const id='1792340000-12345678-100000';
  const pack=csv=>'HISTORY_ID='+id+';HISTORY_TOTAL=3;HISTORY_DATA_B64='+Buffer.from(csv).toString('base64');
  const old='1792340000,0,20,350,4500000,-2000000\n';
  const data=H.parseRecords(pack('MAX,25,420,4600000,18000000000000,13500\n'+old+
    '1792340001,1000,21,360,4510000,-3000000,9000\n1792340002,2000,22,370,4520000,-4000000,\n'),id);
  assert.deepEqual(data.rows.map(p=>p.vote),[null,9000,null]);
  assert.deepEqual(data.maxima,{soc:25,temp:42,voltage:4.6,power:18,vote:13500});
  assert.equal(H.parseRecords(pack(old),id).maxima,null,'兼容旧响应但不猜测整次峰值');
  const chart=H.chart(data.rows,'vote',{voteMax:data.maxima.vote,dualCell:true});
  assert.equal(chart.min,0);assert.ok(chart.max>13500);assert.deepEqual(chart.points,[null,{elapsed:1000,value:9000},null]);
  assert.equal(H.displayValue(data.rows[1],'vote',true),9000);
  for(const csv of ['MAX,20,350,4500000,9000000000000,20001\n'+old,
    old.trim()+',-1\n',old.trim()+',20001\n','MAX,20,350\n'+old]) assert.throws(()=>H.parseRecords(pack(csv),id));
});
