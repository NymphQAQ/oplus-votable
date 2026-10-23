(function (root) {
  'use strict';
  const L = typeof module === 'object' && module.exports ? require('./log-utils.js') : root.OplusVotableLog;
  const validId = value => /^\d{9,12}-[a-f0-9]{8}-\d{1,15}$/.test(value);
  const numeric = (raw, min, max, optional = false) => {
    if (optional && raw === '') return null;
    if (!/^-?\d{1,15}$/.test(raw)) throw new Error('记录数值格式无效');
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('记录数值超出范围');
    return n;
  };
  function parseList(raw) {
    const d = L.parseStatus(raw);
    if (!['YES','NO'].includes(d.HISTORY_RUNNING) || !['YES','NO'].includes(d.HISTORY_MORE) ||
        !['NONE','STORAGE_ERROR'].includes(d.HISTORY_ERROR) ||
        !(d.HISTORY_ACTIVE === 'NONE' || validId(d.HISTORY_ACTIVE))) throw new Error('充电记录响应无效');
    const sessions = d.HISTORY_SESSIONS === 'NONE' ? [] : String(d.HISTORY_SESSIONS || '').split(':').map(line => {
      const a = line.split(',');
      if (a.length !== 8 || !validId(a[0]) || !['ACTIVE','UNPLUGGED','INTERRUPTED'].includes(a[7])) throw new Error('充电记录列表无效');
      return {id:a[0], start:numeric(a[1],1,999999999999), end:numeric(a[2],1,999999999999),
        duration:numeric(a[3],0,Number.MAX_SAFE_INTEGER), firstSoc:numeric(a[4],0,100,true),
        lastSoc:numeric(a[5],0,100,true), count:numeric(a[6],1,Number.MAX_SAFE_INTEGER), state:a[7]};
    });
    if (sessions.length > 20 || new Set(sessions.map(s => s.id)).size !== sessions.length) throw new Error('充电记录列表重复或过长');
    return {running:d.HISTORY_RUNNING === 'YES', active:d.HISTORY_ACTIVE, more:d.HISTORY_MORE === 'YES', error:d.HISTORY_ERROR,
      skipped:numeric(d.HISTORY_SKIPPED ?? '0',0,Number.MAX_SAFE_INTEGER), sessions};
  }
  function parseRecords(raw, id) {
    const d = L.parseStatus(raw);
    if (!validId(id) || d.HISTORY_ID !== id || !/^[A-Za-z0-9+/]*={0,2}$/.test(d.HISTORY_DATA_B64 || '') ||
        d.HISTORY_DATA_B64.length > 250000) throw new Error('充电记录数据无效');
    const total = numeric(d.HISTORY_TOTAL,0,Number.MAX_SAFE_INTEGER);
    const text = atob(d.HISTORY_DATA_B64);
    const lines = text.trim() ? text.trim().split('\n') : [];
    let maxima = null;
    if (lines[0]?.startsWith('MAX,')) {
      const a=lines.shift().split(',');
      if (a.length !== 6) throw new Error('充电峰值格式无效');
      const temp=numeric(a[2],-500,1500,true), voltage=numeric(a[3],1000000,20000000,true), power=numeric(a[4],0,2000000000000000,true);
      maxima={soc:numeric(a[1],0,100,true), temp:temp === null ? null : temp/10,
        voltage:voltage === null ? null : voltage/1e6, power:power === null ? null : power/1e12, vote:numeric(a[5],0,20000,true)};
    }
    const rows = lines.map(line => {
      const a = line.split(',');
      if (a.length !== 6 && a.length !== 7) throw new Error('充电采样格式无效');
      const voltage = numeric(a[4],1000000,20000000,true);
      const current = numeric(a[5],-100000000,100000000,true);
      return {time:numeric(a[0],1,999999999999), elapsed:numeric(a[1],0,Number.MAX_SAFE_INTEGER),
        soc:numeric(a[2],0,100,true), temp:numeric(a[3],-500,1500,true),
        voltage:voltage === null ? null : voltage / 1e6,
        power:voltage === null || current === null ? null : Math.abs(voltage * current) / 1e12,
        vote:a.length === 6 ? null : numeric(a[6],0,20000,true)};
    });
    if (rows.length > 1201 || rows.length > total || rows.some((p,i) => i && p.elapsed < rows[i-1].elapsed)) throw new Error('充电采样顺序或数量无效');
    for (const p of rows) if (p.temp !== null) p.temp /= 10;
    return {total, rows, maxima};
  }
  const metrics = [
    {key:'soc', name:'电量', unit:'%', digits:0, color:'#16803c'},
    {key:'temp', name:'电池温度', unit:'°C', digits:1, color:'#d32f2f'},
    {key:'voltage', name:'电池电压', unit:'V', digits:3, color:'#d4aa00', ink:'#806600'},
    {key:'power', name:'功率（电池端）', unit:'W', digits:2, color:'#1677e8'},
    {key:'vote', name:'模块投票值', unit:'mA', digits:0, color:'#161616'},
  ];
  const dualCellKey = 'oplus-votable.history.dual-cell';
  const valueText = (value, metric) => value === null || value === undefined ? '—' : value.toFixed(metric.digits) + ' ' + metric.unit;
  const timeText = seconds => new Date(seconds * 1000).toLocaleString('zh-CN',{hour12:false});
  const durationText = ms => {
    const seconds = Math.floor(ms / 1000);
    return Math.floor(seconds / 3600) + ':' + String(Math.floor(seconds / 60) % 60).padStart(2,'0') + ':' + String(seconds % 60).padStart(2,'0');
  };
  const displayValue = (row, key, dualCell) => row?.[key] == null ? null : row[key] * (key === 'power' && dualCell ? 2 : 1);
  const powerLimit = (rows, dualCell) => {
    const peak=Math.max(0,...rows.map(p=>displayValue(p,'power',dualCell) || 0));
    const step=peak<=50 ? 5 : peak<=100 ? 10 : 20;
    return Math.max(30,Math.ceil(peak*1.2/step)*step);
  };
  function nearestIndex(rows, elapsed) {
    let lo=0, hi=rows.length-1;
    while (lo<hi) { const mid=Math.floor((lo+hi)/2); if (rows[mid].elapsed < elapsed) lo=mid+1; else hi=mid; }
    return lo && Math.abs(rows[lo-1].elapsed-elapsed) <= Math.abs(rows[lo].elapsed-elapsed) ? lo-1 : lo;
  }
  function chart(rows, key, {from=0,to=rows.at(-1)?.elapsed || 0,width=600,dualCell=false,powerMax=powerLimit(rows,dualCell),voteMax=0}={}) {
    let min=0, max=key === 'soc' ? 100 : powerMax;
    if (key === 'vote') max=Math.max(5000,Math.ceil(Math.max(voteMax,...rows.map(p=>p.vote || 0))*1.1/1000)*1000);
    if (key === 'temp' || key === 'voltage') {
      const values=rows.map(p=>p[key]).filter(value=>value != null);
      if (key === 'temp') {
        min=Math.min(30,Math.floor((Math.min(35,...values)-2)/5)*5);
        max=Math.max(50,Math.ceil((Math.max(45,...values)+2)/5)*5);
      } else {
        min=Math.min(3,Math.floor((Math.min(4,...values)-.1)*2)/2);
        max=Math.max(5,Math.ceil((Math.max(4,...values)+.1)*2)/2);
      }
    }
    const visible=rows.filter(p=>p.elapsed >= from && p.elapsed <= to);
    const buckets=Math.max(1,Math.floor(width/2.5)), points=[];
    if (visible.length <= buckets*2) {
      for (const p of visible) points.push(displayValue(p,key,dualCell) === null ? null : {elapsed:p.elapsed,value:displayValue(p,key,dualCell)});
    } else {
      const first=visible[0], last=visible.at(-1);
      if (displayValue(first,key,dualCell) !== null) points.push({elapsed:first.elapsed,value:displayValue(first,key,dualCell)});
      let bucket=-1, low, high;
      const flush=()=>{
        if (!low) return;
        for (const p of low.elapsed <= high.elapsed ? [low,high] : [high,low]) {
          if (points.at(-1)?.elapsed !== p.elapsed || points.at(-1)?.value !== p.value) points.push(p);
        }
        low=high=null;
      };
      for (const row of visible) {
        const value=displayValue(row,key,dualCell);
        if (value === null) { flush(); if (points.at(-1) !== null) points.push(null); bucket=-1; continue; }
        const next=Math.min(buckets-1,Math.floor((row.elapsed-from)/Math.max(1,to-from)*buckets));
        if (next !== bucket) { flush(); bucket=next; }
        const point={elapsed:row.elapsed,value};
        if (!low || value < low.value) low=point;
        if (!high || value > high.value) high=point;
      }
      flush();
      const lastValue=displayValue(last,key,dualCell);
      if (lastValue !== null && (points.at(-1)?.elapsed !== last.elapsed || points.at(-1)?.value !== lastValue)) points.push({elapsed:last.elapsed,value:lastValue});
    }
    return {min,max,from,to,points};
  }
  function createUI(exec, doc = document) {
    const el = id => doc.getElementById(id), view=doc.defaultView || root;
    const command = 'sh /data/adb/modules/oplus-votable/charging-history.sh';
    const canvas=el('historyCanvas'), context=canvas.getContext?.('2d');
    const pointers=new Map();
    let pinch=null, pinchUsed=false;
    let axisKey='power';
    let offset=0, live=true, selected='', rows=[], cursorTime=null, busy=false, again=false, revision=0;
    let lastPayload='', lastVersion='', optionsSignature='', duration=0, rangeStart=0, rangeEnd=1000, dragging=false, allPower=0, nextAutomaticAt=0;
    let session=null, maxima=null;
    let dualCell=false;
    try { dualCell=view.localStorage?.getItem(dualCellKey) === 'YES'; } catch (_) {}
    el('historyDualCell').checked=dualCell;
    function windowRange() { return [Math.floor(duration*rangeStart/1000),Math.ceil(duration*rangeEnd/1000)]; }
    function chartWindow() {
      const [from,to]=windowRange();
      return [from,rangeStart===0 && rangeEnd===1000 ? Math.max(300000,Math.ceil(to/300000)*300000) : Math.max(from+1,to)];
    }
    function visibleRows() { const [from,to]=windowRange(); return rows.filter(p=>p.elapsed >= from && p.elapsed <= to); }
    function selectedPoint(points=visibleRows()) { return points.length ? points[cursorTime === null ? points.length-1 : nearestIndex(points,cursorTime)] : null; }
    function paintPoint() {
      const p=selectedPoint();
      for (const m of metrics) {
        const text=valueText(displayValue(p,m.key,dualCell),m), peak=valueText(displayValue(maxima,m.key,dualCell),m);
        if (m.key === 'soc') el('historyValue-soc').textContent=text.replace(' ','');
        el('historyChartValue-'+m.key).textContent=text;
        el('historyMax-'+m.key).textContent=peak;
        el('historyAxis-'+m.key).setAttribute('aria-pressed',String(m.key===axisKey));
        el('historyAxis-'+m.key).setAttribute('aria-label',m.name+'纵轴，最高'+peak+'，当前'+text);
      }
      const axis=metrics.find(m=>m.key===axisKey);
      el('historyAxisLabel').textContent='纵轴：'+axis.name+' / '+axis.unit;
      canvas.setAttribute('aria-label','功率、电量、温度、电压和投票值合并曲线，纵轴为'+axis.name+'（'+axis.unit+'），'+
        (p ? timeText(p.time)+'，'+metrics.map(m=>m.name+valueText(displayValue(p,m.key,dualCell),m)).join('，') : '等待采样'));
      el('historySocArc').setAttribute('stroke-dasharray',(p?.soc ?? 0)+' 100');
      el('historyValue-duration').textContent=p ? durationText(p.elapsed).replace(/^0:/,'') : '—';
      el('historyPoint').textContent=p ? timeText(p.time)+' · 已记录 '+durationText(p.elapsed)+'.'+String(p.elapsed%1000).padStart(3,'0') : '当前范围暂无采样';
      el('historyChargeState').textContent=session ? ({ACTIVE:'正在记录',UNPLUGGED:'充电已结束',INTERRUPTED:'记录已中断'})[session.state] : '未充电';
      if (session) {
        const date=new Date(session.start*1000), endDate=new Date(session.end*1000);
        const day=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
        const clock=d=>String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
        el('historySessionTime').textContent=day(date)+' '+clock(date)+' ~ '+(day(date) === day(endDate) ? '' : day(endDate)+' ')+clock(endDate);
        el('historyDuration').textContent=durationText(session.duration);
        const gain=session.firstSoc === null || session.lastSoc === null ? null : session.lastSoc-session.firstSoc;
        el('historySocGain').textContent=gain === null ? '—' : (gain>=0 ? '+' : '')+gain+'%';
      } else {
        el('historySessionTime').textContent=live ? '等待连接充电器' : '选择一次充电记录';
        el('historyDuration').textContent=el('historySocGain').textContent='—';
      }
    }
    function paintCanvas() {
      if (!context || !canvas.clientWidth) return;
      const dpr=view.devicePixelRatio || 1, W=canvas.clientWidth, H=canvas.clientHeight || 300;
      if (canvas.width !== Math.round(W*dpr) || canvas.height !== Math.round(H*dpr)) { canvas.width=Math.round(W*dpr); canvas.height=Math.round(H*dpr); }
      const c=context, pl=66, pr=10, pt=12, pb=28, pw=Math.max(1,W-pl-pr), ph=H-pt-pb;
      const [from,to]=chartWindow(), span=Math.max(1,to-from), p=selectedPoint();
      const pmax=powerLimit([{power:allPower}],dualCell);
      const series=metrics.map(m=>({...m,...chart(rows,m.key,{from,to,width:pw,dualCell,powerMax:pmax,voteMax:maxima?.vote || 0})}));
      const axis=series.find(m=>m.key===axisKey), key=axisKey;
      const step=key==='soc' ? 20 : key==='temp' ? 5 : key==='voltage' ? .5 : key==='vote' ? 1000 : pmax<=40 ? 5 : pmax<=100 ? 10 : 20;
      const steps=Math.round((axis.max-axis.min)/step);
      const Y=(value,m)=>pt+(1-(value-m.min)/(m.max-m.min))*ph;
      c.setTransform(dpr,0,0,dpr,0,0); c.clearRect(0,0,W,H);
      c.setLineDash([]); c.strokeStyle='#ededed'; c.lineWidth=1; c.beginPath();
      c.font='11px sans-serif'; c.fillStyle='#969696'; c.textAlign='right'; c.textBaseline='middle';
      const labelStep=Math.max(1,Math.ceil(steps/8));
      for (let i=0;i<=steps;i++) {
        const value=axis.max-i*step, y=Y(value,axis); c.moveTo(pl,y); c.lineTo(W-pr,y);
        if (i%labelStep===0 || i===steps) { c.fillStyle=axis.ink || axis.color; c.fillText((key==='voltage' ? value.toFixed(1) : value)+axis.unit,pl-5,y); }
      }
      for (let i=0;i<=5;i++) { const x=pl+pw*i/5; c.moveTo(x,pt); c.lineTo(x,H-pb); }
      c.stroke();
      c.textBaseline='top'; c.fillStyle='#969696';
      for (let i=0;i<=5;i++) {
        const ms=from+span*i/5, text=ms===0 ? '0' : ms>=3600000 ? +(ms/3600000).toFixed(1)+'h' : ms>=60000 ? +(ms/60000).toFixed(1)+'m' : +(ms/1000).toFixed(1)+'s';
        c.textAlign=i===0?'left':i===5?'right':'center'; c.fillText(text,pl+pw*i/5,H-pb+8);
      }
      const X=elapsed=>pl+(elapsed-from)/span*pw;
      c.save(); c.beginPath(); c.rect(pl,pt,pw,ph); c.clip();
      for (const m of [...series.filter(m=>m.key!==axisKey),axis]) {
        c.strokeStyle=m.color; c.lineWidth=m.key===axisKey?2.5:1.8; c.lineJoin='round'; c.lineCap='round'; c.beginPath();
        let pen=false;
        for (const point of m.points) { if (!point) { pen=false; continue; } const x=X(point.elapsed),y=Y(point.value,m); if(pen)c.lineTo(x,y); else c.moveTo(x,y); pen=true; }
        c.stroke();
        const value=displayValue(p,m.key,dualCell);
        if (value !== null && (cursorTime !== null || m.points.length===1)) {
          c.fillStyle=m.color; c.beginPath(); c.arc(X(p.elapsed),Y(value,m),2.5,0,Math.PI*2); c.fill();
        }
      }
      if (p && cursorTime !== null) { c.strokeStyle='#acbcd0'; c.beginPath(); c.moveTo(X(p.elapsed),pt); c.lineTo(X(p.elapsed),H-pb); c.stroke(); }
      c.restore();
    }
    function paintCharts() {
      const [from,to]=windowRange();
      el('historyRangeStart').value=String(rangeStart); el('historyRangeEnd').value=String(rangeEnd);
      el('historyRangeStart').disabled=el('historyRangeEnd').disabled=!duration;
      el('historyRangeStartTime').textContent=durationText(from); el('historyRangeEndTime').textContent=durationText(to);
      el('historyRangeDuration').textContent='显示 '+durationText(to-from);
      el('historyRangeStart').setAttribute('aria-valuetext',durationText(from)); el('historyRangeEnd').setAttribute('aria-valuetext',durationText(to));
      const body=el('historyTable'); body.replaceChildren();
      for (const p of visibleRows().slice(-20).reverse()) {
        const tr=doc.createElement('tr');
        for (const text of [timeText(p.time),...metrics.map(m=>valueText(displayValue(p,m.key,dualCell),m))]) { const td=doc.createElement('td'); td.textContent=text; tr.appendChild(td); }
        body.appendChild(tr);
      }
      paintPoint(); paintCanvas();
    }
    function resetSelection(id) {
      selected=id; session=null; rows=[]; maxima=null; cursorTime=null; duration=0; rangeStart=0; rangeEnd=1000; allPower=0;
      lastPayload=lastVersion=''; dragging=false;
      pointers.clear(); pinch=null; pinchUsed=false;
    }
    async function refresh({automatic=false}={}) {
      if (dragging || automatic && (busy || Date.now() < nextAutomaticAt)) return;
      if (busy) { again=true; return; }
      busy=true;
      const request=revision, startedAt=Date.now();
      el('historyRefresh').disabled=true;
      try {
        const list=parseList(await exec(command+' --list '+offset));
        if (request !== revision) return;
        const signature=JSON.stringify(list.sessions.map(s=>[s.id,s.state,s.firstSoc,s.lastSoc]));
        if (signature !== optionsSignature) {
          optionsSignature=signature; el('historySession').replaceChildren();
          const placeholder=doc.createElement('option'); placeholder.value=''; placeholder.textContent='选择一次充电记录'; el('historySession').appendChild(placeholder);
          for (const s of list.sessions) {
            const option=doc.createElement('option'); option.value=s.id;
            option.textContent=timeText(s.start)+' · '+(s.firstSoc ?? '—')+' → '+(s.lastSoc ?? '—')+'% · '+({ACTIVE:'记录中',UNPLUGGED:'已结束',INTERRUPTED:'记录中断'})[s.state];
            el('historySession').appendChild(option);
          }
        }
        const active=list.active === 'NONE' ? '' : list.active;
        const latest=active || list.sessions[0]?.id || '';
        if (live && selected !== latest) resetSelection(latest);
        el('historySession').value=selected;
        el('historyNewer').disabled=offset===0; el('historyOlder').disabled=!list.more;
        el('historyLive').setAttribute('aria-pressed',String(live)); el('historyPage').textContent='第 '+(offset/20+1)+' 页';
        el('historyLive').textContent=active?'实时':'最近一次';
        el('historyState').textContent=list.error === 'STORAGE_ERROR' ? '记录写入失败，请检查手机可用空间。'
          : !list.running ? '后台记录器未运行，现有记录仍可查看；安装更新后重启手机以启用。'
            : list.skipped ? '发现 '+list.skipped+' 条记录摘要异常，原始数据已保留，其余记录可正常查看。'
              : list.active === 'NONE' ? '等待连接充电器 · 后台自动记录' : '正在记录 · 每 0.2 秒采样，关闭页面后继续';
        el('historyState').hidden=list.running && list.error==='NONE' && !list.skipped;
        if (!selected) {
          session=null; rows=[]; maxima=null; lastPayload=''; paintCharts();
          el('historySummary').textContent=list.sessions.length ? '当前没有正在记录的充电。选择历史记录查看图表。' : '尚无充电记录。连接充电器后会自动生成。';
          el('historyError').textContent=''; return;
        }
        if (!validId(selected)) throw new Error('充电记录编号无效');
        const summary=list.sessions.find(s=>s.id===selected);
        session=summary || session;
        if (summary) duration=Math.max(duration,summary.duration);
        const [from,to]=windowRange(), range=rangeStart===0 && rangeEnd===1000 ? '' : ' '+from+' '+to;
        const version=summary ? [selected,summary.count,summary.end,summary.state,range].join(':') : '';
        if (version && version===lastVersion && lastPayload) { paintPoint(); paintCanvas(); el('historyError').textContent=''; return; }
        const requestedId=selected, payload=await exec(command+' --read '+requestedId+range);
        if (request !== revision || requestedId !== selected) return;
        const parsed=parseRecords(payload,requestedId);
        el('historySummary').textContent=(summary ? timeText(summary.start)+' · '+(summary.state==='ACTIVE' ? '持续 ' : '结束于 '+timeText(summary.end)+' · ')+durationText(summary.duration)+' · ' : '')+
          '已保存 '+parsed.total+' 个采样，当前图表 '+parsed.rows.length+' 个点';
        if (payload !== lastPayload) {
          rows=parsed.rows; maxima=parsed.maxima; lastPayload=payload;
          duration=Math.max(duration,rows.at(-1)?.elapsed || 0);
          allPower=Math.max(maxima?.power || 0,...rows.map(p=>p.power || 0));
        }
        lastVersion=version; paintCharts(); el('historyError').textContent='';
      } catch (error) {
        if (request===revision) el('historyError').textContent='读取失败：'+String(error?.message || error);
      } finally {
        nextAutomaticAt=startedAt+Math.max(200,(Date.now()-startedAt)*3);
        busy=false; el('historyRefresh').disabled=false;
        if (again) { again=false; refresh(); }
      }
    }
    function plotRatio(clientX) {
      const rect=canvas.getBoundingClientRect();
      return Math.max(0,Math.min(1,(clientX-rect.left-66)/Math.max(1,rect.width-76)));
    }
    function pickPoint(event) {
      const points=visibleRows(); if (!points.length) return;
      const [from,to]=chartWindow();
      cursorTime=points[nearestIndex(points,from+plotRatio(event.clientX)*(to-from))].elapsed; paintPoint(); paintCanvas();
    }
    function finishRange() { dragging=false; revision++; lastVersion=''; refresh(); }
    function pinchPosition() {
      const [a,b]=[...pointers.values()];
      return {distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),ratio:plotRatio((a.x+b.x)/2)};
    }
    function startPinch() {
      if (!duration) return;
      const position=pinchPosition(), [from,to]=chartWindow();
      pinch={distance:position.distance,span:rangeEnd-rangeStart,
        anchor:Math.max(0,Math.min(1000,(from+position.ratio*(to-from))/duration*1000))};
      pinchUsed=true; dragging=true; revision++;
    }
    canvas.addEventListener('pointerdown',event=>{
      try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
      if (event.pointerType==='touch') {
        pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
        if (pointers.size===2) startPinch();
        if (pointers.size>1 || pinchUsed) return;
      }
      pickPoint(event);
    });
    canvas.addEventListener('pointermove',event=>{
      if (event.pointerType==='touch') {
        if (!pointers.has(event.pointerId)) return;
        pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
        if (pinch) {
          const position=pinchPosition(), span=Math.max(20,Math.min(1000,Math.round(pinch.span*pinch.distance/position.distance)));
          rangeStart=Math.round(Math.max(0,Math.min(1000-span,pinch.anchor-position.ratio*span)));
          rangeEnd=rangeStart+span; paintCharts(); return;
        }
        if (pinchUsed || pointers.size>1) return;
      }
      if (event.pointerType !== 'touch' || event.buttons) pickPoint(event);
    });
    function endPointer(event) {
      if (!pointers.delete(event.pointerId)) return;
      if (pinch) {
        if (pointers.size>=2) startPinch();
        else {pinch=null;finishRange();}
      }
      if (!pointers.size) pinchUsed=false;
    }
    for (const name of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(name,endPointer);
    canvas.addEventListener('keydown',event=>{
      const points=visibleRows(); if (!points.length || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); let index=cursorTime === null ? points.length-1 : nearestIndex(points,cursorTime);
      index=event.key==='Home' ? 0 : event.key==='End' ? points.length-1 : Math.max(0,Math.min(points.length-1,index+(event.key==='ArrowLeft'?-1:1)));
      cursorTime=points[index].elapsed; paintPoint(); paintCanvas();
    });
    for (const m of metrics) el('historyAxis-'+m.key).addEventListener('click',()=>{ axisKey=m.key; paintPoint(); paintCanvas(); });
    for (const side of ['Start','End']) {
      const input=el('historyRange'+side);
      input.addEventListener('input',()=>{
        dragging=true; revision++;
        const value=Math.max(0,Math.min(1000,Number(input.value) || 0));
        if (side==='Start') rangeStart=Math.min(value,rangeEnd-20); else rangeEnd=Math.max(value,rangeStart+20);
        paintCharts();
      });
      input.addEventListener('change',finishRange); input.addEventListener('pointercancel',finishRange);
    }
    el('historyDualCell').addEventListener('change',()=>{
      dualCell=el('historyDualCell').checked;
      try { view.localStorage?.setItem(dualCellKey,dualCell?'YES':'NO'); } catch (_) {}
      paintCharts();
    });
    el('historySession').addEventListener('change',()=>{ live=false; resetSelection(el('historySession').value); revision++; paintCharts(); refresh(); });
    el('historyLive').addEventListener('click',()=>{ live=true; offset=0; resetSelection(''); revision++; paintCharts(); refresh(); });
    for (const [name,delta] of [['Newer',-20],['Older',20]]) el('history'+name).addEventListener('click',()=>{
      live=false; resetSelection(''); offset=Math.max(0,offset+delta); revision++; optionsSignature=''; paintCharts(); refresh();
    });
    el('historyRefresh').addEventListener('click',refresh);
    el('historyRecordsToggle').addEventListener('click',()=>{
      el('historyRecords').hidden=!el('historyRecords').hidden;
      el('historyRecordsToggle').setAttribute('aria-expanded',String(!el('historyRecords').hidden));
    });
    view.addEventListener?.('resize',paintCanvas);
    paintCharts();
    return {refresh};
  }
  const api = {validId,parseList,parseRecords,chart,powerLimit,nearestIndex,displayValue,createUI};
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OplusChargingHistory = api;
})(typeof window !== 'undefined' ? window : globalThis);
