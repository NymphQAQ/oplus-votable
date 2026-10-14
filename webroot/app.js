(() => {
  'use strict';

  const L = window.OplusVotableLog;
  const SCRIPT = '/data/adb/modules/oplus-votable/webroot/log-reader.sh';
  const CONTROL = '/data/adb/modules/oplus-votable/charge-test.sh';
  const ALLOWED_COMMANDS = Object.freeze({
    status: 'sh ' + SCRIPT + ' --status',
    battery: 'sh ' + SCRIPT + ' --battery',
    protocol: 'sh ' + SCRIPT + ' --protocol',
    negotiation: 'sh ' + SCRIPT + ' --negotiation',
    votes: 'sh ' + SCRIPT + ' --votes',
    votables: 'sh ' + SCRIPT + ' --votables',
    kernelUfcs: 'sh ' + SCRIPT + ' --kernel-ufcs',
    latest: 'sh ' + SCRIPT + ' --latest',
    previous: 'sh ' + SCRIPT + ' --previous',
    controlStatus: 'sh ' + CONTROL + ' --status',
    monitorEnable: 'sh ' + CONTROL + ' --monitor-enable',
    monitorDisable: 'sh ' + CONTROL + ' --monitor-disable',
  });
  const el = id => document.getElementById(id);

  let selectedEntries = [];
  let busy = false;
  let logsBusy = false;
  let controlBusy = false;
  let controlState = 'UNKNOWN';
  let controlPhase = 'IDLE';
  let controlReason = 'UNKNOWN';
  let monitorEnabled = true;
  let activeProtocol = 'NONE';
  let onlineProtocol = 'NONE';
  let batteryData = Object.create(null);
  let currentProtocol = null;
  let negotiationRaw = null;
  let negotiationLoadedAt = 0;
  let controlDetail = null;
  let currentPage = 'overview';
  let kernelSnapshot = null;
  let kernelBusy = false;

  const PROTOS = Object.freeze([
    {id: 'ufcs', key: 'UFCS'},
    {id: 'pps', key: 'PPS'},
  ]);
  const PROTO_LABEL = Object.freeze({ufcs: 'UFCS', pps: 'PPS'});
  const PROTO_DEFAULTS = Object.freeze({ufcs: {limitMv: 4560, voteMax: 9000}, pps: {limitMv: 4500, voteMax: 5000}});
  const protoState = {
    ufcs: {enabled: true, ...PROTO_DEFAULTS.ufcs, target: '—', busy: false},
    pps: {enabled: true, ...PROTO_DEFAULTS.pps, target: '—', busy: false},
  };
  const ADV_DEFAULTS = Object.freeze({voteInitial: 1000, intervalMs: 100, raiseStep: 100, lowerStep: 500, cutoffGapMv: -50});
  const advState = {...ADV_DEFAULTS};
  const advBusy = {voteInitial: false, intervalMs: false, raiseStep: false, lowerStep: false, cutoffGapMv: false};
  const ADV = Object.freeze({
    voteInitial: {min: 1000, max: 10000, el: 'advInitial', set: '--vote-initial-set', key: 'VOTE_INITIAL'},
    intervalMs: {min: 20, max: 200, el: 'advInterval', set: '--interval-set', key: 'INTERVAL_MS'},
    raiseStep: {min: 10, max: 500, el: 'advRaise', set: '--raise-step-set', key: 'RAISE_STEP'},
    lowerStep: {min: 100, max: 1000, el: 'advLower', set: '--lower-step-set', key: 'LOWER_STEP'},
    cutoffGapMv: {min: -100, max: 0, el: 'advGap', set: '--cutoff-gap-set', key: 'CUTOFF_GAP_MV'},
  });
  const LIMIT_MIN = 3800;
  const LIMIT_MAX = 4560;
  const VOTE_MAX_MIN = 1000;
  const VOTE_MAX_MAX = 13500;
  const PPS_VOTE_MAX_MAX = 5800;

  function showError(message) {
    const node = el('error');
    node.textContent = message;
    node.hidden = !message;
  }

  async function run(action) {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, action)) {
      throw new Error('不允许的操作');
    }
    if (!window.ksu || typeof window.ksu.exec !== 'function') {
      throw new Error('未检测到 KernelSU/SukiSU/APatch WebUI 接口，请在模块管理器内打开。');
    }
    return L.unwrapExecResponse(await window.ksu.exec(ALLOWED_COMMANDS[action]));
  }

  function setMetric(id, text, level) {
    const node = el(id);
    node.textContent = text;
    node.className = 'value' +
      (level === 'warning' ? ' warn-text' : level === 'danger' ? ' danger-text' :
        level === 'good' ? ' good-text' : '');
  }

  function voltage(raw) {
    if (!/^\d{7,8}$/.test(String(raw ?? ''))) return '—';
    const n = Number(raw);
    return n >= 1000000 && n <= 20000000 ? (n / 1000000).toFixed(3) + ' V' : '—';
  }

  function paintNegotiation() {
    if (!negotiationRaw) return;
    const target = protoState[activeProtocol.toLowerCase()]?.target ?? '—';
    const state = L.analyzeNegotiation(negotiationRaw, {
      protocolId:currentProtocol?.id,
      activeProtocol, controlState, targetRaw:target,
    });
    const format = (value, unit, digits = 2) =>
      value === null ? '—' : value.toFixed(digits) + ' ' + unit;
    el('negState').textContent = state.online === true
      ? 'USB 在线 · 与 ' + (currentProtocol?.name || '未知协议') + ' 状态交叉对照'
      : state.online === false ? 'USB 未连接，已隐藏上次充电的残留读数'
        : 'USB 在线状态未知，以下读数仅供参考';
    setMetric('negVoltage', format(state.voltageV, 'V'));
    setMetric('negInputLimit', format(state.inputLimitA, 'A'));
    setMetric('negVoltageMax', format(state.maxVoltageV, 'V'));
    setMetric('negTarget', state.online === true && controlState === 'RUNNING' && state.target !== null
      ? String(state.target) + ' mA' : '—');
    el('negUpdated').textContent = '只读 · 更新于 ' +
      new Date().toLocaleTimeString('zh-CN',{hour12:false});
  }

  async function refreshNegotiation() {
    const button = el('negRefresh');
    button.disabled = true;
    try {
      const raw = await run('negotiation');
      L.analyzeNegotiation(raw);
      negotiationRaw = raw;
      negotiationLoadedAt = Date.now();
      paintNegotiation();
      paintCurrentProtocol();
    } catch (error) {
      negotiationRaw = null;
      negotiationLoadedAt = 0;
      paintCurrentProtocol();
      for (const id of ['negVoltage','negInputLimit','negVoltageMax','negTarget']) setMetric(id, '—');
      el('negState').textContent = '协商数据不可用：' + String(error?.message || error);
      el('negUpdated').textContent = '只读 · 读取失败';
    } finally {
      button.disabled = false;
    }
  }

  async function refreshProtocol() {
    const result = L.identifyProtocol(await run('protocol'));
    currentProtocol = result;
    paintCurrentProtocol();
    el('protocolName').textContent = result.name;
    el('protocolBadge').textContent = result.confidence === '冲突'
      ? '状态冲突' : '可信度：' + result.confidence;
    el('protocolBadge').className = 'protocol-badge' +
      (result.id === 'UNKNOWN' ? ' warning' : result.confidence === '较高' ||
        result.confidence === '高' ? ' good' : '');
    el('protocolReason').textContent = result.reason;
    el('protocolSource').textContent = '检测来源：' + result.source;
    el('protocolEvidence').textContent = result.evidence;
    const list = el('protocolList');
    list.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const signal of result.signalRows) {
      const row = document.createElement('div');
      row.className = 'protocol-item' + (signal.active ? ' active' : '');
      const label = document.createElement('span');
      label.textContent = signal.name;
      const status = document.createElement('span');
      status.textContent = signal.state;
      row.append(label, status);
      fragment.appendChild(row);
    }
    list.appendChild(fragment);
  }

  async function refreshBattery() {
    const data = L.parseStatus(await run('battery'));
    batteryData = data;
    paintCurrentProtocol();
    if (!data.BATTERY_TEMP_DECI || !data.BATTERY_VOLTAGE_UV) {
      throw new Error('未获得电池温度或电压数据');
    }
    const t = data.BATTERY_TEMP_DECI;
    setMetric('tempState', L.temperature(t),
      /^\d+$/.test(t) && Number(t) >= 420 ? 'warning' : '');
    setMetric('voltageState', voltage(data.BATTERY_VOLTAGE_UV));
    setMetric('powerState', data.POWER === 'POWERED' ? '已连接充电器' :
      data.POWER === 'UNPLUGGED' ? '未连接充电器' : '未知');
  }

  function showVotesUnavailable(message) {
    el('voteEffective').textContent = '—';
    el('voteEffectiveInfo').textContent = '无法确认';
    const list = el('voteList');
    list.replaceChildren();
    const note = document.createElement('div');
    note.className = 'detail';
    note.textContent = message;
    list.appendChild(note);
  }

  async function refreshVotes() {
    const payload = L.decodeVotePayload(await run('votes'));
    const {effective, voters} = L.parseVotes(payload);
    if (!effective && voters.length === 0) {
      showVotesUnavailable('当前未识别到 UFCS 投票值，可能未进入 UFCS 充电状态。');
      return;
    }
    el('voteEffective').textContent = effective ? voteText(effective.raw) : '—';
    el('voteEffectiveInfo').textContent = effective
      ? '投票者 ' + effective.name + ' · 类型 ' + effective.type
      : '未识别有效投票行';
    const list = el('voteList');
    list.replaceChildren();
    if (!voters.length) {
      const note = document.createElement('div');
      note.className = 'detail';
      note.textContent = '未找到符合格式的普通投票项';
      list.appendChild(note);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of voters) {
      const row = document.createElement('div');
      row.className = 'vote-row';
      const name = document.createElement('span');
      name.className = 'vote-name';
      name.textContent = item.name;
      const value = document.createElement('span');
      value.className = 'vote-value';
      value.textContent = voteText(item.raw);
      const state = document.createElement('span');
      state.className = item.enabled ? 'vote-on' : 'vote-off';
      state.textContent = item.enabled ? '已启用' : '未启用';
      row.append(name, value, state);
      fragment.appendChild(row);
    }
    list.appendChild(fragment);
  }

  function displayRaw(value) {
    return /^-?\d+$/.test(String(value ?? '')) ? String(value) : '—';
  }

  function voteText(value) {
    return /^-?\d+$/.test(String(value ?? '')) ? String(value) + ' mA' : '—';
  }

  async function execControl(args) {
    if (!window.ksu || typeof window.ksu.exec !== 'function') {
      throw new Error('未检测到 KernelSU/SukiSU/APatch WebUI 接口，请在模块管理器内打开。');
    }
    return L.unwrapExecResponse(await window.ksu.exec('sh ' + CONTROL + ' ' + args));
  }

  function protoTagText(id) {
    const K = id.toUpperCase();
    const s = protoState[id];
    if (activeProtocol === K && controlState === 'RUNNING') return '控制中';
    if (onlineProtocol === K) return s.enabled ? '在线' : '在线 · 已关闭';
    return s.enabled ? '待机' : '已关闭';
  }

  function paintProto(id) {
    const K = id.toUpperCase();
    const s = protoState[id];
    el('protoSwitch' + K).checked = s.enabled;
    el('protoSwitch' + K).disabled = controlBusy || s.busy;
    el('protoState' + K).textContent = s.enabled ? '已开启' : '已关闭';
    const tag = el('protoTag' + K);
    tag.textContent = protoTagText(id);
    tag.className = 'proto-tag ' + (s.enabled ? 'on' : 'off');
    el('targetValue' + K).textContent = voteText(s.target);
    el('limitRange' + K).value = String(s.limitMv);
    if (document.activeElement !== el('limitInput' + K)) el('limitInput' + K).value = String(s.limitMv);
    el('limitValue' + K).textContent = String(s.limitMv);
    el('voteMaxRange' + K).value = String(s.voteMax);
    if (document.activeElement !== el('voteMaxInput' + K)) el('voteMaxInput' + K).value = String(s.voteMax);
    el('voteMaxValue' + K).textContent = String(s.voteMax);
    for (const prefix of ['limitRange','limitInput','voteMaxRange','voteMaxInput','protoReset']) {
      el(prefix + K).disabled = controlBusy || s.busy;
    }
  }

  async function resetProto(id) {
    const s = protoState[id];
    if (controlBusy || s.busy) return;
    const K = id.toUpperCase();
    const defaults = PROTO_DEFAULTS[id];
    s.busy = true;
    paintProto(id);
    el('protoSaveStatus' + K).textContent = '正在恢复默认…';
    try {
      await execControl('--limit-set ' + id + ' ' + defaults.limitMv);
      await execControl('--vote-max-set ' + id + ' ' + defaults.voteMax);
      const saved = L.parseStatus(await run('controlStatus'));
      if (saved[K + '_LIMIT_MV'] !== String(defaults.limitMv) || saved[K + '_VOTE_MAX'] !== String(defaults.voteMax)) {
        throw new Error('回读值不一致');
      }
      Object.assign(s, defaults);
      el('protoSaveStatus' + K).textContent = '已恢复默认并回读确认，重启后保留。';
      showError('');
    } catch (error) {
      const message = '恢复默认未完成，部分参数可能已保存：' + String(error?.message || error);
      el('protoSaveStatus' + K).textContent = message;
      showError(message);
    } finally {
      await safeControlRefresh();
      s.busy = false;
      paintProto(id);
    }
  }

  async function runLimit(id, raw) {
    if (controlBusy || protoState[id].busy) return;
    const K = id.toUpperCase();
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < LIMIT_MIN || n > LIMIT_MAX) {
      paintProto(id);
      return;
    }
    protoState[id].busy = true;
    el('limitRange' + K).disabled = true;
    el('limitInput' + K).disabled = true;
    el('limitRange' + K).value = String(n);
    el('limitInput' + K).value = String(n);
    el('limitValue' + K).textContent = String(n);
    try {
      await execControl('--limit-set ' + id + ' ' + n);
      protoState[id].limitMv = n;
      showError('');
      await safeControlRefresh();
    } catch (error) {
      showError(PROTO_LABEL[id] + ' 设定电压保存失败：' + String(error?.message || error));
      paintProto(id);
    } finally {
      protoState[id].busy = false;
      paintProto(id);
    }
  }

  async function runVoteMax(id, raw) {
    if (controlBusy || protoState[id].busy) return;
    const K = id.toUpperCase();
    const n = Math.round(Number(raw));
    const max = id === 'pps' ? PPS_VOTE_MAX_MAX : VOTE_MAX_MAX;
    if (!Number.isFinite(n) || n < VOTE_MAX_MIN || n > max) {
      paintProto(id);
      return;
    }
    protoState[id].busy = true;
    el('voteMaxRange' + K).disabled = true;
    el('voteMaxInput' + K).disabled = true;
    el('voteMaxRange' + K).value = String(n);
    el('voteMaxInput' + K).value = String(n);
    el('voteMaxValue' + K).textContent = String(n);
    try {
      await execControl('--vote-max-set ' + id + ' ' + n);
      protoState[id].voteMax = n;
      showError('');
      await safeControlRefresh();
    } catch (error) {
      showError(PROTO_LABEL[id] + ' 投票值上限保存失败：' + String(error?.message || error));
      paintProto(id);
    } finally {
      protoState[id].busy = false;
      paintProto(id);
    }
  }

  function paintAdv(field) {
    const meta = ADV[field];
    const v = advState[field];
    el(meta.el + 'Range').value = String(v);
    if (document.activeElement !== el(meta.el + 'Input')) el(meta.el + 'Input').value = String(v);
    el(meta.el + 'Value').textContent = String(v);
  }

  async function runAdv(field, raw) {
    if (advBusy[field]) return;
    const meta = ADV[field];
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < meta.min || n > meta.max) {
      paintAdv(field);
      return;
    }
    advBusy[field] = true;
    el('advReset').disabled = true;
    el(meta.el + 'Range').disabled = true;
    el(meta.el + 'Input').disabled = true;
    el(meta.el + 'Range').value = String(n);
    el(meta.el + 'Input').value = String(n);
    el(meta.el + 'Value').textContent = String(n);
    try {
      await execControl(meta.set + ' ' + n);
      const saved = L.parseStatus(await run('controlStatus'));
      if (saved[meta.key] !== String(n)) {
        throw new Error('回读值不一致，请检查是否有其它进程同时更新设置');
      }
      advState[field] = n;
      el('advSaveStatus').textContent = '✓ 已保存并回读确认：' +
        el(meta.el + 'Input').getAttribute('aria-label').replace('输入框','') +
        ' ' + n + '。保存于模块私有目录，重启后保留。';
      showError('');
      await safeControlRefresh();
    } catch (error) {
      el('advSaveStatus').textContent = '保存或回读失败：' +
        String(error?.message || error) + '。请刷新页面确认最终值。';
      showError('高级参数保存失败：' + String(error?.message || error));
      paintAdv(field);
    } finally {
      advBusy[field] = false;
      el('advReset').disabled = Object.values(advBusy).some(Boolean);
      el(meta.el + 'Range').disabled = false;
      el(meta.el + 'Input').disabled = false;
    }
  }

  async function resetAdv() {
    if (controlBusy || Object.values(advBusy).some(Boolean)) return;
    el('advReset').disabled = true;
    el('advSaveStatus').textContent = '正在恢复五项高级参数的默认值…';
    for (const field of Object.keys(ADV)) {
      advBusy[field] = true;
      el(ADV[field].el + 'Range').disabled = true;
      el(ADV[field].el + 'Input').disabled = true;
    }
    try {
      for (const field of Object.keys(ADV)) {
        await execControl(ADV[field].set + ' ' + ADV_DEFAULTS[field]);
      }
      const saved = L.parseStatus(await run('controlStatus'));
      for (const field of Object.keys(ADV)) {
        if (saved[ADV[field].key] !== String(ADV_DEFAULTS[field])) {
          throw new Error('回读值不一致，请检查是否有其它进程同时更新设置');
        }
      }
      Object.assign(advState, ADV_DEFAULTS);
      el('advSaveStatus').textContent = '✓ 五项高级参数已恢复默认并回读确认，重启后保留。';
      showError('');
    } catch (error) {
      const message = '恢复默认未完成，部分参数可能已保存：' +
        String(error?.message || error) + '。请检查当前值并重试。';
      el('advSaveStatus').textContent = message;
      showError(message);
    } finally {
      await safeControlRefresh();
      for (const field of Object.keys(ADV)) {
        advBusy[field] = false;
        paintAdv(field);
        el(ADV[field].el + 'Range').disabled = false;
        el(ADV[field].el + 'Input').disabled = false;
      }
      el('advReset').disabled = false;
    }
  }

  let votableRows = [];
  let votableLoadedAt = 0;
  let votableBusy = false;

  function renderVotables() {
    const category = el('votableCategory').value;
    const query = el('votableSearch').value.trim().toLowerCase();
    const filtered = votableRows.filter(item =>
      (category === 'all' || item.group === category) &&
      (!query || item.name.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.voters.some(voter => voter.name.toLowerCase().includes(query))));
    const host = el('votableGroups');
    const openNames = new Set([...host.querySelectorAll('details[open]')]
      .map(node => node.dataset.name));
    host.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'detail';
      empty.textContent = votableRows.length
        ? '没有符合筛选条件的目录。' : '没有可展示的投票目录。';
      host.appendChild(empty);
      return;
    }

    const groupFragment = document.createDocumentFragment();
    for (const group of L.votableGroups) {
      const list = filtered.filter(item => item.group === group.id);
      if (!list.length) continue;
      const section = document.createElement('section');
      const title = document.createElement('h3');
      title.className = 'votable-group-title';
      title.textContent = group.label + ' ';
      const count = document.createElement('span');
      count.textContent = list.length + ' 个';
      title.appendChild(count);
      section.appendChild(title);

      for (const item of list) {
        const card = document.createElement('details');
        card.className = 'votable-card';
        card.dataset.name = item.name;
        if (openNames.has(item.name)) card.open = true;
        const summary = document.createElement('summary');
        const label = document.createElement('div');
        const name = document.createElement('span');
        name.className = 'votable-title';
        name.textContent = item.name;
        const desc = document.createElement('span');
        desc.className = 'votable-desc';
        desc.textContent = item.description;
        label.append(name, desc);

        const value = document.createElement('div');
        value.className = 'votable-value';
        value.textContent = item.effective ? item.effective.raw : '—';
        const meta = document.createElement('span');
        meta.className = 'votable-meta';
        meta.textContent = (item.effective
          ? item.effective.type + ' · ' + item.effective.name
          : item.error || '无可识别有效投票') +
          (item.forceActive === '1' ? ' · 强制开' : '');
        value.appendChild(meta);
        summary.append(label, value);

        const detail = document.createElement('div');
        detail.className = 'votable-detail';
        const force = document.createElement('div');
        force.className = 'votable-force';
        for (const [caption, reading] of [
          ['force_active', item.forceActive === '1' ? '1 · 已开启' :
            item.forceActive === '0' ? '0 · 未开启' : '未知'],
          ['force_val', item.forceVal],
          ['投票类型', item.effective?.type || '未知'],
          ['普通有效投票', item.effective
            ? item.effective.name + ' · ' + item.effective.raw : '未获得'],
        ]) {
          const wrap = document.createElement('span');
          const bold = document.createElement('strong');
          bold.textContent = caption + '：';
          wrap.append(bold, document.createTextNode(reading));
          if (caption === 'force_active' && item.forceActive === '1') {
            wrap.className = 'danger-text';
          }
          force.appendChild(wrap);
        }
        detail.appendChild(force);

        if (item.voters.length) {
          const rows = document.createElement('div');
          rows.className = 'votable-voters';
          for (const voter of item.voters) {
            const row = document.createElement('div');
            row.className = 'vote-row';
            const voterName = document.createElement('span');
            voterName.className = 'vote-name';
            voterName.textContent = voter.name;
            const reading = document.createElement('span');
            reading.className = 'vote-value';
            reading.textContent = voter.raw;
            const enabled = document.createElement('span');
            enabled.className = voter.enabled ? 'vote-on' : 'vote-off';
            enabled.textContent = voter.enabled ? '已启用' : '未启用';
            row.append(voterName, reading, enabled);
            rows.appendChild(row);
          }
          detail.appendChild(rows);
        } else {
          const empty = document.createElement('p');
          empty.className = 'detail';
          empty.textContent = item.error ||
            '未读取到普通投票者，可能未启用或驱动使用其他格式。';
          detail.appendChild(empty);
        }
        card.append(summary, detail);
        section.appendChild(card);
      }
      groupFragment.appendChild(section);
    }
    host.appendChild(groupFragment);
  }

  async function refreshVotables() {
    if (votableBusy) return;
    votableBusy = true;
    const button = el('votableRefresh');
    button.disabled = true;
    button.textContent = '读取中…';
    el('votableSummary').textContent = '正在扫描驱动投票目录…';
    try {
      const raw = L.decodeVotablesPayload(await run('votables'));
      votableRows = L.parseVotables(raw);
      votableLoadedAt = Date.now();
      el('votableSummary').textContent = '已读取 ' + votableRows.length +
        ' 个目录 · ' + new Date().toLocaleTimeString('zh-CN', {hour12:false}) +
        ' · 所有数值均为只读快照';
      renderVotables();
      paintCurrentProtocol();
    } catch (error) {
      votableRows = [];
      votableLoadedAt = 0;
      el('votableGroups').replaceChildren();
      el('votableSummary').textContent = '读取失败：' + String(error?.message || error);
      paintCurrentProtocol();
    } finally {
      button.disabled = false;
      button.textContent = '读取全部目录';
      votableBusy = false;
    }
  }

  function paintCurrentProtocol() {
    // 隐藏诊断页时不反复重建 DOM，用户进入页面时再绘制当前缓存。
    if (el('page-diagnostics').hidden) return;
    const protocol = currentProtocol;
    const selection = L.protocolVoteSelection(protocol, votableRows);
    // 顶部诊断从快速单行快照读取，完全不依赖耗时的全目录扫描。
    const data = negotiationRaw ? L.parseStatus(negotiationRaw) : null;
    const matches = protocol && data && ['UFCS','PPS','VOOC'].includes(protocol.id) &&
      data.VOTE_PROTOCOL?.toUpperCase() === protocol.id;
    const fastPrimary = matches ? {
      name:protocol.id + '_CURR',
      description:'当前协议快速投票快照（不含完整投票者）',
      effective:/^-?\d+$/.test(data.VOTE_EFFECTIVE || '') ? {
        name:data.VOTE_OWNER || 'UNKNOWN', type:'驱动', raw:data.VOTE_EFFECTIVE,
      } : null,
      forceActive:data.VOTE_FORCE_ACTIVE || '?',
      forceVal:data.VOTE_FORCE_VAL || '?', voters:[],
    } : null;
    const primary = fastPrimary || selection.primary;
    const relatedRows = fastPrimary ? [fastPrimary,
      ...selection.rows.filter(item => item.name !== fastPrimary.name)] : selection.rows;
    const validVote = primary?.effective && primary.effective.name !== 'none' &&
      primary.effective.raw !== '-22';
    el('diagCurrentProtocol').textContent = protocol?.name || '协议状态不可用';
    const badge = el('diagProtocolConfidence');
    badge.textContent = protocol ? '可信度：' + protocol.confidence : '未知';
    badge.className = 'protocol-badge' +
      (!protocol || protocol.id === 'UNKNOWN' ? ' warning' : '');
    el('diagProtocolReason').textContent = protocol?.reason ||
      '当前无法读取充电协议信号，请检查 WebUI 权限或驱动节点。';
    el('diagProtocolSource').textContent = '检测来源：' + (protocol?.source || '未知');
    setMetric('diagPrimaryName', primary?.name || '—');
    setMetric('diagEffective', validVote ? primary.effective.raw : '—');
    setMetric('diagForceActive', primary?.forceActive === '1' ? '1 · 已开启' :
      primary?.forceActive === '0' ? '0 · 未开启' : '—',
      primary?.forceActive === '1' ? 'warning' : '');
    setMetric('diagForceVal', primary && /^-?\d+$/.test(primary.forceVal)
      ? primary.forceVal : '—');
    setMetric('diagBatteryCurrent', displayRaw(batteryData.BATTERY_CURRENT_RAW));
    const power = protocol ? L.parseStatus(protocol.evidence).POWER : 'UNKNOWN';
    setMetric('diagPower', power === 'YES' ? '已连接' :
      power === 'NO' ? '未连接' : '未知');
    el('diagProtocolHint').textContent = selection.note;

    const host = el('diagRelatedVotes');
    host.replaceChildren();
    const note = message => {
      const p = document.createElement('p');
      p.className = 'detail';
      p.textContent = message;
      host.appendChild(p);
    };
    if (!protocol) {
      note('协议读取失败，不使用可能属于旧协议的投票数据。');
    } else if (!selection.expected) {
      note('当前不展示任何协议专属投票。可在下方查看全部目录的只读快照。');
    } else if (!relatedRows.length) {
      note('当前协议暂未获得快速投票状态；需要完整投票者时可在下方手动读取全部目录。');
    } else {
      for (const item of relatedRows) {
        const row = document.createElement('div');
        row.className = 'protocol-vote-row';
        const heading = document.createElement('div');
        const title = document.createElement('strong');
        title.className = 'votable-title';
        title.textContent = item.name;
        const info = document.createElement('span');
        info.className = 'votable-desc';
        info.textContent = item.description;
        heading.append(title, info);
        const value = document.createElement('div');
        value.className = 'votable-value';
        const effective = item.effective;
        value.textContent = effective && effective.name !== 'none' &&
          effective.raw !== '-22' ? effective.raw : '—';
        const meta = document.createElement('span');
        meta.className = 'votable-meta';
        meta.textContent = effective
          ? effective.type + ' · ' + effective.name
          : item.error || '无可用有效投票';
        value.appendChild(meta);
        const flags = document.createElement('div');
        flags.className = 'detail protocol-vote-flags';
        flags.textContent = 'force_active=' + item.forceActive +
          ' · force_val=' + item.forceVal +
          ' · 已启用投票者 ' + item.voters.filter(v => v.enabled).length +
          '/' + item.voters.length;
        row.append(heading, value, flags);
        host.appendChild(row);
      }
    }
    el('diagSnapshot').textContent = (negotiationLoadedAt
      ? '快速快照：' +
        new Date(negotiationLoadedAt).toLocaleTimeString('zh-CN',{hour12:false})
      : '快速快照尚未读取') +
      (votableLoadedAt ? ' · 完整目录快照：' +
        new Date(votableLoadedAt).toLocaleTimeString('zh-CN',{hour12:false})
        : ' · 完整目录未扫描') + ' · 均为只读数据';
  }

  function paintKernelSnapshot(snapshot) {
    const {request, ageSeconds, exitedAfterRequest, lines} = snapshot;
    el('kernelRequest').textContent = request
      ? request.ibusMa + 'mA / ' + request.vbusMv + 'mV' : '—';
    const age = ageSeconds === null ? '时间无法确认'
      : '开机时间基准，距今 ' + ageSeconds + ' 秒';
    el('kernelRequestAge').textContent = request
      ? (exitedAfterRequest ? '之后已有 UFCS 退出/重置记录 · ' : '') +
        (ageSeconds !== null && ageSeconds > 12 ? '历史请求，不能代表当前 · ' : '') + age
      : '当前内核缓冲区没有可识别的成功请求';
    el('kernelEvents').textContent = lines.length
      ? lines.slice(-24).join('\n') : '没有匹配的 UFCS 内核事件，可能日志已轮转或读取权限受限。';
    el('kernelUpdated').textContent = '读取于 ' +
      new Date().toLocaleTimeString('zh-CN',{hour12:false});
  }

  async function readKernel() {
    if (kernelBusy) return;
    kernelBusy = true;
    el('kernelRead').disabled = true;
    el('kernelRead').textContent = '正在读取…';
    try {
      kernelSnapshot = L.parseKernelSnapshot(await run('kernelUfcs'));
      paintKernelSnapshot(kernelSnapshot);
    } catch (error) {
      el('kernelRequest').textContent = '—';
      el('kernelRequestAge').textContent = '内核日志不可用';
      el('kernelEvents').textContent = '读取失败：' + String(error?.message || error);
      kernelSnapshot = null;
    } finally {
      kernelBusy = false;
      el('kernelRead').disabled = false;
      el('kernelRead').textContent = '读取内核 UFCS 日志';
    }
  }

  async function copyDiagnostics() {
    const p = currentProtocol;
    const selected = L.protocolVoteSelection(p, votableRows);
    const lines = [
      '[oplus-votable current protocol diagnostics]',
      'protocol=' + (p?.id || 'UNKNOWN'),
      'protocol_name=' + (p?.name || 'UNKNOWN'),
      'confidence=' + (p?.confidence || 'UNKNOWN'),
      'detection_source=' + (p?.source || 'UNKNOWN'),
      'snapshot_time=' + (votableLoadedAt
        ? new Date(votableLoadedAt).toISOString() : 'UNKNOWN'),
      'battery_current_raw=' + (batteryData.BATTERY_CURRENT_RAW || 'UNKNOWN'),
      'control_state=' + controlState,
      'control_phase=' + controlPhase,
      'control_reason=' + controlReason,
      'active_protocol=' + activeProtocol,
      'online_protocol=' + onlineProtocol,
      'monitor_enabled=' + (monitorEnabled ? 'YES' : 'NO'),
      ...PROTOS.map(({id, key}) =>
        key.toLowerCase() + '_enabled=' + (protoState[id].enabled ? 'YES' : 'NO') +
        ' limit_mv=' + protoState[id].limitMv +
        ' vote_max=' + protoState[id].voteMax +
        ' target_raw=' + protoState[id].target),
      '[protocol evidence]',
      p?.evidence || 'UNAVAILABLE',
      '[related votables, raw values]',
      ...selected.rows.map(item =>
        item.name + ' effective=' + (item.effective?.raw ?? 'UNKNOWN') +
        ' voter=' + (item.effective?.name ?? 'UNKNOWN') +
        ' type=' + (item.effective?.type ?? 'UNKNOWN') +
        ' force_active=' + item.forceActive + ' force_val=' + item.forceVal),
    ];
    try {
      await copyText(lines.join('\n'));
      el('copyDiagnostics').textContent = '已复制';
      setTimeout(() => { el('copyDiagnostics').textContent = '复制当前协议诊断'; }, 1600);
    } catch (error) {
      showError('复制诊断失败：' + String(error?.message || error));
    }
  }

  const controlNames = {
    RUNNING: ['运行中', '本模块已建立控制租约，并按电压自适应调整投票值。', 'good'],
    STOPPED: ['未接管', '当前没有控制租约。', ''],
    STARTING: ['启动中', '正在确认内核控制状态，请勿重复操作。', 'warning'],
    STOPPING: ['停止中', '正在撤销本模块的控制状态。', 'warning'],
    RECOVERY_REQUIRED: ['需要检查', '控制租约存在，但运行状态无法确认。请检查日志和内核强制状态。', 'danger'],
    UNKNOWN: ['状态未知', '无法核对 oplus-votable 的控制状态。', 'warning'],
  };
  const phases = {
    IDLE: '空闲', RUNNING: '运行中', MONITOR_OFF: '监测已关闭',
    WAITING_PROTOCOL: '等待充电协议', PROTOCOL_DISABLED: '协议已关闭',
    PROTOCOL_CONFLICT: '协议冲突', OWNERSHIP_CHANGED: '强制状态被改变',
  };
  const reasons = {
    STARTED: '已检测到在线协议并自动接管。',
    ADJUSTED: '正在按电压自适应调整。',
    WAITING_PROTOCOL: '监测中：等待 UFCS / PPS 接入。',
    PROTOCOL_DISABLED: '检测到在线协议，但该协议开关已关闭，未接管。',
    UNSUPPORTED_PROTOCOL: '当前为 VOOC / SUPERVOOC，仅提供只读诊断，不进行电流控制。',
    PROTOCOL_CONFLICT: '同时检测到多个协议，为避免误操作未接管。',
    PROTOCOL_CHANGED: '协议已变化，已撤销控制，监测继续。',
    MONITOR_OFF: '自动监测已关闭。',
    OWNERSHIP_CHANGED: '强制状态被外部改变，已退出控制。',
    UNKNOWN: '控制状态正常。',
  };

  function paintControl(message = '') {
    const [name, detail, level] = controlNames[controlState] || controlNames.UNKNOWN;
    el('stateName').textContent = name;
    el('stateDetail').textContent = detail;
    el('stateDot').className = 'state-dot ' + level;
    el('phaseValue').textContent = phases[controlPhase] || controlPhase || '—';
    el('monitorSwitch').checked = monitorEnabled;
    el('monitorSwitch').disabled = controlBusy;
    el('monitorState').textContent = monitorEnabled ? '已开启' : '已关闭';
    for (const {id} of PROTOS) paintProto(id);
    for (const field of Object.keys(ADV)) if (!advBusy[field]) paintAdv(field);
    el('controlLease').textContent = controlState === 'RUNNING'
      ? '已确认本模块控制进程及 ' +
        (PROTO_LABEL[activeProtocol.toLowerCase()] || activeProtocol) + ' 驱动强制状态'
      : controlState === 'RECOVERY_REQUIRED'
        ? '控制状态异常：检测到残留租约' : '当前无控制租约';
    const text = message || reasons[controlReason] || '';
    if (text) {
      el('controlReadiness').textContent = text;
      el('controlReadiness').className = level === 'danger' ? 'danger-text' : 'detail';
    }
  }

  async function refreshControl() {
    const data = L.parseStatus(await run('controlStatus'));
    if (!Object.prototype.hasOwnProperty.call(controlNames, data.CONTROL_STATE)) {
      throw new Error('控制状态响应无法识别');
    }
    controlState = data.CONTROL_STATE;
    controlPhase = data.PHASE || 'IDLE';
    controlReason = data.REASON || 'UNKNOWN';
    monitorEnabled = data.MONITOR_ENABLED === 'YES';
    activeProtocol = data.ACTIVE_PROTOCOL || 'NONE';
    onlineProtocol = data.ONLINE_PROTOCOL || 'NONE';
    for (const {id, key} of PROTOS) {
      const s = protoState[id];
      s.enabled = data[key + '_ENABLED'] === 'YES';
      const lm = Number(data[key + '_LIMIT_MV']);
      if (Number.isFinite(lm) && lm >= LIMIT_MIN && lm <= LIMIT_MAX) s.limitMv = lm;
      const vm = Number(data[key + '_VOTE_MAX']);
      const max = id === 'pps' ? PPS_VOTE_MAX_MAX : VOTE_MAX_MAX;
      if (Number.isFinite(vm) && vm >= VOTE_MAX_MIN && vm <= max) s.voteMax = vm;
      s.target = activeProtocol === key && /^\d+$/.test(data.TARGET_RAW || '') &&
        data.TARGET_RAW !== '0' ? data.TARGET_RAW : '—';
    }
    for (const field of Object.keys(ADV)) {
      const meta = ADV[field];
      const n = Number(data[meta.key]);
      if (Number.isFinite(n) && n >= meta.min && n <= meta.max) advState[field] = n;
    }
    paintControl();
  }

  async function waitForControl(predicate) {
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      try {
        if (predicate(L.parseStatus(await run('controlStatus')))) break;
      } catch { /* 单次读取失败时继续等待 */ }
    }
  }

  async function toggleMonitor() {
    if (controlBusy) { paintControl(); return; }
    const enable = el('monitorSwitch').checked;
    controlBusy = true;
    el('monitorSwitch').disabled = true;
    el('controlReadiness').textContent = enable ? '正在开启自动监测…' : '正在关闭自动监测…';
    try {
      await run(enable ? 'monitorEnable' : 'monitorDisable');
      await waitForControl(data => (data.MONITOR_ENABLED === 'YES') === enable);
      showError('');
    } catch (error) {
      showError('自动监测操作失败：' + String(error?.message || error) +
        '。如出现异常，请检查日志并及时断开充电器。');
    } finally {
      controlBusy = false;
      await safeControlRefresh();
    }
  }

  async function toggleProto(id) {
    if (controlBusy || protoState[id].busy) { paintControl(); return; }
    const K = id.toUpperCase();
    const enable = el('protoSwitch' + K).checked;
    controlBusy = true;
    el('protoSwitch' + K).disabled = true;
    el('controlReadiness').textContent = enable
      ? '正在开启 ' + PROTO_LABEL[id] + ' 协议控制…'
      : '正在关闭 ' + PROTO_LABEL[id] + ' 协议控制…';
    try {
      await execControl((enable ? '--proto-enable ' : '--proto-disable ') + id);
      await waitForControl(data => (data[K + '_ENABLED'] === 'YES') === enable);
      showError('');
    } catch (error) {
      showError(PROTO_LABEL[id] + ' 协议开关操作失败：' + String(error?.message || error) +
        '。如出现异常，请检查日志并及时断开充电器。');
    } finally {
      controlBusy = false;
      await safeControlRefresh();
    }
  }

  async function safeControlRefresh() {
    try { await refreshControl(); } catch (error) {
      controlState = 'UNKNOWN';
      paintControl('无法读取控制状态：' + String(error?.message || error));
    }
  }

  function renderEntries() {
    const query = el('search').value.trim().toLowerCase();
    const warningsOnly = el('filter').value === 'warnings';
    const filtered = selectedEntries.filter(item => {
      if (warningsOnly && !item.warning) return false;
      return !query || item.raw.toLowerCase().includes(query) ||
        L.labelFor(item.state).includes(query);
    });
    el('count').textContent = filtered.length + ' / ' + selectedEntries.length + ' 条记录';
    const list = el('entries');
    list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = selectedEntries.length
        ? '没有符合筛选条件的记录' : '尚无 oplus-votable 控制事件';
      list.appendChild(empty);
      return filtered;
    }
    const fragment = document.createDocumentFragment();
    for (const item of filtered.slice().reverse()) {
      const row = document.createElement('article');
      row.className = 'entry';
      const title = document.createElement('div');
      title.className = 'entry-title';
      const chip = document.createElement('span');
      chip.className = 'chip ' + L.level(item.state);
      chip.textContent = L.labelFor(item.state);
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = L.timestamp(item.fields);
      title.append(chip, when);
      row.appendChild(title);
      const raw = document.createElement('code');
      raw.className = 'raw';
      raw.textContent = item.raw;
      row.appendChild(raw);
      fragment.appendChild(row);
    }
    list.appendChild(fragment);
    return filtered;
  }

  function controlEntries(raw) {
    return L.parseLines(raw).filter(item => item.state.startsWith('CONTROL_'));
  }

  async function refreshLogs() {
    if (logsBusy) return;
    logsBusy = true;
    const source = el('source').value === 'previous' ? 'previous' : 'latest';
    el('refresh').disabled = true;
    el('refresh').textContent = '读取中…';
    try {
      const [statusRaw, payload] = await Promise.all([run('status'), run(source)]);
      const status = L.parseStatus(statusRaw);
      if (!['RUNNING', 'STOPPED'].includes(status.WATCHDOG)) throw new Error('无法识别守护状态');
      if (source !== (el('source').value === 'previous' ? 'previous' : 'latest')) return;
      selectedEntries = controlEntries(L.decodeLogPayload(payload));
      renderEntries();
      el('fileSize').textContent = status.CURRENT_BYTES && status.CURRENT_BYTES !== '0'
        ? '日志 ' + status.CURRENT_BYTES + ' B' : '无控制记录';
      el('updated').textContent = '刷新于 ' + new Date().toLocaleTimeString('zh-CN', {hour12:false});
      showError('');
    } catch (error) {
      showError('日志读取：' + String(error?.message || error));
    } finally {
      logsBusy = false;
      el('refresh').disabled = false;
      el('refresh').textContent = '刷新';
      if (source !== (el('source').value === 'previous' ? 'previous' : 'latest')) await refreshLogs();
    }
  }

  async function refresh() {
    if (currentPage === 'logs') { await refreshLogs(); return; }
    if (busy || controlBusy) return;
    busy = true;
    el('refresh').disabled = true;
    el('refresh').textContent = '读取中…';
    const errors = [];
    try {
      try { await refreshControl(); } catch (error) {
        controlState = 'UNKNOWN';
        paintControl('无法读取控制状态');
        errors.push(String(error?.message || error));
      }
      try { await refreshProtocol(); } catch (error) {
        currentProtocol = null;
        paintCurrentProtocol();
        el('protocolName').textContent = '读取失败';
        el('protocolBadge').textContent = '未知';
        el('protocolBadge').className = 'protocol-badge warning';
        el('protocolReason').textContent = '无法读取协议状态，请检查内核节点或 WebUI 权限。';
        el('protocolSource').textContent = '检测来源：不可用';
        el('protocolEvidence').textContent = '协议识别失败';
        el('protocolList').textContent = '无法读取协议状态';
        errors.push('协议识别：' + String(error?.message || error));
      }
      try { await refreshBattery(); } catch (error) {
        batteryData = Object.create(null);
        paintCurrentProtocol();
        setMetric('tempState', '—');
        setMetric('voltageState', '—');
        setMetric('powerState', '未知');
        errors.push(String(error?.message || error));
      }
      await refreshNegotiation();
      if (currentPage === 'diagnostics') {
        try { await refreshVotes(); } catch (error) {
          showVotesUnavailable('投票值读取失败，请确认驱动节点可访问。');
          errors.push('投票值读取：' + String(error?.message || error));
        }
      }
      el('updated').textContent = '刷新于 ' +
        new Date().toLocaleTimeString('zh-CN', {hour12:false});
      showError(errors.join('\n'));
    } finally {
      busy = false;
      el('refresh').disabled = false;
      el('refresh').textContent = '刷新';
    }
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('当前 WebView 不支持复制');
  }

  async function copyVisible() {
    const rows = renderEntries();
    if (!rows.length) return;
    const value = rows.map(entry => entry.raw).join('\n');
    try {
      await copyText(value);
      el('copy').textContent = '已复制';
      setTimeout(() => { el('copy').textContent = '复制日志'; }, 1600);
    } catch (error) {
      showError('复制失败：' + String(error?.message || error));
    }
  }

  // 只改变当前 WebUI 的可见内容，不修改 URL/Hash 或 pushState。
  // 这样底部 Tab 与子页面切换均不堆叠历史，系统返回一次即可退出 WebUI。
  const PAGES = ['overview', 'control', 'diagnostics', 'logs'];
  const CONTROL_DETAILS = ['UFCS', 'PPS', 'advanced'];
  function showControlDetail(detail) {
    controlDetail = CONTROL_DETAILS.includes(detail) ? detail : null;
    el('control-index').hidden = controlDetail !== null;
    for (const id of CONTROL_DETAILS) {
      el('control-detail-' + id).hidden = controlDetail !== id;
    }
    el('bottomNav').hidden = controlDetail !== null;
    window.scrollTo(0, 0);
  }
  function switchPage(page) {
    if (!PAGES.includes(page)) page = 'overview';
    currentPage = page;
    showControlDetail(null);
    for (const name of PAGES) {
      const selected = name === page;
      el('page-' + name).hidden = !selected;
      const tab = el('tab-' + name);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    window.scrollTo(0, 0);
    // 诊断首屏只用已获取的协商快照，完整目录必须手动扫描。
    if (page === 'diagnostics') paintCurrentProtocol();
    if (page === 'logs') refreshLogs();
  }
  for (const [index, page] of PAGES.entries()) {
    const tab = el('tab-' + page);
    tab.addEventListener('click', () => switchPage(page));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = PAGES[(index + delta + PAGES.length) % PAGES.length];
      switchPage(next);
      el('tab-' + next).focus();
    });
  }
  for (const button of document.querySelectorAll('[data-detail]')) {
    button.addEventListener('click', () => showControlDetail(button.dataset.detail));
  }
  for (const button of document.querySelectorAll('[data-control-back]')) {
    button.addEventListener('click', () => showControlDetail(null));
  }
  switchPage('overview');

  el('votableRefresh').addEventListener('click', refreshVotables);
  el('negRefresh').addEventListener('click', refreshNegotiation);
  el('votableCategory').addEventListener('change', renderVotables);
  el('votableSearch').addEventListener('input', renderVotables);
  el('refresh').addEventListener('click', refresh);
  el('source').addEventListener('change', refresh);
  el('search').addEventListener('input', renderEntries);
  el('filter').addEventListener('change', renderEntries);
  el('copy').addEventListener('click', copyVisible);
  el('kernelRead').addEventListener('click', readKernel);
  el('copyDiagnostics').addEventListener('click', copyDiagnostics);
  el('monitorSwitch').addEventListener('change', toggleMonitor);
  el('advReset').addEventListener('click', resetAdv);
  for (const {id, key} of PROTOS) {
    el('protoReset' + key).addEventListener('click', () => resetProto(id));
    el('protoSwitch' + key).addEventListener('change', () => toggleProto(id));
    el('limitRange' + key).addEventListener('input', () => {
      const n = Number(el('limitRange' + key).value);
      el('limitInput' + key).value = String(n);
      el('limitValue' + key).textContent = String(n);
    });
    el('limitInput' + key).addEventListener('input', () => {
      const raw = el('limitInput' + key).value.trim();
      if (!/^\d+$/.test(raw)) return;
      const n = Number(raw);
      if (n < LIMIT_MIN || n > LIMIT_MAX) return;
      el('limitRange' + key).value = String(n);
      el('limitValue' + key).textContent = String(n);
    });
    el('limitRange' + key).addEventListener('change', () => runLimit(id, el('limitRange' + key).value));
    el('limitInput' + key).addEventListener('change', () => runLimit(id, el('limitInput' + key).value));
    el('voteMaxRange' + key).addEventListener('input', () => {
      const n = Number(el('voteMaxRange' + key).value);
      el('voteMaxInput' + key).value = String(n);
      el('voteMaxValue' + key).textContent = String(n);
    });
    el('voteMaxInput' + key).addEventListener('input', () => {
      const raw = el('voteMaxInput' + key).value.trim();
      if (!/^\d+$/.test(raw)) return;
      const n = Number(raw);
      if (n < VOTE_MAX_MIN || n > (id === 'pps' ? PPS_VOTE_MAX_MAX : VOTE_MAX_MAX)) return;
      el('voteMaxRange' + key).value = String(n);
      el('voteMaxValue' + key).textContent = String(n);
    });
    el('voteMaxRange' + key).addEventListener('change', () => runVoteMax(id, el('voteMaxRange' + key).value));
    el('voteMaxInput' + key).addEventListener('change', () => runVoteMax(id, el('voteMaxInput' + key).value));
  }
  for (const field of Object.keys(ADV)) {
    const meta = ADV[field];
    el(meta.el + 'Range').addEventListener('input', () => {
      const n = Number(el(meta.el + 'Range').value);
      el(meta.el + 'Input').value = String(n);
      el(meta.el + 'Value').textContent = String(n);
    });
    el(meta.el + 'Input').addEventListener('input', () => {
      const raw = el(meta.el + 'Input').value.trim();
      if (!/^-?\d+$/.test(raw)) return;
      const n = Number(raw);
      if (n < meta.min || n > meta.max) return;
      el(meta.el + 'Range').value = String(n);
      el(meta.el + 'Value').textContent = String(n);
    });
    el(meta.el + 'Range').addEventListener('change', () => runAdv(field, el(meta.el + 'Range').value));
    el(meta.el + 'Input').addEventListener('change', () => runAdv(field, el(meta.el + 'Input').value));
  }
  setInterval(() => {
    if (el('autoRefresh').checked && !document.hidden) refresh();
  }, 6000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && el('autoRefresh').checked) refresh();
  });
  refresh();
})();
