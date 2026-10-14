/* 纯日志解析函数：Node 与 WebView 均可直接加载，不涉及系统调用。 */
(function (root) {
  'use strict';

  const labels = {
    UNSUPPORTED_UFCS_NODE: 'UFCS 节点不可用',
    ANOTHER_WATCHDOG_PRESENT_OR_STALE_LOCK: '守护锁异常',
    CONTROL_REVOKE_REQUESTED_CALLBACK_UNVERIFIED: '已申请撤销本模块限流',
    CONTROL_FINISHED_PROTOCOL_CHANGED: '充电协议变化，已撤销限流',
    CONTROL_FINISHED_MONITOR_DISABLED: '监测已关闭，已撤销限流',
    CONTROL_FINISHED_OWNERSHIP_CHANGED: '强制状态被外部改变，已退出限流',
    CONTROL_GUARDIAN_RECOVERY_REQUESTED: '守护已撤销残留限流',
    CONTROL_GUARDIAN_RECOVERY_FAILED: '守护撤销残留限流失败',
    WATCHDOG_ALREADY_RUNNING: '守护已在运行',
  };

  const warningStates = new Set([
    'UNSUPPORTED_UFCS_NODE', 'ANOTHER_WATCHDOG_PRESENT_OR_STALE_LOCK',
  ]);

  function parseLine(line) {
    if (typeof line !== 'string') return null;
    const raw = line.trim();
    if (!raw || raw === 'NO_LOGS_YET' || raw === 'NO_PREVIOUS_LOG') return null;
    const fields = Object.create(null);
    for (const match of raw.matchAll(/(?:^|\s)([a-zA-Z_][a-zA-Z0-9_]*)=([^\s]*)/g)) {
      fields[match[1]] = match[2];
    }
    return {
      raw,
      fields,
      state: fields.state || 'UNKNOWN',
      warning: warningStates.has(fields.state) ||
        /^(CONTROL_(BLOCKED|RECOVERY_REQUIRED|GUARDIAN_RECOVERY_FAILED))/.test(fields.state),
    };
  }

  function parseLines(raw) {
    if (typeof raw !== 'string') return [];
    return raw.split(/\r?\n/).map(parseLine).filter(Boolean);
  }

  /** 兼容 SukiSU / KernelSU 不同 WebUI API：原始字符串、JSON 字符串、嵌套 stdout 结构。 */
  function unwrapExecResponse(value, depth = 0) {
    if (depth > 5) throw new Error('WebUI 命令返回结构嵌套过深');
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^[{\[]/.test(trimmed)) {
        let decoded;
        try { decoded = JSON.parse(trimmed); } catch { decoded = null; }
        if (decoded && typeof decoded === 'object') {
          const hasOutput = ['stdout', 'out', 'output', 'result', 'data', 'response']
            .some(key => Object.prototype.hasOwnProperty.call(decoded, key));
          if (hasOutput) return unwrapExecResponse(decoded, depth + 1);
        }
      }
      return value;
    }
    if (value == null) throw new Error('模块管理器未返回读取结果');
    if (value instanceof Uint8Array) return new TextDecoder().decode(value);
    if (typeof value !== 'object') throw new Error('模块管理器返回了无法识别的数据类型');
    for (const key of ['errno', 'exitCode', 'code']) {
      if (Object.prototype.hasOwnProperty.call(value, key) &&
          Number(value[key]) !== 0) {
        const msg = typeof value.stderr === 'string' ? value.stderr.slice(0, 200) : '';
        throw new Error('读取命令失败：' + key + '=' + String(value[key]) + (msg ? '；' + msg : ''));
      }
    }
    for (const key of ['stdout', 'out', 'output', 'result', 'data', 'response']) {
      if (value[key] != null) return unwrapExecResponse(value[key], depth + 1);
    }
    throw new Error('模块管理器返回结构未知（未找到 stdout）');
  }

  function parseStatus(raw) {
    const result = Object.create(null);
    if (typeof raw !== 'string') return result;
    for (const line of raw.split(/[\r\n;]+/)) {
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) result[key] = line.slice(separator + 1).trim();
    }
    return result;
  }

  /** 后端用单行LOG_B64传输多行日志，以兼容只返回最后一行的WebUI桥接。 */
  function decodeLogPayload(raw) {
    if (typeof raw !== 'string') throw new Error('日志响应不是文本');
    if (!raw.startsWith('LOG_B64=')) return raw;
    const data = raw.slice(8).trim();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > 1024 * 1024) {
      throw new Error('模块日志编码无效或长度异常');
    }
    try {
      const binary = atob(data);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
      throw new Error('模块日志无法进行 Base64 / UTF-8 解码');
    }
  }

  /** UFCS_CURR/status 的投票快照；驱动原始数值单位为 mA。 */
  function parseVotes(raw) {
    const voters = [];
    let effective = null;
    if (typeof raw !== 'string') return {effective, voters};
    for (const line of raw.split(/\r?\n/).slice(0, 65)) {
      const vote = /^UFCS_CURR:\s+([A-Z0-9_]+):\s+en=([01])\s+v=(-?\d+)$/.exec(line);
      if (vote) {
        voters.push({name: vote[1], enabled: vote[2] === '1', raw: vote[3]});
        continue;
      }
      const active = /^UFCS_CURR:\s+effective=([A-Za-z0-9_]+)\s+type=([A-Za-z]+)\s+v=(-?\d+)$/.exec(line);
      if (active) effective = {name: active[1], type: active[2], raw: active[3]};
    }
    return {effective, voters};
  }

  /** SukiSU 仅返回最后一行时，仍可读取完整的 votable 多行快照。 */
  function decodeVotePayload(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('VOTES_B64=')) {
      throw new Error('UFCS 投票读取失败或接口不可用');
    }
    const data = raw.slice('VOTES_B64='.length).trim();
    if (data.length > 32768 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
        data.length % 4 !== 0) {
      throw new Error('UFCS 投票数据编码无效');
    }
    try {
      const bytes = Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
      return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
      throw new Error('UFCS 投票数据无法解码');
    }
  }

  /** 仅解析后端筛选过的内核历史日志，不将请求值当成实测电流。 */
  function parseKernelSnapshot(raw) {
    const data = parseStatus(raw);
    if (!Object.prototype.hasOwnProperty.call(data, 'KERNEL_B64')) {
      throw new Error('缺少内核日志数据');
    }
    const encoded = data.KERNEL_B64;
    if (encoded.length > 60000 || encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error('内核日志编码无效');
    }
    let decoded;
    try {
      const bytes = Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0));
      decoded = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    } catch { throw new Error('内核日志解码失败'); }
    const now = /^\d+$/.test(data.KERNEL_NOW_UPTIME || '')
      ? Number(data.KERNEL_NOW_UPTIME) : null;
    const lines = decoded.split(/\r?\n/).filter(Boolean).slice(-32);
    let request = null;
    let exit = null;
    for (const line of lines) {
      const stamp = /^\[\s*(\d+(?:\.\d+)?)\]/.exec(line);
      const uptime = stamp ? Number(stamp[1]) : null;
      const sent = /success set vbus_mv = (\d+), ibus_ma = (\d+)/.exec(line);
      if (sent) request = {vbusMv:Number(sent[1]), ibusMa:Number(sent[2]), uptime};
      if (/normal hw full|CHG_FULL_VOTER set ufcs disable to true|exit ufcs fast charge|ufcs force exit|ufcs handshake error|ufcs reset notify/.test(line)) {
        exit = {uptime, detail:line.slice(0, 400)};
      }
    }
    const ageSeconds = request && now !== null && request.uptime !== null
      ? Math.max(0, Math.floor(now - request.uptime)) : null;
    const exitedAfterRequest = Boolean(request && exit && exit.uptime !== null &&
      request.uptime !== null && exit.uptime > request.uptime);
    return {lines, request, ageSeconds, exitedAfterRequest};
  }

  function temperature(raw) {
    if (!/^\d{1,5}$/.test(String(raw ?? ''))) return '—';
    const n = Number(raw);
    return (n / 10).toFixed(1) + '°C';
  }

  function timestamp(fields) {
    if (/^\d{10,12}$/.test(String(fields.epoch || ''))) {
      const value = Number(fields.epoch) * 1000;
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString('zh-CN', {hour12:false});
    }
    if (/^\d+$/.test(fields.time || '')) return '开机后 ' + fields.time + ' 秒';
    return '时间未知';
  }

  function level(state) {
    if (/^CONTROL_(RECOVERY_REQUIRED|GUARDIAN_RECOVERY_FAILED)/.test(state)) return 'danger';
    if (warningStates.has(state) || /^CONTROL_BLOCKED/.test(state)) return 'warning';
    if (/^CONTROL_(FINISHED|START_ADAPTIVE|REVOKE_REQUESTED|GUARDIAN_RECOVERY_REQUESTED)/.test(state)) return 'good';
    return 'neutral';
  }

  const adaptiveStart = /^CONTROL_START_ADAPTIVE_(\d+)$/;
  /** 事件状态到中文标签；自适应启动事件附带当时的投票值（mA）。 */
  function labelFor(state) {
    if (Object.prototype.hasOwnProperty.call(labels, state)) return labels[state];
    const start = adaptiveStart.exec(state);
    return start ? '自适应限流已启动（' + start[1] + ' mA）' : state;
  }

  /**
   * 只读协议快照。优先使用明确的 OPLUS 在线位，其次使用 USB real_type。
   * CPA 原始数字不跨固件硬编码映射，避免误把允许仲裁当作正在充电。
   */
  function identifyProtocol(raw) {
    const data = parseStatus(raw);
    const bit = key => data[key] === '1' ? 1 : data[key] === '0' ? 0 : null;
    const rawType = data.USB_REAL_TYPE && data.USB_REAL_TYPE !== 'UNKNOWN'
      ? data.USB_REAL_TYPE : data.USB_TYPE || 'UNKNOWN';
    const type = rawType.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const checks = [
      {key:'UFCS', title:'UFCS', on:bit('UFCS')},
      {key:'VOOC', title:'VOOC / SUPERVOOC', on:bit('VOOC')},
      {key:'PPS', title:'OPLUS PPS', on:bit('PPS')},
    ];
    const active = checks.filter(s => s.on === 1);
    const onlineWireless = bit('WIRELESS_ONLINE') === 1;
    const unplugged = data.POWER === 'NO' && bit('USB_ONLINE') !== 1 &&
      bit('WIRELESS_ONLINE') !== 1;
    const usbHint = (() => {
      if (/PPS/.test(type)) return ['PPS','USB PD PPS'];
      if (/\bPD\b|(^|_)PD($|_)|POWER_DELIVERY/.test(type)) return ['PD','USB PD'];
      if (/HVDCP|QUICK_CHARGE|(^|_)QC[0-9_]*($|_)/.test(type)) return ['QC','QC / HVDCP'];
      if (/SUPERVOOC|SVOOC/.test(type)) return ['VOOC','SUPERVOOC'];
      if (/VOOC/.test(type)) return ['VOOC','VOOC'];
      if (/DCP/.test(type)) return ['DCP','DCP'];
      if (/CDP/.test(type)) return ['CDP','CDP'];
      if (/SDP/.test(type)) return ['SDP','SDP'];
      return null;
    })();
    let id = 'UNKNOWN', name = '无法确认', confidence = '未知';
    let reason = '当前驱动未提供明确的可识别充电协议信号。';
    let source = 'OPLUS MMS / USB power_supply';
    if (unplugged) {
      id = 'NONE'; name = '未连接充电器'; confidence = '高';
      reason = 'Android 电池状态为未供电，且没有报告 USB / 无线在线。';
      source = 'dumpsys battery';
    } else if (active.length + Number(onlineWireless) > 1) {
      reason = '检测到多个协议在线信号，可能正在切换协议，暂不判定。';
      confidence = '冲突';
    } else if (active.length === 1) {
      id = active[0].key;
      name = active[0].title;
      confidence = '较高';
      source = 'OPLUS MMS 在线位';
      reason = id === 'VOOC'
        ? 'VOOC 主题报告在线，尚不能区分 VOOC 与 SUPERVOOC。'
        : active[0].title + ' 主题报告在线；仅表示驱动状态，不保证正在持续快充。';
    } else if (onlineWireless) {
      id = 'WIRELESS'; name = '无线充电'; confidence = '较高';
      source = 'power_supply/wireless/online';
      reason = '无线供电节点报告在线，具体无线协议不可确认。';
    } else if (usbHint) {
      [id, name] = usbHint;
      source = 'power_supply/usb/' + (data.USB_REAL_TYPE &&
        data.USB_REAL_TYPE !== 'UNKNOWN' ? 'real_type' : 'type');
      confidence = ['PD','PPS','QC','VOOC'].includes(id) ? '中' : '基础类型';
      reason = ['SDP','CDP','DCP'].includes(id)
        ? 'USB 基础充电类型，不能排除正在使用私有快充。'
        : '来自 USB 充电类型；建议与 OPLUS 协议在线状态交叉核对。';
    } else if (bit('PPS_ACTIVE') === 1 && bit('PD_ACTIVE') === 1) {
      id = 'PPS'; name = 'USB PD PPS'; confidence = '中';
      source = 'power_supply/usb/pps_active';
      reason = 'USB 报告 PPS/PD 已激活，但未提供具体协商信息。';
    } else if (bit('PD_ACTIVE') === 1) {
      id = 'PD'; name = 'USB PD'; confidence = '中';
      source = 'power_supply/usb/pd_active';
      reason = 'USB 报告 PD 已激活，无法仅凭此值区分固定 PDO 与 PPS。';
    }
    // 仅供只读显示，不推导无法证明的“未启用”结论。
    const signalRows = [
      ...checks.map(s => ({name:s.title, state:s.on === 1 ? '在线' :
        s.on === 0 ? '未报告在线' : '未知', active:s.on === 1})),
      ...['PD','QC','DCP','CDP','SDP','WIRELESS'].map(key => ({
        name:{PD:'USB PD',QC:'QC / HVDCP',DCP:'DCP',CDP:'CDP',SDP:'SDP',WIRELESS:'无线'}[key],
        state: id === key ? '已识别' : key === 'WIRELESS' && bit('WIRELESS_ONLINE') === 0
          ? '未报告在线' : '未确认',
        active: id === key,
      })),
    ];
    const visible = ['UFCS','VOOC','PPS','USB_REAL_TYPE','USB_TYPE',
      'PD_ACTIVE','PPS_ACTIVE','USB_ONLINE','WIRELESS_ONLINE',
      'POWER','CPA_ITEM_ID','CPA_DATA'];
    const evidence = visible.map(key => key + '=' + (data[key] ?? 'UNKNOWN')).join('\n');
    return {id,name,confidence,reason,source,signalRows,evidence};
  }


  // 仅用于说明投票节点用途，不据此推断当前协议或硬件充电状态。
  const votableGroups = Object.freeze([
    {id:'wired', label:'基础与有线充电'},
    {id:'ufcs', label:'UFCS'},
    {id:'pps', label:'PPS'},
    {id:'vooc', label:'VOOC / SUPERVOOC'},
    {id:'wireless', label:'无线充电'},
    {id:'other', label:'其他驱动投票'},
  ]);
  const votableDescriptions = Object.freeze({
    CHG_DISABLE:'全局充电禁用',
    CHG_SUSPEND:'全局充电暂停',
    COOL_DOWN:'降温控制等级',
    CPA_REQ_LOCK:'充电协议仲裁请求锁',
    FLASH_MODE:'Flash 模式相关控制（用途待确认）',
    FV_MAX:'浮充电压上限投票',
    FV_MIN:'浮充电压下限投票',
    GAUGE_SHUTDOWN_VOLTAGE:'电量计关机电压阈值',
    GAUGE_TERM_VOLTAGE:'电量计终止电压阈值',
    GAUGE_UPDATE:'电量计更新调度',
    OTG_DISABLE:'OTG 反向供电禁用',
    PD_BOOST_DISABLE:'PD Boost 禁用',
    PD_SVOOC:'PD 与 SVOOC 模式协调',
    PLC_FORCE_BUCK:'PLC 强制 Buck 降压控制',
    TARGET_SHUTDOWN_VOLTAGE:'目标关机电压',
    TARGET_TERM_VOLTAGE:'目标终止电压',
    WIRED_CHARGE_SUSPEND:'有线充电暂停',
    WIRED_CHARGING_DISABLE:'有线充电禁用',
    WIRED_FCC:'有线电池侧充电电流限制',
    WIRED_ICL:'有线输入电流限制',
    UFCS_BOOT:'UFCS 启动控制',
    UFCS_CURR:'UFCS 协议电流投票',
    UFCS_DISABLE:'UFCS 禁用控制',
    UFCS_NOT_ALLOW:'UFCS 允许条件',
    PPS_BOOT:'PPS 启动控制',
    PPS_CURR:'PPS 协议电流投票',
    PPS_DISABLE:'PPS 禁用控制',
    PPS_NOT_ALLOW:'PPS 允许条件',
    VOOC_BOOT:'VOOC 启动控制',
    VOOC_CHG_AUTO_MODE:'VOOC 自动模式',
    VOOC_CURR:'VOOC 协议电流投票',
    VOOC_DISABLE:'VOOC 禁用控制',
    VOOC_NOT_ALLOW:'VOOC 允许条件',
    VOOC_VAC2V2X_UVP:'VOOC 电压转换路径欠压保护（具体用途待确认）',
    WLS_COMU:'无线充电通信相关（具体参数待确认）',
    WLS_FASTCHG_DISABLE:'无线快充禁用',
    WLS_FCC:'无线电池侧充电电流限制',
    WLS_FORCE_BPP_MODE:'强制无线 BPP 模式',
    WLS_INSERT_DISABLE:'无线接入禁用',
    WLS_NOR_FCC:'无线普通模式电池电流限制',
    WLS_NOR_ICL:'无线普通模式输入电流限制',
    WLS_NOR_INPUT_DISABLE:'无线普通模式输入禁用',
    WLS_NOR_OUT_DISABLE:'无线普通模式输出禁用',
    WLS_QUIET_MODE:'无线静音模式',
    WLS_RX_DISABLE:'无线接收禁用',
    WLS_WRX_EN:'无线接收使能（具体用途待确认）',
  });

  function votableGroup(name) {
    if (name.startsWith('UFCS_')) return 'ufcs';
    if (name.startsWith('PPS_')) return 'pps';
    if (name.startsWith('VOOC_')) return 'vooc';
    if (name.startsWith('WLS_')) return 'wireless';
    if (Object.prototype.hasOwnProperty.call(votableDescriptions, name)) return 'wired';
    return 'other';
  }

  function decodeVotablesPayload(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('VOTABLES_B64=')) {
      throw new Error('投票目录列表不可用或读取失败');
    }
    const encoded = raw.slice('VOTABLES_B64='.length).trim();
    if (!encoded || encoded.length > 500000 ||
        encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error('投票目录数据编码异常');
    }
    try {
      const bytes = Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0));
      return new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    } catch {
      throw new Error('投票目录数据解码失败');
    }
  }

  // 后端白名单过滤的 TSV 结构。保留 UNKNOWN，不把 -22 当成实际电流。
  function parseVotables(raw) {
    if (typeof raw !== 'string' || raw.length > 450000) {
      throw new Error('投票目录数据长度异常');
    }
    const items = [];
    const names = new Set();
    const byName = Object.create(null);
    const number = s => /^-?\d{1,16}$/.test(s);
    for (const line of raw.split(/\r?\n/).slice(0, 18000)) {
      const p = line.split('\t');
      if (p[0] === 'G' && p.length === 4 &&
          /^[A-Z0-9_]{1,64}$/.test(p[1]) && !names.has(p[1]) && items.length < 128) {
        const item = {
          name:p[1], description:votableDescriptions[p[1]] || '未收录说明的驱动投票',
          group:votableGroup(p[1]), forceActive:/^[01]$/.test(p[2]) ? p[2] : '?',
          forceVal:number(p[3]) ? p[3] : '?',
          effective:null, voters:[], error:null,
        };
        items.push(item);
        names.add(item.name);
        byName[item.name] = item;
      } else if (p[0] === 'E' && p.length === 5 && byName[p[1]] &&
          /^(?:[A-Z0-9_]{1,64}|none)$/.test(p[2]) &&
          ['Min','Max','Set_any'].includes(p[3]) && number(p[4])) {
        byName[p[1]].effective = {name:p[2], type:p[3], raw:p[4]};
      } else if (p[0] === 'V' && p.length === 5 && byName[p[1]] &&
          /^[A-Z0-9_]{1,64}$/.test(p[2]) && /^[01]$/.test(p[3]) &&
          number(p[4]) && byName[p[1]].voters.length < 128) {
        byName[p[1]].voters.push({name:p[2], enabled:p[3]==='1', raw:p[4]});
      } else if (p[0] === 'R' && p.length === 3 && byName[p[1]] &&
          p[2] === 'UNREADABLE') {
        byName[p[1]].error = 'status 不可读取';
      }
    }
    return items;
  }


  /**
   * 根据只读协议识别结果选择相关投票，绝不把旧协议残留的票认作当前协议。
   * 普通有线类型只对应共享 WIRED_* 节点，不推断 PD/QC 等协商电流。
   */
  function protocolVoteSelection(protocol, votables) {
    const id = typeof protocol?.id === 'string' ? protocol.id : 'UNKNOWN';
    const groups = {
      UFCS:['UFCS_CURR','UFCS_DISABLE','UFCS_NOT_ALLOW','UFCS_BOOT',
        'WIRED_FCC','WIRED_ICL'],
      PPS:['PPS_CURR','PPS_DISABLE','PPS_NOT_ALLOW','PPS_BOOT',
        'WIRED_FCC','WIRED_ICL'],
      VOOC:['VOOC_CURR','VOOC_DISABLE','VOOC_NOT_ALLOW','VOOC_BOOT',
        'VOOC_CHG_AUTO_MODE','WIRED_FCC','WIRED_ICL'],
      WIRELESS:['WLS_FCC','WLS_NOR_FCC','WLS_NOR_ICL',
        'WLS_FASTCHG_DISABLE','WLS_RX_DISABLE'],
      PD:['WIRED_FCC','WIRED_ICL','WIRED_CHARGING_DISABLE','PD_BOOST_DISABLE'],
      QC:['WIRED_FCC','WIRED_ICL','WIRED_CHARGING_DISABLE'],
      DCP:['WIRED_FCC','WIRED_ICL','WIRED_CHARGING_DISABLE'],
      CDP:['WIRED_FCC','WIRED_ICL','WIRED_CHARGING_DISABLE'],
      SDP:['WIRED_FCC','WIRED_ICL','WIRED_CHARGING_DISABLE'],
    };
    const note = id === 'NONE'
      ? '当前未连接充电器，不展示可能残留的协议投票。'
      : id === 'UNKNOWN'
        ? '协议无法确认或在线信号冲突，暂不将任何投票归属为当前协议。'
        : ['PD','QC','DCP','CDP','SDP'].includes(id)
          ? '当前协议无可确认的独立电流 Votable；下方是共享有线充电投票，不能反推出适配器协商电流。'
          : id === 'WIRELESS'
            ? '无线供电已报告在线，以下为无线相关投票；不能据此区分具体无线快充协议。'
            : '以下展示该协议对应的投票与共享有线投票；投票数值不代表实际电流。';
    const names = groups[id] || [];
    const all = Array.isArray(votables) ? votables : [];
    const byName = new Map(all.map(item => [item.name,item]));
    const rows = names.map(name => byName.get(name)).filter(Boolean);
    const primaryName = {UFCS:'UFCS_CURR',PPS:'PPS_CURR',VOOC:'VOOC_CURR',
      WIRELESS:'WLS_FCC',PD:'WIRED_FCC',QC:'WIRED_FCC',DCP:'WIRED_FCC',
      CDP:'WIRED_FCC',SDP:'WIRED_FCC'}[id] || null;
    const primary = byName.get(primaryName) || null;
    return {id, rows, primary, note, expected:names.length};
  }


  /**
   * 只读 USB 输入与投票诊断。power_supply 的电压上限、电流上限是驱动报告，
   * 不是充电器 APDO 列表、线材 E-marker 或已确认的 PD Contract。
   */
  function analyzeNegotiation(raw, context = {}) {
    const data = parseStatus(raw);
    if (!['0','1'].includes(data.USB_ONLINE)) {
      if (data.USB_ONLINE !== 'UNKNOWN') throw new Error('USB 协商信息响应不完整');
    }
    const unsigned = (key, max) => {
      const value = data[key];
      if (!/^\d{1,10}$/.test(value || '')) return null;
      const n = Number(value);
      return Number.isSafeInteger(n) && n >= 0 && n <= max ? n : null;
    };
    const online = data.USB_ONLINE === '1' ? true :
      data.USB_ONLINE === '0' ? false : null;
    const uv = online ? unsigned('USB_VOLTAGE_UV', 24000000) : null;
    const umax = online ? unsigned('USB_CURRENT_MAX_UA', 20000000) : null;
    const ulimit = online ? unsigned('USB_INPUT_LIMIT_UA', 20000000) : null;
    const vmax = online ? unsigned('USB_VOLTAGE_MAX_UV', 24000000) : null;
    const unow = online ? unsigned('USB_CURRENT_NOW_UA', 20000000) : null;
    const voltageV = uv && uv >= 3000000 ? uv / 1000000 : null;
    const reportedMaxA = umax && umax > 0 ? umax / 1000000 : null;
    const inputLimitA = ulimit && ulimit > 0 ? ulimit / 1000000 : null;
    const maxVoltageV = vmax && vmax >= 3000000 ? vmax / 1000000 : null;
    // 无法确认电流反馈节点已实现时，0 不被当作 0W 实测。
    const measuredCurrentA = unow && unow > 0 ? unow / 1000000 : null;
    // USB input_current_limit 可能属于通用 Buck 路径而非 PPS 充电泵；
    // current_max 也不保证是 APDO 或线材额定值，因此只计算参考值，不宣称上限。
    const reportedPowerReferenceW = voltageV !== null && reportedMaxA !== null
      ? voltageV * reportedMaxA : null;
    const measuredInputPowerW = voltageV && measuredCurrentA
      ? voltageV * measuredCurrentA : null;
    const soc = unsigned('SOC', 100);
    const temperatureRaw = unsigned('BATTERY_TEMP_DECI', 1000);
    const tempC = temperatureRaw === null ? null : temperatureRaw / 10;

    const protocolId = typeof context.protocolId === 'string'
      ? context.protocolId.toUpperCase() : 'UNKNOWN';
    const activeProtocol = typeof context.activeProtocol === 'string'
      ? context.activeProtocol.toUpperCase() : 'NONE';
    const driverProtocol = ['ufcs','vooc','pps'].includes(data.VOTE_PROTOCOL)
      ? data.VOTE_PROTOCOL.toUpperCase() : 'NONE';
    const chosen = protocolId === driverProtocol && activeProtocol === driverProtocol &&
      ['UFCS','VOOC','PPS'].includes(driverProtocol);
    const vote = chosen ? {
      node:driverProtocol + '_CURR',
      forceActive:data.VOTE_FORCE_ACTIVE === '1' ? true :
        data.VOTE_FORCE_ACTIVE === '0' ? false : null,
      forceVal:unsigned('VOTE_FORCE_VAL', 20000),
      effective:unsigned('VOTE_EFFECTIVE', 20000),
      owner:/^[A-Z0-9_]{1,64}$/.test(data.VOTE_OWNER || '')
        ? data.VOTE_OWNER : 'UNKNOWN',
    } : null;
    const target = /^\d{1,6}$/.test(String(context.targetRaw ?? ''))
      ? Number(context.targetRaw) : null;
    let voteStatus = '暂无对应的活动协议投票，无法判断算法是否接管。';
    if (vote && context.controlState === 'RUNNING') {
      if (vote.forceActive === true && target !== null &&
          vote.forceVal === target && vote.effective === target &&
          vote.owner === 'DEBUG_FORCE_CLIENT') {
        voteStatus = '模块目标与驱动强制投票一致，投票链路已确认；无法据此证明充电器已执行相同电流。';
      } else if (vote.forceActive === false || vote.forceActive === null) {
        voteStatus = '驱动强制投票未确认开启，需要先检查模块接管状态。';
      } else if (target !== null && vote.forceVal !== null &&
          vote.forceVal !== target) {
        voteStatus = '模块目标与驱动保存的强制投票不一致，先检查控制日志。';
      } else if (target !== null && vote.effective !== null &&
          vote.effective !== target) {
        voteStatus = '驱动有效投票未达到模块目标，先检查投票回调或其他限制。';
      } else {
        voteStatus = '强制投票已开启，但尚无法验证驱动有效值是否等于模块目标。';
      }
    }
    let supplyStatus;
    if (online === false) {
      supplyStatus = '当前未检测到 USB 供电；隐藏已断线的 USB 电压、电流残留值。';
    } else if (online === null) {
      supplyStatus = 'USB 供电状态未知，暂时无法判断协商输入能力。';
    } else if (reportedPowerReferenceW !== null) {
      supplyStatus = 'USB 驱动报告约 ' + voltageV.toFixed(2) + 'V × ' +
        reportedMaxA.toFixed(2) + 'A，得到 ' +
        reportedPowerReferenceW.toFixed(1) + 'W 参考值（不是硬上限或实测功率）。' +
        (inputLimitA !== null
          ? ' 独立的 USB 输入策略限额为 ' + inputLimitA.toFixed(2) +
            'A，可能不约束 PPS/VOOC 充电泵，因此不参与功率计算。'
          : '') +
        ' 无法仅凭这些字段确认充电器 APDO、线材规格或实际协商功率。';
    } else {
      supplyStatus = 'USB 在线，但缺少足够的电压或电流上限读数，无法估算输入能力。';
    }
    const thermalStatus = (soc !== null && soc >= 75) ||
        (tempC !== null && tempC >= 38)
      ? '当前电量/温度可能触发充电阶段或温控限流，不能只凭输入上限归因。'
      : '即使投票生效，仍可能受充电阶段、温控、线材或硬件限制。';
    return {
      online, voltageV, reportedMaxA, inputLimitA, maxVoltageV,
      reportedPowerReferenceW, measuredCurrentA, measuredInputPowerW,
      soc, tempC, driverProtocol, vote, target, voteStatus, supplyStatus,
      thermalStatus,
      wiredIcl:data.WIRED_ICL_EFFECTIVE || 'UNKNOWN',
      wiredIclOwner:data.WIRED_ICL_OWNER || 'UNKNOWN',
      wiredFcc:data.WIRED_FCC_EFFECTIVE || 'UNKNOWN',
      wiredFccOwner:data.WIRED_FCC_OWNER || 'UNKNOWN',
    };
  }

  const api = Object.freeze({
    parseLine, parseLines, parseStatus, unwrapExecResponse, decodeLogPayload,
    temperature, timestamp, level, labelFor, parseVotes, decodeVotePayload, parseKernelSnapshot,
    warningStates, labels, identifyProtocol,
    votableGroups, votableDescriptions, votableGroup, decodeVotablesPayload, parseVotables,
    protocolVoteSelection, analyzeNegotiation
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OplusVotableLog = api;
})(typeof window !== 'undefined' ? window : globalThis);
