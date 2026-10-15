#!/system/bin/sh
# 自适应多协议电流控制：仅 UFCS / PPS；VOOC 仅保留旧租约撤销兼容。
#   监测总开关开启、对应协议在线、且该协议开关开启时，接管其 *_CURR 投票节点。
#   投票值从「投票初始值」起步，每「监控时间」检查一次：
#     电压 < 设定值 + 升流截止压差 -> 投票值 + 提升步进（最高为投票值上限）
#     电压 > 设定值               -> 投票值 - 降低步进（最低 1000）
#     设定值+截止压差..设定值      -> 保持不变
# 设定电压按协议独立保存：UFCS 默认 4560，PPS 默认 4500，范围 3800..4560。
# UFCS 投票上限默认 9000 / 最高 13500；PPS 默认 5000 / 最高 5800。
# 高级参数（投票初始值、监控时间、提升/降低步进、升流截止压差）全局共用。
# 协议不再在线、对应开关关闭或监测关闭时立即撤销限流并入日志。
# 温控读取真实电池温度，超温或读温失败时限流，降温后按恢复温差解除。
set -u
umask 077
D='/data/adb/oplus-votable'
L="$D/active-test.lease"
K="$D/.control-lock"
DK="$D/.control-daemon.lock"
MON="$D/auto-control.monitor"
LIVE="$D/auto-live"
INITF="$D/auto-control.vote-initial"
IVLF="$D/auto-control.interval-ms"
RSTEPF="$D/auto-control.raise-step"
LSTEPF="$D/auto-control.lower-step"
GAPF="$D/auto-control.cutoff-gap-mv"
TENF="$D/auto-control.thermal-enabled"
TLIMF="$D/auto-control.thermal-limit-c"
TVOTEF="$D/auto-control.thermal-vote-ma"
TGAPF="$D/auto-control.thermal-gap-c"
DEFAULT_THERMAL_LIMIT=45
DEFAULT_THERMAL_VOTE=1000
DEFAULT_THERMAL_GAP=2
thermal_state=OFF
thermal_held=0
thermal_sample_at=-1
thermal_temp=''
VOTE_MIN=1000
DEFAULT_INITIAL=1000
INITIAL_MIN=1000
INITIAL_MAX=10000
DEFAULT_INTERVAL=100
INTERVAL_MIN=20
INTERVAL_MAX=200
DEFAULT_RAISE_STEP=100
RAISE_STEP_MIN=10
RAISE_STEP_MAX=500
DEFAULT_LOWER_STEP=500
LOWER_STEP_MIN=100
LOWER_STEP_MAX=1000
DEFAULT_GAP=-50
GAP_MIN=-100
GAP_MAX=0
DEFAULT_VOTE_MAX=9000
DEFAULT_PPS_VOTE_MAX=5000
VOTE_MAX_MIN=1000
VOTE_MAX_MAX=13500
PPS_VOTE_MAX_MAX=5800
DEFAULT_LIMIT_MV=4560
DEFAULT_PPS_LIMIT_MV=4500
LIMIT_MIN_MV=3800
LIMIT_MAX_MV=4560
CMD="${1:---status}"
[ "$#" -le 3 ] || exit 2

log() {
  printf '%s\n' "$1"
  if [ -d "$D" ]; then
    printf 'epoch=%s state=CONTROL_%s write=ADAPTIVE\n' "$(date +%s)" "$1" >> "$D/events.log"
  fi
}
fail() { log "BLOCKED_$1"; exit 3; }
num() {
  case "$1" in ''|*[!0-9]*) return 1;; esac
  [ "${#1}" -le 10 ]
}
# 可带负号的有符号整数（用于升流截止压差）。
snum() {
  case "$1" in
    ''|'-') return 1;;
    -*) num "${1#-}";;
    *) num "$1";;
  esac
}
uptime_s() { awk '{split($1,a,".");print a[1]}' /proc/uptime 2>/dev/null; }
readbit() {
  b="$(cat "$1" 2>/dev/null)" || return 1
  [ "$b" = 0 ] || [ "$b" = 1 ] || return 1
  printf '%s' "$b"
}
boot_id() { cat /proc/sys/kernel/random/boot_id 2>/dev/null; }

