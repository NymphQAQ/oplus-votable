/**
 * 只用于离线建模多协议自适应限流的算法与状态判定，不负责向 Android 写节点。
 * UFCS / PPS 共用同一套算法，VOOC 不参与电流控制：
 *   投票值从「投票初始值」起步，每「监控时间」调整一次；
 *   电压 < 设定值 + 升流截止压差 -> 投票值 + 提升步进（最高为投票值上限）
 *   电压 > 设定值               -> 投票值 - 降低步进（最低 1000）
 *   设定值+截止压差..设定值      -> 保持不变
 * 设定电压按协议独立保存；UFCS 默认 4560/9000，PPS 默认 4500/5000、最高 5800；
 * 投票初始值、监控时间、提升/降低步进、升流截止压差为全局高级参数。温度限制当前未启用。
 */
export const PROTOCOLS = Object.freeze(['ufcs', 'pps']);

export const VOTE_MIN_RAW = 1000;

export const INITIAL_RAW = 1000;
export const INITIAL_MIN_RAW = 1000;
export const INITIAL_MAX_RAW = 10000;

export const DEFAULT_VOTE_MAX_RAW = 9000;
export const DEFAULT_PPS_VOTE_MAX_RAW = 5000;
export const PPS_VOTE_MAX_MAX_RAW = 5800;
export const VOTE_MAX_MIN_RAW = 1000;
export const VOTE_MAX_MAX_RAW = 13500;

export const DEFAULT_LIMIT_MV = 4560;
export const DEFAULT_PPS_LIMIT_MV = 4500;
export const LIMIT_MIN_MV = 3800;
export const LIMIT_MAX_MV = 4560;

export const RAISE_STEP_RAW = 100;
export const LOWER_STEP_RAW = 500;
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

/** 投票初始值夹到 1000..10000；非法值回落到默认 1000。 */
export function clampInitialRaw(raw) {
  return clampInt(raw, INITIAL_RAW, INITIAL_MIN_RAW, INITIAL_MAX_RAW);
}

/** 提升步进夹到 10..500；非法值回落到默认 100。 */
export function clampRaiseStep(raw) {
  return clampInt(raw, RAISE_STEP_RAW, RAISE_STEP_MIN_RAW, RAISE_STEP_MAX_RAW);
}

/** 降低步进夹到 100..1000；非法值回落到默认 500。 */
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

/** 设定电压夹到 3800..4560；非法值回落到默认 4560。 */
export function clampLimitMv(mv) {
  return clampInt(mv, DEFAULT_LIMIT_MV, LIMIT_MIN_MV, LIMIT_MAX_MV);
}

/** 投票值上限夹到 1000..13500；非法值回落到默认 9000。 */
export function clampVoteMax(raw) {
  return clampInt(raw, DEFAULT_VOTE_MAX_RAW, VOTE_MAX_MIN_RAW, VOTE_MAX_MAX_RAW);
}

/**
 * 依据当前电压（微伏）与当前参数计算下一步投票值。
 * voltageUv 非法时保持原值；超过设定值按降低步进回落，低于「设定值+截止压差」按提升步进上升，其余不变。
 * 结果始终收敛到 [VOTE_MIN_RAW, voteMax] 区间内。
 */
export function computeNextStep(state, voltageUv, params = {}) {
  let targetRaw = state.targetRaw;
  const limitMv = clampLimitMv(params.limitMv);
  const voteMax = clampVoteMax(params.voteMaxRaw);
  const raiseStep = clampRaiseStep(params.raiseStepRaw);
  const lowerStep = clampLowerStep(params.lowerStepRaw);
  const gapMv = clampCutoffGapMv(params.cutoffGapMv);
  const v = Number(voltageUv);
  if (!Number.isFinite(v) || v <= 0) {
    return { targetRaw: Math.min(targetRaw, voteMax), raised: false, lowered: false };
  }
  const limitUv = limitMv * 1000;
  const raiseBelowUv = limitUv + gapMv * 1000;
  let raised = false;
  let lowered = false;
  if (v > limitUv && targetRaw > VOTE_MIN_RAW) {
    targetRaw = Math.max(targetRaw - lowerStep, VOTE_MIN_RAW);
    lowered = true;
  } else if (v < raiseBelowUv && targetRaw < voteMax) {
    targetRaw = Math.min(targetRaw + raiseStep, voteMax);
    raised = true;
  }
  targetRaw = Math.min(targetRaw, voteMax);
  return { targetRaw, raised, lowered };
}
