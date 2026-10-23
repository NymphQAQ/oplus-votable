/**
 * 只用于离线建模多协议自适应限流的算法与状态判定，不负责向 Android 写节点。
 * UFCS / PPS 共用同一套算法，VOOC 不参与电流控制：
 *   投票值从「投票初始值」起步，每「监控时间」调整一次；
 *   电压 < 设定值 + 升流截止压差 -> 投票值 + 提升步进（最高为投票值上限）
 *   电压 > 设定值               -> 按实际经过周期降低投票值（最低 1000）
 *   设定值+截止压差..设定值      -> 保持不变
 * 设定电压按协议独立保存；UFCS 默认 4560/10900，PPS 默认 4460/5800、最高 5800；
 * 投票初始值、监控时间、提升/降低步进、升流截止压差为全局高级参数。
 * 此文件只建模单次电压决策；接管、间断恢复、升流等待和温控由 charge-test.sh 实现并以集成测试验证。
 */
export const PROTOCOLS = Object.freeze(['ufcs', 'pps']);

export const VOTE_MIN_RAW = 1000;

export const INITIAL_RAW = 2000;
export const INITIAL_MIN_RAW = 1000;
export const INITIAL_MAX_RAW = 10000;

export const DEFAULT_VOTE_MAX_RAW = 10900;
export const DEFAULT_PPS_VOTE_MAX_RAW = 5800;
export const PPS_VOTE_MAX_MAX_RAW = 5800;
export const VOTE_MAX_MIN_RAW = 1000;
export const VOTE_MAX_MAX_RAW = 13500;

export const DEFAULT_LIMIT_MV = 4560;
export const DEFAULT_PPS_LIMIT_MV = 4460;
export const LIMIT_MIN_MV = 3800;
export const LIMIT_MAX_MV = 4560;
export const UFCS_LIMIT_MAX_MV = 4660;

export const RAISE_STEP_RAW = 100;
export const LOWER_STEP_RAW = 1000;
export const RAISE_STEP_MIN_RAW = 10;
export const RAISE_STEP_MAX_RAW = 500;
export const LOWER_STEP_MIN_RAW = 100;
export const LOWER_STEP_MAX_RAW = 1000;

export const CUTOFF_GAP_MV = -50;
export const CUTOFF_GAP_MIN_MV = -100;
export const CUTOFF_GAP_MAX_MV = 0;

export const INTERVAL_MS = 100;
export const INTERVAL_MIN_MS = 20;
export const INTERVAL_MAX_MS = 200;