# 旧版可能留下 VOOC 租约：只允许校验并撤销，不允许新建 VOOC 控制。
valid_proto() { case "$1" in ufcs|vooc|pps) return 0;; *) return 1;; esac; }
control_proto() { case "$1" in ufcs|pps) return 0;; *) return 1;; esac; }
proto_key() { case "$1" in ufcs) printf 'UFCS';; vooc) printf 'VOOC';; pps) printf 'PPS';; *) printf 'NONE';; esac; }
proto_node() {
  case "$1" in
    ufcs) printf '/proc/oplus-votable/UFCS_CURR';;
    vooc) printf '/proc/oplus-votable/VOOC_CURR';; # 旧租约清理专用
    pps)  printf '/proc/oplus-votable/PPS_CURR';;
    *) return 1;;
  esac
}
# 只读协议在线位：MMS item_id 必须为 0 且 data 为 1。
proto_online() {
  valid_proto "$1" || return 1
  [ "$(cat "/sys/class/oplus_mms/$1/item_id" 2>/dev/null)" = 0 ] || return 1
  [ "$(cat "/sys/class/oplus_mms/$1/data" 2>/dev/null)" = 1 ] || return 1
}
proto_config() { printf '%s/auto-control.%s.%s' "$D" "$1" "$2"; }
# 协议开关：文件缺失或缺省即视为开，只有显式 off 才是关。
proto_on() { [ "$(cat "$(proto_config "$1" enabled)" 2>/dev/null)" != 'off' ]; }
# 该协议的设定电压（mV）：缺失或越界回落到各自默认值。
proto_limit_mv() {
  v="$(cat "$(proto_config "$1" limit-mv)" 2>/dev/null)"
  if num "$v" && [ "$v" -ge "$LIMIT_MIN_MV" ] && [ "$v" -le "$LIMIT_MAX_MV" ]; then
    printf '%s' "$v"
  else
    if [ "$1" = pps ]; then printf '%s' "$DEFAULT_PPS_LIMIT_MV"; else printf '%s' "$DEFAULT_LIMIT_MV"; fi
  fi
}
# PPS 最大不得超过 5800；历史 PPS 配置 >5800 时只在运行时夹到 5800。
# 已有 1000..5800 的用户配置保留，不强制改写存储。
proto_vote_max() {
  v="$(cat "$(proto_config "$1" vote-max)" 2>/dev/null)"
  max="$VOTE_MAX_MAX"
  default="$DEFAULT_VOTE_MAX"
  if [ "$1" = pps ]; then max="$PPS_VOTE_MAX_MAX"; default="$DEFAULT_PPS_VOTE_MAX"; fi
  if num "$v" && [ "$v" -ge "$VOTE_MAX_MIN" ]; then
    [ "$v" -le "$max" ] || v="$max"
    printf '%s' "$v"
  else
    printf '%s' "$default"
  fi
}
# 高级参数：文件缺失或越界时回落到默认值。
file_num() {
  v="$(cat "$1" 2>/dev/null)"
  if num "$v" && [ "$v" -ge "$3" ] && [ "$v" -le "$4" ]; then
    printf '%s' "$v"
  else
    printf '%s' "$2"
  fi
}
file_snum() {
  v="$(cat "$1" 2>/dev/null)"
  if snum "$v" && [ "$v" -ge "$3" ] && [ "$v" -le "$4" ]; then
    printf '%s' "$v"
  else
    printf '%s' "$2"
  fi
}
# 参数保存在模块独立数据目录，避免模块更新/重启覆盖；同目录原子替换后回读确认。
save_setting() {
  path="$1"
  value="$2"
  temp="$path.tmp.$$"
  if ! printf '%s\n' "$value" > "$temp"; then
    rm -f "$temp" 2>/dev/null || :
    return 1
  fi
  if ! mv -f "$temp" "$path"; then
    rm -f "$temp" 2>/dev/null || :
    return 1
  fi
  [ "$(cat "$path" 2>/dev/null)" = "$value" ]
}
initial_raw() { file_num "$INITF" "$DEFAULT_INITIAL" "$INITIAL_MIN" "$INITIAL_MAX"; }
interval_ms() { file_num "$IVLF" "$DEFAULT_INTERVAL" "$INTERVAL_MIN" "$INTERVAL_MAX"; }
raise_step() { file_num "$RSTEPF" "$DEFAULT_RAISE_STEP" "$RAISE_STEP_MIN" "$RAISE_STEP_MAX"; }
lower_step() { file_num "$LSTEPF" "$DEFAULT_LOWER_STEP" "$LOWER_STEP_MIN" "$LOWER_STEP_MAX"; }
cutoff_gap() { file_snum "$GAPF" "$DEFAULT_GAP" "$GAP_MIN" "$GAP_MAX"; }
thermal_on() { [ "$(cat "$TENF" 2>/dev/null)" = on ]; }
thermal_setting() {
  value="$(file_num "$@")"
  # 去掉历史文件中的前导零，避免 Shell 算术将其当作八进制。
  while [ "${value#0}" != "$value" ]; do value="${value#0}"; done
  printf '%s' "$value"
}
thermal_limit() { thermal_setting "$TLIMF" "$DEFAULT_THERMAL_LIMIT" 20 60; }
thermal_vote() { thermal_setting "$TVOTEF" "$DEFAULT_THERMAL_VOTE" 500 5000; }
thermal_gap() { thermal_setting "$TGAPF" "$DEFAULT_THERMAL_GAP" 1 5; }
temperature_now() {
  temperature="$(cat /sys/class/power_supply/battery/temp 2>/dev/null)" || return 1
  snum "$temperature" && [ "$temperature" -ge -500 ] && [ "$temperature" -le 1500 ] || return 1
  printf '%s' "$temperature"
}
thermal_update() {
  previous_thermal="$thermal_state"
  if ! thermal_on; then
    thermal_state=OFF
    thermal_held=0
    thermal_sample_at=-1
  else
    sample_now="$(uptime_s)"
    if ! num "$sample_now" || [ "$thermal_sample_at" != "$sample_now" ]; then
      thermal_temp="$(temperature_now)" || thermal_temp=''
      thermal_sample_at="$sample_now"
    fi
    tlimit="$(thermal_limit)"
    tgap="$(thermal_gap)"
    if ! snum "$thermal_temp"; then
      thermal_state=SENSOR_ERROR
      thermal_held=1
    else
      if [ "$thermal_temp" -ge "$((tlimit * 10))" ]; then
        thermal_held=1
      elif [ "$thermal_temp" -le "$(((tlimit - tgap) * 10))" ]; then
        thermal_held=0
      fi
      thermal_state=NORMAL
      [ "$thermal_held" -eq 0 ] || thermal_state=LIMITED
    fi
  fi
  if [ "$thermal_state" != "$previous_thermal" ]; then log "THERMAL_$thermal_state"; fi
}
thermal_clamp() {
  [ "$thermal_held" -eq 1 ] || return 0
  thermal_cap="$(thermal_vote)"
  # 读温失败时不得因测试限流值较高而放宽到 1000mA 以上。
  if [ "$thermal_state" = SENSOR_ERROR ] && [ "$thermal_cap" -gt 1000 ]; then thermal_cap=1000; fi
  [ "$target" -le "$thermal_cap" ] || target="$thermal_cap"
}
thermal_status() {
  ten=NO; thermal_on && ten=YES
  ts=OFF
  if [ "$ten" = YES ]; then
    ts=IDLE
    if monitor_on && daemon_running; then
      case "$(live_get "$LIVE" THERMAL_STATE)" in
        NORMAL) ts=NORMAL;; LIMITED) ts=LIMITED;; SENSOR_ERROR) ts=SENSOR_ERROR;;
      esac
    fi
  fi
  ta=NO
  if [ "$ten" = YES ] && [ "$(live_get "$LIVE" PHASE)" = RUNNING ] && monitor_on && daemon_running; then ta=YES; fi
  tt="$(temperature_now)" || tt=UNKNOWN
  printf 'THERMAL_ENABLED=%s;THERMAL_LIMIT_C=%s;THERMAL_VOTE_MA=%s;THERMAL_GAP_C=%s;THERMAL_TEMP_DECI=%s;THERMAL_STATE=%s;THERMAL_ACTIVE=%s\n' \
    "$ten" "$(thermal_limit)" "$(thermal_vote)" "$(thermal_gap)" "$tt" "$ts" "$ta"
}
interval_s() { awk -v m="$1" 'BEGIN { printf "%.3f", m/1000 }'; }
voltage_now() {
  voltage="$(cat /sys/class/power_supply/battery/voltage_now 2>/dev/null)" || return 1
  num "$voltage" || return 1
  printf '%s' "$voltage"
}
# 总开关「自动监测」：文件缺失或缺省即视为开，只有显式 off 才是关。
monitor_on() { [ "$(cat "$MON" 2>/dev/null)" != 'off' ]; }
write_live() {
  [ -d "$D" ] || return 0
  printf 'PHASE=%s\nPROTO=%s\nTARGET=%s\nREASON=%s\nTHERMAL_STATE=%s\nTHERMAL_BOOT=%s\n' \
    "$1" "$4" "$2" "$3" "$thermal_state" "$(boot_id)" > "$LIVE.tmp.$$" 2>/dev/null &&
    mv -f "$LIVE.tmp.$$" "$LIVE" 2>/dev/null || :
}
live_get() { awk -F'=' -v k="$2" '$1==k{print $2; exit}' "$1" 2>/dev/null; }
unlock() {
  owner="$(cat "$K/owner" 2>/dev/null || echo '')"
  if [ "$owner" = "$(boot_id):$$" ]; then
    rm -f "$K/owner" 2>/dev/null || :
    rmdir "$K" 2>/dev/null || :
  fi
}
lock() {
  thisboot="$(boot_id)" || return 1
  if ! mkdir "$K" 2>/dev/null; then
    owner="$(cat "$K/owner" 2>/dev/null || echo '')"
    lockboot="${owner%%:*}"
    lockpid="${owner#*:}"
    if [ "$lockboot" = "$thisboot" ] && num "$lockpid" && kill -0 "$lockpid" 2>/dev/null; then
      return 1
    fi
    # 进程已退出或来自其它 boot 时，才回收遗留的本模块控制锁。
    rm -f "$K/owner" 2>/dev/null || return 1
    rmdir "$K" 2>/dev/null || return 1
    mkdir "$K" 2>/dev/null || return 1
  fi
  printf '%s:%s\n' "$thisboot" "$$" > "$K/owner" || return 1
}
# 读取本模块 5 字段租约：boot-id start-uptime pid target proto。
lease_valid() {
  [ -f "$L" ] || return 1
  set -- $(cat "$L" 2>/dev/null)
  [ "$#" -eq 5 ] || return 1
  [ "$1" = "$(boot_id)" ] || return 1
  num "$2" && num "$3" && num "$4" && valid_proto "$5"
}
# 撤销本模块自己的限流：按租约记录的协议节点，只校验租约与 force_val。
revoke_own() {
  lease_valid || return 1
  set -- $(cat "$L" 2>/dev/null)
  expected="$4"
  node="$(proto_node "$5")" || return 1
  [ "$(cat "$node/force_val" 2>/dev/null)" = "$expected" ] || return 1
  state="$(readbit "$node/force_active")" || return 1
  if [ "$state" = 1 ]; then
    printf '0' > "$node/force_active" || return 1
    [ "$(readbit "$node/force_active")" = 0 ] || return 1
  fi
  rm -f "$L" || return 1
  log 'REVOKE_REQUESTED_CALLBACK_UNVERIFIED'
}
daemon_running() {
  [ -f "$DK/owner" ] || return 1
  owner="$(cat "$DK/owner" 2>/dev/null || echo '')"
  dboot="${owner%%:*}"
  dpid="${owner#*:}"
  [ "$dboot" = "$(boot_id)" ] || return 1
  num "$dpid" || return 1
  kill -0 "$dpid" 2>/dev/null
}
daemon_lock() {
  thisboot="$(boot_id)" || return 1
  if ! mkdir "$DK" 2>/dev/null; then
    daemon_running && return 1
    rm -f "$DK/owner" 2>/dev/null || return 1
    rmdir "$DK" 2>/dev/null || return 1
    mkdir "$DK" 2>/dev/null || return 1
  fi
  printf '%s:%s\n' "$thisboot" "$$" > "$DK/owner" || return 1
  trap daemon_unlock EXIT
}
daemon_unlock() {
  owner="$(cat "$DK/owner" 2>/dev/null || echo '')"
  if [ "$owner" = "$(boot_id):$$" ]; then
    rm -f "$DK/owner" 2>/dev/null || :
    rmdir "$DK" 2>/dev/null || :
  fi
}
ensure_daemon() {
  daemon_running && return 0
  nohup sh "$0" --control-run >/dev/null 2>&1 </dev/null &
  return 0
}
# 常驻控制循环：监测总开关开启即存活；关闭时撤销并退出（不常驻）。
control_run() {
  mkdir -p "$D" || exit 4
  daemon_lock || exit 0
  trap 'unlock; daemon_unlock' EXIT
  owning=0
  target=0
  proto=''
  if [ "$(live_get "$LIVE" THERMAL_BOOT)" = "$(boot_id)" ]; then
    case "$(live_get "$LIVE" THERMAL_STATE)" in LIMITED|SENSOR_ERROR) thermal_held=1;; esac
  fi
  while :; do
    ivl="$(interval_s "$(interval_ms)")"
    thermal_update
    if ! monitor_on; then
      if [ "$owning" -eq 1 ]; then
        revoke_own && log 'FINISHED_MONITOR_DISABLED' || log 'RECOVERY_REQUIRED_MONITOR_DISABLED'
        unlock
        owning=0
        proto=''
      fi
      write_live IDLE 0 MONITOR_OFF ''
      break
    fi
    # 当前在线的协议；仅当「有且仅有一个」且该协议开关开启时才接管。
    ap=''
    online=0
    for p in ufcs vooc pps; do
      if proto_online "$p"; then online=$((online + 1)); ap="$p"; fi
    done
    if [ "$online" -ne 1 ] || ! control_proto "$ap" || ! proto_on "$ap"; then
      if [ "$owning" -eq 1 ]; then
        if [ "$online" -eq 1 ]; then
          revoke_own && log 'FINISHED_PROTOCOL_DISABLED' || log 'RECOVERY_REQUIRED_PROTOCOL_DISABLED'
        else
          revoke_own && log 'FINISHED_PROTOCOL_CHANGED' || log 'RECOVERY_REQUIRED_PROTOCOL_CHANGED'
        fi
        unlock
        owning=0
        proto=''
      fi
      if [ "$online" -eq 0 ]; then
        write_live IDLE 0 WAITING_PROTOCOL ''
      elif [ "$online" -gt 1 ]; then
        write_live IDLE 0 PROTOCOL_CONFLICT ''
      elif ! control_proto "$ap"; then
        write_live IDLE 0 UNSUPPORTED_PROTOCOL "$ap"
      else
        write_live IDLE 0 PROTOCOL_DISABLED "$ap"
      fi
      sleep "$ivl"
      continue
    fi
    if [ "$owning" -eq 1 ] && [ "$proto" != "$ap" ]; then
      revoke_own && log 'FINISHED_PROTOCOL_CHANGED' || log 'RECOVERY_REQUIRED_PROTOCOL_CHANGED'
      unlock
      owning=0
      proto=''
    fi
    # revoke_own 会读取旧租约并更新 node，撤销后重新选择当前协议节点。
    node="$(proto_node "$ap")"
    if [ "$owning" -eq 0 ]; then
      if lock; then
        target="$(initial_raw)"
        # 首次写入也受协议上限和温控限制，避免先写入较高初始值。
        max="$(proto_vote_max "$ap")"
        [ "$target" -le "$max" ] || target="$max"
        thermal_clamp
        if printf '%s %s %s %s %s\n' "$(boot_id)" "$(uptime_s)" "$$" "$target" "$ap" > "$L" &&
           printf '%s' "$target" > "$node/force_val" 2>/dev/null &&
           printf '1' > "$node/force_active" 2>/dev/null &&
           [ "$(readbit "$node/force_active")" = 1 ]; then
          owning=1
          proto="$ap"
          log "START_ADAPTIVE_$target"
          write_live RUNNING "$target" STARTED "$ap"
        else
          revoke_own 2>/dev/null || rm -f "$L" 2>/dev/null || :
          unlock
        fi
      fi
    else
      prev_target=$target
      lmv="$(proto_limit_mv "$ap")"
      vm="$(proto_vote_max "$ap")"
      rstep="$(raise_step)"
      lstep="$(lower_step)"
      gap="$(cutoff_gap)"
      luv=$((lmv * 1000))
      raise_uv=$((luv + gap * 1000))
      v="$(voltage_now)" || v=''
      if num "$v"; then
        if [ "$v" -gt "$luv" ] && [ "$target" -gt "$VOTE_MIN" ]; then
          target=$((target - lstep))
          [ "$target" -ge "$VOTE_MIN" ] || target=$VOTE_MIN
        elif [ "$v" -lt "$raise_uv" ] && [ "$target" -lt "$vm" ] && [ "$thermal_held" -eq 0 ]; then
          target=$((target + rstep))
          [ "$target" -le "$vm" ] || target=$vm
        fi
      fi
      # 上限被调低时立即收敛，避免残留高于新上限的投票值。
      [ "$target" -le "$vm" ] || target=$vm
      thermal_clamp
      if [ "$target" -ne "$prev_target" ] ||
         [ "$target" != "$(cat "$node/force_val" 2>/dev/null)" ]; then
        printf '%s' "$target" > "$node/force_val" 2>/dev/null || :
        # 驱动仅在写 force_active 时才回调重新投票；只改 force_val 不会应用新值，
        # 因此每次投票值变化都要重写一次 force_active=1，等同于接管时的生效序列。
        printf '1' > "$node/force_active" 2>/dev/null || :
        printf '%s %s %s %s %s\n' "$(boot_id)" "$(uptime_s)" "$$" "$target" "$ap" > "$L" 2>/dev/null || :
        write_live RUNNING "$target" ADJUSTED "$ap"
      fi
      if [ "$(readbit "$node/force_active")" != 1 ]; then
        revoke_own 2>/dev/null || :
        unlock
        owning=0
        proto=''
        log 'FINISHED_OWNERSHIP_CHANGED'
        write_live IDLE 0 OWNERSHIP_CHANGED ''
      fi
    fi
    if [ "$owning" -eq 1 ]; then
      live_reason=ADJUSTED
      case "$thermal_state" in
        LIMITED) live_reason=THERMAL_LIMITED;;
        SENSOR_ERROR) live_reason=THERMAL_SENSOR_ERROR;;
      esac
      # 正常起步原因保留到第一次目标变化，温控状态则每轮更新。
      if [ "$live_reason" = ADJUSTED ] && [ "$(live_get "$LIVE" REASON)" = STARTED ]; then live_reason=STARTED; fi
      write_live RUNNING "$target" "$live_reason" "$ap"
    fi
    sleep "$ivl"
  done
}
case "$CMD" in
  --control-run)
    control_run
    ;;
  --monitor-enable)
    mkdir -p "$D" || fail 'STORAGE'
    printf 'on\n' > "$MON" || fail 'STORAGE'
    ensure_daemon
    echo 'MONITOR=ON'
    ;;
  --monitor-disable)
    mkdir -p "$D" || fail 'STORAGE'
    printf 'off\n' > "$MON" || fail 'STORAGE'
    echo 'MONITOR=OFF'
    ;;
  --monitor-ensure)
    if monitor_on; then ensure_daemon; echo 'MONITOR=ON'; else echo 'MONITOR=OFF'; fi
    ;;
  --proto-enable|--proto-disable)
    [ "$#" -eq 2 ] || { echo 'USAGE: --proto-enable|--proto-disable PROTO' >&2; exit 2; }
    control_proto "$2" || { echo 'INVALID_PROTOCOL' >&2; exit 2; }
    mkdir -p "$D" || fail 'STORAGE'
    if [ "$CMD" = '--proto-enable' ]; then
      printf 'on\n' > "$(proto_config "$2" enabled)" || fail 'STORAGE'
      ensure_daemon
      echo "PROTO_ENABLED=$(proto_key "$2")"
    else
      printf 'off\n' > "$(proto_config "$2" enabled)" || fail 'STORAGE'
      echo "PROTO_DISABLED=$(proto_key "$2")"
    fi
    ;;
  --limit-set)
    [ "$#" -eq 3 ] || { echo 'USAGE: --limit-set PROTO MV' >&2; exit 2; }
    control_proto "$2" || { echo 'INVALID_PROTOCOL' >&2; exit 2; }
    mv="$3"
    num "$mv" || { echo 'INVALID_LIMIT' >&2; exit 2; }
    if [ "$mv" -lt "$LIMIT_MIN_MV" ] || [ "$mv" -gt "$LIMIT_MAX_MV" ]; then
      echo 'INVALID_LIMIT' >&2
      exit 2
    fi
    mkdir -p "$D" || fail 'STORAGE'
    printf '%s\n' "$mv" > "$(proto_config "$2" limit-mv)" || fail 'STORAGE'
    echo "LIMIT_MV=$(proto_key "$2"):$mv"
    ;;
  --vote-max-set)
    [ "$#" -eq 3 ] || { echo 'USAGE: --vote-max-set PROTO N' >&2; exit 2; }
    control_proto "$2" || { echo 'INVALID_PROTOCOL' >&2; exit 2; }
    mv="$3"
    num "$mv" || { echo 'INVALID_VOTE_MAX' >&2; exit 2; }
    max="$VOTE_MAX_MAX"
    [ "$2" != pps ] || max="$PPS_VOTE_MAX_MAX"
    if [ "$mv" -lt "$VOTE_MAX_MIN" ] || [ "$mv" -gt "$max" ]; then
      echo 'INVALID_VOTE_MAX' >&2
      exit 2
    fi
    mkdir -p "$D" || fail 'STORAGE'
    printf '%s\n' "$mv" > "$(proto_config "$2" vote-max)" || fail 'STORAGE'
    echo "VOTE_MAX=$(proto_key "$2"):$mv"
    ;;
  --vote-initial-set)
    [ "$#" -eq 2 ] || { echo 'USAGE: --vote-initial-set N' >&2; exit 2; }
    mv="$2"
    num "$mv" || { echo 'INVALID_VOTE_INITIAL' >&2; exit 2; }
    if [ "$mv" -lt "$INITIAL_MIN" ] || [ "$mv" -gt "$INITIAL_MAX" ]; then
      echo 'INVALID_VOTE_INITIAL' >&2
      exit 2
    fi
    mkdir -p "$D" || fail 'STORAGE'
    save_setting "$INITF" "$mv" || fail 'STORAGE'
    echo "VOTE_INITIAL=$mv"
    ;;
  --interval-set)
    [ "$#" -eq 2 ] || { echo 'USAGE: --interval-set MS' >&2; exit 2; }
    mv="$2"
    num "$mv" || { echo 'INVALID_INTERVAL' >&2; exit 2; }
    if [ "$mv" -lt "$INTERVAL_MIN" ] || [ "$mv" -gt "$INTERVAL_MAX" ]; then
      echo 'INVALID_INTERVAL' >&2
      exit 2
    fi
    mkdir -p "$D" || fail 'STORAGE'
    save_setting "$IVLF" "$mv" || fail 'STORAGE'
    echo "INTERVAL_MS=$mv"
    ;;
  --raise-step-set)
    [ "$#" -eq 2 ] || { echo 'USAGE: --raise-step-set N' >&2; exit 2; }
    mv="$2"
    num "$mv" || { echo 'INVALID_RAISE_STEP' >&2; exit 2; }
    if [ "$mv" -lt "$RAISE_STEP_MIN" ] || [ "$mv" -gt "$RAISE_STEP_MAX" ]; then
      echo 'INVALID_RAISE_STEP' >&2
      exit 2
    fi
    mkdir -p "$D" || fail 'STORAGE'
    save_setting "$RSTEPF" "$mv" || fail 'STORAGE'
    echo "RAISE_STEP=$mv"
    ;;
  --lower-step-set)
    [ "$#" -eq 2 ] || { echo 'USAGE: --lower-step-set N' >&2; exit 2; }
    mv="$2"
    num "$mv" || { echo 'INVALID_LOWER_STEP' >&2; exit 2; }
    if [ "$mv" -lt "$LOWER_STEP_MIN" ] || [ "$mv" -gt "$LOWER_STEP_MAX" ]; then
      echo 'INVALID_LOWER_STEP' >&2
      exit 2
    fi
    mkdir -p "$D" || fail 'STORAGE'
    save_setting "$LSTEPF" "$mv" || fail 'STORAGE'
    echo "LOWER_STEP=$mv"
    ;;
  --cutoff-gap-set)
    [ "$#" -eq 2 ] || { echo 'USAGE: --cutoff-gap-set MV' >&2; exit 2; }
    mv="$2"
    snum "$mv" || { echo 'INVALID_CUTOFF_GAP' >&2; exit 2; }
    if [ "$mv" -lt "$GAP_MIN" ] || [ "$mv" -gt "$GAP_MAX" ]; then
      echo 'INVALID_CUTOFF_GAP' >&2
      exit 2
    fi
    mkdir -p "$D" || fail 'STORAGE'
    save_setting "$GAPF" "$mv" || fail 'STORAGE'
    echo "CUTOFF_GAP_MV=$mv"
    ;;
  --thermal-enable|--thermal-disable)
    [ "$#" -eq 1 ] || exit 2
    mkdir -p "$D" || fail 'STORAGE'
    value=off; [ "$CMD" != --thermal-enable ] || value=on
    save_setting "$TENF" "$value" || fail 'STORAGE'
    echo "THERMAL_ENABLED=$value"
    ;;
  --thermal-limit-set|--thermal-vote-set|--thermal-gap-set)
    [ "$#" -eq 2 ] || exit 2
    case "$2" in ''|0*|*[!0-9]*) echo INVALID_THERMAL_VALUE >&2; exit 2;; esac
    case "$CMD" in
      --thermal-limit-set) path="$TLIMF"; lo=20; hi=60; key=THERMAL_LIMIT_C;;
      --thermal-vote-set) path="$TVOTEF"; lo=500; hi=5000; key=THERMAL_VOTE_MA;;
      --thermal-gap-set) path="$TGAPF"; lo=1; hi=5; key=THERMAL_GAP_C;;
    esac
    num "$2" && [ "$2" -ge "$lo" ] && [ "$2" -le "$hi" ] || { echo INVALID_THERMAL_VALUE >&2; exit 2; }
    mkdir -p "$D" || fail 'STORAGE'
    save_setting "$path" "$2" || fail 'STORAGE'
    echo "$key=$2"
    ;;
  --thermal-status)
    thermal_status
    ;;
  --status)
    state='STOPPED'
    target='0'
    proto=''
    if [ -e "$L" ]; then
      if lease_valid; then
        set -- $(cat "$L" 2>/dev/null)
        target="$4"
        proto="$5"
        node="$(proto_node "$proto")"
        if kill -0 "$3" 2>/dev/null; then
          if [ "$(readbit "$node/force_active")" = 1 ] &&
             [ "$(cat "$node/force_val" 2>/dev/null)" = "$target" ]; then
            state='RUNNING'
          else
            state='STARTING'
          fi
        else
          state='RECOVERY_REQUIRED'
        fi
      else
        state='RECOVERY_REQUIRED'
      fi
    fi
    reason='UNKNOWN'
    phase='IDLE'
    if [ -f "$LIVE" ]; then
      phase="$(live_get "$LIVE" PHASE)"
      reason="$(live_get "$LIVE" REASON)"
      [ -n "$phase" ] || phase='IDLE'
      [ -n "$reason" ] || reason='UNKNOWN'
    fi
    mon='NO'; monitor_on && mon='YES'
    online=0; online_proto=''
    for p in ufcs vooc pps; do
      if proto_online "$p"; then online=$((online + 1)); online_proto="$p"; fi
    done
    [ "$online" -eq 1 ] || online_proto=''
    protos=''
    for p in ufcs pps; do
      k="$(proto_key "$p")"
      en='NO'; proto_on "$p" && en='YES'
      protos="$protos;${k}_ENABLED=$en;${k}_LIMIT_MV=$(proto_limit_mv "$p");${k}_VOTE_MAX=$(proto_vote_max "$p")"
    done
    printf 'CONTROL_STATE=%s;TARGET_RAW=%s;REASON=%s;PHASE=%s;MONITOR_ENABLED=%s;ACTIVE_PROTOCOL=%s;ONLINE_PROTOCOL=%s;VOTE_INITIAL=%s;INTERVAL_MS=%s;RAISE_STEP=%s;LOWER_STEP=%s;CUTOFF_GAP_MV=%s%s;' \
      "$state" "$target" "$reason" "$phase" "$mon" "$(proto_key "$proto")" \
      "$(proto_key "$online_proto")" "$(initial_raw)" "$(interval_ms)" \
      "$(raise_step)" "$(lower_step)" "$(cutoff_gap)" "$protos"
    thermal_status
    ;;
  --recover)
    [ -e "$L" ] || exit 0
    lock || exit 0
    trap unlock EXIT
    lease_valid || fail 'INVALID_LEASE'
    set -- $(cat "$L" 2>/dev/null)
    process="$3"
    if kill -0 "$process" 2>/dev/null; then exit 0; fi
    if revoke_own; then log 'GUARDIAN_RECOVERY_REQUESTED'
    else log 'GUARDIAN_RECOVERY_FAILED'; exit 5; fi
    ;;
  *)
    echo 'USAGE: --status|--control-run|--monitor-enable|--monitor-disable|--monitor-ensure|--proto-enable PROTO|--proto-disable PROTO|--limit-set PROTO MV|--vote-max-set PROTO N|--vote-initial-set N|--interval-set MS|--raise-step-set N|--lower-step-set N|--cutoff-gap-set MV|--thermal-enable|--thermal-disable|--thermal-limit-set C|--thermal-vote-set MA|--thermal-gap-set C|--thermal-status|--recover' >&2
    exit 2
    ;;
esac