function clampInt(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 新会话的初始状态，起步值为「投票初始值」。 */
export function initialSession(initialRaw = INITIAL_RAW) {
  return { targetRaw: clampInitialRaw(initialRaw) };
}

/** 监测总开关开启、对应协议在线且该协议开关开启时才应接管。 */
export function shouldControl({ monitorOn, protoEnabled, protoOnline }) {
  return Boolean(monitorOn) && Boolean(protoEnabled) && Boolean(protoOnline);
}

/** 投票初始值夹到 1000..10000；非法值回落到默认 2000。 */
export function clampInitialRaw(raw) {
  return clampInt(raw, INITIAL_RAW, INITIAL_MIN_RAW, INITIAL_MAX_RAW);
}

/** 提升步进夹到 10..500；非法值回落到默认 100。 */
export function clampRaiseStep(raw) {
  return clampInt(raw, RAISE_STEP_RAW, RAISE_STEP_MIN_RAW, RAISE_STEP_MAX_RAW);
}

/** 降低步进夹到 100..1000；非法值回落到默认 1000。 */
export function clampLowerStep(raw) {
  return clampInt(raw, LOWER_STEP_RAW, LOWER_STEP_MIN_RAW, LOWER_STEP_MAX_RAW);
}

/** 升流截止压差夹到 -100..0；非法值回落到默认 -50。 */
export function clampCutoffGapMv(mv) {
  return clampInt(mv, CUTOFF_GAP_MV, CUTOFF_GAP_MIN_MV, CUTOFF_GAP_MAX_MV);
}

/** 监控时间夹到 20..200ms；非法值回落到默认 100。 */
export function clampIntervalMs(ms) {
  return clampInt(ms, INTERVAL_MS, INTERVAL_MIN_MS, INTERVAL_MAX_MS);
}

/** UFCS 设定电压最高 4660，PPS 最高 4560。 */
export function clampLimitMv(mv, protocol = 'ufcs') {
  return clampInt(mv, protocol === 'pps' ? DEFAULT_PPS_LIMIT_MV : DEFAULT_LIMIT_MV,
    LIMIT_MIN_MV, protocol === 'pps' ? LIMIT_MAX_MV : UFCS_LIMIT_MAX_MV);
}

/** 投票值上限夹到 1000..13500；非法值回落到默认 10900。 */
export function clampVoteMax(raw) {
  return clampInt(raw, DEFAULT_VOTE_MAX_RAW, VOTE_MAX_MIN_RAW, VOTE_MAX_MAX_RAW);
}

/**
 * 依据当前电压（微伏）与当前参数计算下一步投票值。
 * voltageUv 非法时限制到 1000；超过设定值按实际经过的监控周期降流，升流不补偿积欠步数。
 * 普通调节下限为 VOTE_MIN_RAW；温控后低于该值的目标仅在满足升流条件时逐步恢复。
 */
export function computeNextStep(state, voltageUv, params = {}) {
  let targetRaw = state.targetRaw;
  const limitMv = clampLimitMv(params.limitMv, params.protocol);
  const voteMax = clampVoteMax(params.voteMaxRaw);
  const raiseStep = clampRaiseStep(params.raiseStepRaw);
  const lowerStep = clampLowerStep(params.lowerStepRaw);
  const gapMv = clampCutoffGapMv(params.cutoffGapMv);
  const earlyGap = clampInt(params.earlyGapMv,-10,-50,0), earlyStep = clampInt(params.earlyStepMa,200,0,1000);
  const earlyOn = earlyGap<0 && earlyStep>0, now=Number(params.nowMs);
  let earlyHoldUntilMs=earlyOn ? state.earlyHoldUntilMs || 0 : 0;
  const v = Number(voltageUv);
  if (!Number.isFinite(v) || v < 1_000_000 || v > 20_000_000) {
    const limited = Math.min(targetRaw, VOTE_MIN_RAW, voteMax);
    return { targetRaw: limited, raised: false, lowered: limited < targetRaw };
  }
  const limitUv = limitMv * 1000;
  const raiseBelowUv = limitUv + gapMv * 1000;
  let raised = false;
  let lowered = false;
  if (v > limitUv && targetRaw > VOTE_MIN_RAW) {
    const elapsed = Number(params.elapsedMs);
    const steps = Number.isFinite(elapsed) ? Math.max(1, Math.floor(elapsed / clampIntervalMs(params.intervalMs))) : 1;
    targetRaw = Math.max(targetRaw - lowerStep * Math.min(steps, Math.ceil((targetRaw - VOTE_MIN_RAW) / lowerStep)), VOTE_MIN_RAW);
    lowered = true;
  } else if (earlyOn && v>=limitUv+earlyGap*1000 && v<=limitUv) {
    if (!Number.isSafeInteger(now) || now<=0) targetRaw=Math.min(targetRaw,VOTE_MIN_RAW);
    else if (now>=earlyHoldUntilMs && targetRaw>VOTE_MIN_RAW) {
      targetRaw=Math.max(VOTE_MIN_RAW,targetRaw-earlyStep);
      earlyHoldUntilMs=now+clampInt(params.cvWaitMs,1500,200,10000);
    }
    lowered=targetRaw<state.targetRaw;
  } else if (v < raiseBelowUv && targetRaw < voteMax && (!earlyOn || now>=earlyHoldUntilMs)) {
    targetRaw = Math.min(targetRaw + raiseStep, voteMax);
    raised = true;
  }
  targetRaw = Math.min(targetRaw, voteMax);
  return { targetRaw, raised, lowered, ...(earlyOn ? {earlyHoldUntilMs} : {}) };
}

/** 后段电压反馈参数独立保存；较小的当前区间步进仍然优先。 */
export function computeCvStep(state, voltageUv, params = {}) {
  const now = Number(params.nowMs), v = Number(voltageUv);
  const limit = clampLimitMv(params.limitMv, params.protocol);
  const goal = (limit + clampInt(params.cvOffsetMv,-5,-50,0)) * 1000;
  const band = clampInt(params.cvBandMv,5,1,15)*1000;
  const rise = clampInt(params.cvRaiseMa,50,10,500), fall = clampInt(params.cvLowerMa,100,10,1000);
  const wait = clampInt(params.cvWaitMs,1500,200,10000);
  const fastGap = clampInt(params.cvFastGapMv,15,0,50);
  const earlyGap = clampInt(params.earlyGapMv,-10,-50,0), earlyStep = clampInt(params.earlyStepMa,200,0,1000);
  let targetRaw = Math.min(state.targetRaw, clampVoteMax(params.voteMaxRaw));
  let nextAdjustMs = state.nextAdjustMs || 0;
  if (!Number.isSafeInteger(now) || now <= 0) targetRaw = Math.min(targetRaw, VOTE_MIN_RAW);
  else if (!Number.isFinite(v) || v < 1000000 || v > 20000000 || (v > limit * 1000 && v >= (limit + fastGap) * 1000)) {
    targetRaw = computeNextStep({targetRaw}, voltageUv, params).targetRaw;
  } else if (earlyGap<0 && earlyStep>0 && v>=(limit+earlyGap)*1000 && v<=limit*1000) {
    if (now>=nextAdjustMs && targetRaw>VOTE_MIN_RAW) targetRaw=Math.max(VOTE_MIN_RAW,targetRaw-earlyStep);
  } else if (now >= nextAdjustMs && (!params.full || v > limit * 1000)) {
    if ((v > limit * 1000 || v > goal + band) && targetRaw > VOTE_MIN_RAW) targetRaw = Math.max(VOTE_MIN_RAW, targetRaw - Math.min(fall, clampLowerStep(params.lowerStepRaw)));
    else if (v < goal - band && params.allowRaise !== false) targetRaw = Math.min(clampVoteMax(params.voteMaxRaw), targetRaw + Math.min(rise, clampRaiseStep(params.raiseStepRaw)));
  }
  if (targetRaw !== state.targetRaw && now > 0) nextAdjustMs = now + wait;
  return {targetRaw, nextAdjustMs};
}
