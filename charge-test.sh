#!/system/bin/sh
# 自适应多协议电流控制：仅 UFCS / PPS；VOOC 仅保留旧租约撤销兼容。
#   监测总开关开启、对应协议在线、且该协议开关开启时，接管其 *_CURR 投票节点。
#   投票值从「投票初始值」起步，每「监控时间」检查一次：
#     电压 < 设定值 + 升流截止压差 -> 投票值 + 提升步进（最高为投票值上限）
#     电压 > 设定值               -> 投票值 - 降低步进（最低 1000）
#     设定值+截止压差..设定值      -> 保持不变
# 设定电压按协议独立保存：UFCS 默认 4560 / 最高 4660，PPS 默认 4500 / 最高 4560。
# UFCS 投票上限默认 9000 / 最高 13500；PPS 默认 5000 / 最高 5800。
# 高级参数（投票初始值、监控时间、提升/降低步进、升流截止压差）全局共用。
# 协议不再在线、对应开关关闭或监测关闭时立即撤销限流并入日志。
# 温控读取真实电池温度，超温或读温失败时限流，降温后按恢复温差解除。
# 温度伪装独立于温控：horae 测试模式下写入固定外壳温度，节点只读。
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
SOCENF="$D/auto-control.ufcs.soc-enabled"
SOCRF="$D/auto-control.ufcs.soc-ranges"
PENF="$D/auto-control.pulse-enabled"
PCHARGEF="$D/auto-control.pulse-charge-s"
PPAUSEF="$D/auto-control.pulse-pause-ms"
PRANGESF="$D/auto-control.pulse-ranges"
PMMIF="$D/pulse-mmi.lease"
MMI='/sys/devices/virtual/oplus_chg/battery/mmi_charging_enable'
DEFAULT_PULSE_CHARGE=5
DEFAULT_PULSE_PAUSE=1000
pulse_state=OFF
pulse_deadline=0
pulse_started=0
pulse_pending=0
pulse_key=''
pulse_error=''
pulse_resuming=0
TENF="$D/auto-control.thermal-enabled"
TLIMF="$D/auto-control.thermal-limit-c"
TVOTEF="$D/auto-control.thermal-vote-ma"
TGAPF="$D/auto-control.thermal-gap-c"
DEFAULT_THERMAL_LIMIT=45
DEFAULT_THERMAL_VOTE=1000
DEFAULT_THERMAL_GAP=2
FTENF="$D/auto-control.fake-temp-enabled"
FTVALF="$D/auto-control.fake-temp-deci"
FTHORAEF="$D/fake-temp.horae-state"
SHELL_TEMP='/proc/shell-temp'
DEFAULT_FAKETEMP=360
FAKETEMP_MIN=200
FAKETEMP_MAX=450
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
UFCS_LIMIT_MAX_MV=4660
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
  limit_max="$LIMIT_MAX_MV"; [ "$1" != ufcs ] || limit_max="$UFCS_LIMIT_MAX_MV"
  if num "$v" && [ "$v" -ge "$LIMIT_MIN_MV" ] && [ "$v" -le "$limit_max" ]; then
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
soc_on() { [ "$(cat "$SOCENF" 2>/dev/null)" = on ]; }
soc_now() {
  capacity="$(cat /sys/class/power_supply/battery/capacity 2>/dev/null)" || return 1
  num "$capacity" && [ "$capacity" -ge 0 ] && [ "$capacity" -le 100 ] || return 1
  printf '%s' "$capacity"
}
# 行格式：起点,终点,上限,初始值,间隔,提升,降低,截止压差；两端均包含。
soc_validate() {
  awk -F, -v fields="${1:-8}" '
    $0=="" { next }
    {
      if (NF!=fields) { bad=1; exit 1 }
      for (i=1;i<=fields;i++) if (length($i)>6 || (i<8 && $i!~/^[0-9]+$/) || (i==8 && $i!~/^-?[0-9]+$/)) { bad=1; exit 1 }
      if ($1<0 || $2>100 || $1>$2 || (($1+0) in rows)) { bad=1; exit 1 }
      if (fields==8 && ($3<1000 || $3>13500 || $4<1000 || $4>10000 || $5<20 || $5>200 || $6<10 || $6>500 || $7<100 || $7>1000 || $8< -100 || $8>0)) { bad=1; exit 1 }
      start=$1+0; ends[start]=$2+0
      rows[start]=fields==2 ? sprintf("%d,%d",$1,$2) : sprintf("%d,%d,%d,%d,%d,%d,%d,%d",$1,$2,$3,$4,$5,$6,$7,$8)
    }
    END {
      if (bad) exit 1
      previous=-1
      for (i=0;i<=100;i++) if (i in rows) {
        if (i<=previous) exit 1
        previous=ends[i]
      }
      for (i=0;i<=100;i++) if (i in rows) print rows[i]
    }'
}
soc_rules() { [ -e "$SOCRF" ] || return 0; soc_validate < "$SOCRF"; }
soc_edit() (
  fields="${3:-8}"
  K="$D/.soc-settings-lock"
  if [ "$fields" = 2 ]; then K="$D/.pulse-settings-lock"; SOCRF="$PRANGESF"; fi
  lock || fail SOC_SETTINGS_BUSY
  trap unlock EXIT
  old_rules=''
  if [ -e "$SOCRF" ]; then old_rules="$(soc_validate "$fields" < "$SOCRF")" || fail SOC_CONFIG_INVALID; fi
  candidate="$(printf '%s\n' "$2" | soc_validate "$fields")" || fail SOC_RANGE_INVALID
  [ -n "$candidate" ] || fail SOC_RANGE_INVALID
  bounds="$(printf '%s\n' "$candidate" | cut -d, -f1,2)"
  remaining="$(printf '%s\n' "$old_rules" | awk -F, -v key="$bounds" '$0!="" && ($1 "," $2)!=key')"
  if [ "$1" = set ]; then
    updated="$(printf '%s\n%s\n' "$remaining" "$candidate" | soc_validate "$fields")" || fail SOC_RANGE_OVERLAP
  else
    updated="$remaining"
  fi
  save_setting "$SOCRF" "$updated" || fail STORAGE
)
load_control_params() {
  effective_max="$(proto_vote_max "$1")"
  effective_initial="$(initial_raw)"
  effective_interval="$(interval_ms)"
  effective_raise="$(raise_step)"
  effective_lower="$(lower_step)"
  effective_gap="$(cutoff_gap)"
  soc_match=NONE
  soc_percent=UNKNOWN
  soc_valid=YES
  soc_rows=''
  [ "$1" = ufcs ] || return 0
  soc_percent="$(soc_now)" || soc_percent=UNKNOWN
  soc_rows="$(soc_rules)" || { soc_valid=NO; return 0; }
  soc_on && [ "$soc_percent" != UNKNOWN ] || return 0
  soc_row="$(printf '%s\n' "$soc_rows" | awk -F, -v p="$soc_percent" 'NF==8 && p>=$1 && p<=$2 { print; exit }')"
  [ -n "$soc_row" ] || return 0
  previous_ifs="$IFS"
  IFS=,
  set -- $soc_row
  IFS="$previous_ifs"
  soc_match="$1,$2"
  effective_max="$3"; effective_initial="$4"; effective_interval="$5"
  effective_raise="$6"; effective_lower="$7"; effective_gap="$8"
}
soc_status() {
  load_control_params ufcs
  soc_enabled=NO; soc_on && soc_enabled=YES
  encoded_rows="$(printf '%s\n' "$soc_rows" | tr '\n' '|')"
  # Android mksh 将未引用的 | 作为模式分支，必须按字面量移除。
  encoded_rows="${encoded_rows%'|'}"
  printf 'SOC_ENABLED=%s;SOC_PERCENT=%s;SOC_CONFIG_VALID=%s;SOC_RANGES=%s;SOC_MATCH=%s;SOC_EFFECTIVE_VOTE_MAX=%s;SOC_EFFECTIVE_INITIAL=%s;SOC_EFFECTIVE_INTERVAL_MS=%s;SOC_EFFECTIVE_RAISE_STEP=%s;SOC_EFFECTIVE_LOWER_STEP=%s;SOC_EFFECTIVE_CUTOFF_GAP_MV=%s\n' \
    "$soc_enabled" "$soc_percent" "$soc_valid" "${encoded_rows:-NONE}" "$soc_match" "$effective_max" "$effective_initial" "$effective_interval" "$effective_raise" "$effective_lower" "$effective_gap"
}
thermal_on() { [ "$(cat "$TENF" 2>/dev/null)" = on ]; }
thermal_setting() {
  value="$(file_num "$@")"
  # 去掉历史文件中的前导零，避免 Shell 算术将其当作八进制。
  while [ "${value#0}" != "$value" ]; do value="${value#0}"; done
  printf '%s' "${value:-0}"
}
thermal_limit() { thermal_setting "$TLIMF" "$DEFAULT_THERMAL_LIMIT" 20 60; }
thermal_vote() { thermal_setting "$TVOTEF" "$DEFAULT_THERMAL_VOTE" 500 5000; }
thermal_gap() { thermal_setting "$TGAPF" "$DEFAULT_THERMAL_GAP" 1 5; }
uptime_ms() {
  awk '$1~/^[0-9]+([.][0-9]+)?$/ { printf "%.0f",$1*1000; ok=1; exit } END { if (!ok) exit 1 }' /proc/uptime 2>/dev/null
}
pulse_on() { [ "$(cat "$PENF" 2>/dev/null)" = on ]; }
pulse_ranges() { [ -e "$PRANGESF" ] || return 0; soc_validate 2 < "$PRANGESF"; }
pulse_config() {
  p_enabled=NO; pulse_on && p_enabled=YES
  p_charge="$(thermal_setting "$PCHARGEF" "$DEFAULT_PULSE_CHARGE" 1 1200)"
  p_pause="$(thermal_setting "$PPAUSEF" "$DEFAULT_PULSE_PAUSE" 0 60000)"
  p_valid=YES
  p_ranges="$(pulse_ranges)" || { p_valid=NO; p_ranges=''; }
  p_soc="$(soc_now)" || p_soc=UNKNOWN
  p_match=ALL
  if [ -n "$p_ranges" ]; then
    p_match=NONE
    if [ "$p_soc" != UNKNOWN ]; then
      p_match="$(printf '%s\n' "$p_ranges" | awk -F, -v p="$p_soc" 'NF==2 && p>=$1 && p<=$2 { print; exit }')"
      [ -n "$p_match" ] || p_match=NONE
    fi
  fi
}
pulse_reset() {
  if [ "$pulse_state" != "$1" ]; then log "PULSE_$1"; fi
  pulse_state="$1"; pulse_deadline=0; pulse_started=0; pulse_pending=0; pulse_key=''; pulse_error=''
}
pulse_idle() {
  idle_state=OFF; pulse_on && idle_state=IDLE
  pulse_reset "$idle_state"
  pulse_mmi_restore || pulse_error=WRITE_ERROR
  pulse_resuming=0
}
pulse_mmi_marker() {
  [ -f "$PMMIF" ] && [ ! -L "$PMMIF" ] || return 1
  mmi_boot=''; mmi_pid=''; mmi_extra=''
  read -r mmi_boot mmi_pid mmi_extra < "$PMMIF" || return 1
  [ -z "$mmi_extra" ] && num "$mmi_pid" && [ "$mmi_pid" -gt 1 ]
}
pulse_mmi_restore() {
  [ -e "$PMMIF" ] || return 0
  pulse_mmi_marker && [ "$mmi_boot" = "$(boot_id)" ] || return 1
  mmi_state="$(readbit "$MMI")" || return 1
  if [ "$mmi_state" = 0 ]; then
    printf '1' > "$MMI" 2>/dev/null && [ "$(readbit "$MMI")" = 1 ] || return 1
    sleep 0.001
  fi
  rm -f "$PMMIF"
}
pulse_mmi_recover() {
  [ -e "$PMMIF" ] || return 0
  pulse_mmi_marker || return 1
  if [ "$mmi_boot" != "$(boot_id)" ]; then rm -f "$PMMIF"; return; fi
  if kill -0 "$mmi_pid" 2>/dev/null; then return 0; fi
  pulse_mmi_restore && log MMI_RECOVERED
}
pulse_mmi_pause() {
  if [ -e "$PMMIF" ]; then
    pulse_mmi_marker && [ "$mmi_boot" = "$(boot_id)" ] && [ "$mmi_pid" = "$$" ] &&
      [ "$(readbit "$MMI")" = 0 ]
    return
  fi
  # 只接管当前允许充电的 MMI 状态，避免恢复其它功能主动关闭的充电。
  [ "$(readbit "$MMI")" = 1 ] && lease_valid || return 1
  mmi_expected="$(awk '{print $4}' "$L" 2>/dev/null)"
  [ "$(cat "$node/force_val" 2>/dev/null)" = "$mmi_expected" ] || return 1
  printf '%s %s\n' "$(boot_id)" "$$" > "$PMMIF.tmp.$$" && mv -f "$PMMIF.tmp.$$" "$PMMIF" || return 1
  if printf '0' > "$MMI" 2>/dev/null && [ "$(readbit "$MMI")" = 0 ]; then return 0; fi
  pulse_mmi_restore || :
  return 1
}
pulse_update() {
  if ! pulse_on; then pulse_reset OFF; return; fi
  pulse_config
  if [ "$p_valid" != YES ]; then pulse_reset CONFIG_ERROR; return; fi
  if [ "$p_match" = NONE ]; then pulse_reset OUTSIDE_RANGE; return; fi
  if [ "$p_pause" -eq 0 ]; then pulse_reset CONTINUOUS; return; fi
  pulse_now="$(uptime_ms)" || { pulse_reset CLOCK_ERROR; return; }
  new_key="$ap:$p_charge:$p_pause:$p_match:$p_ranges"
  pulse_error=''
  if [ "$new_key" != "$pulse_key" ] || [ "$pulse_now" -lt "$pulse_started" ]; then
    pulse_reset CHARGING; pulse_pending=1; pulse_key="$new_key"
  elif [ "$pulse_pending" -eq 0 ] && [ "$pulse_now" -ge "$pulse_deadline" ]; then
    if [ "$pulse_state" = CHARGING ]; then pulse_state=PAUSED; else pulse_state=CHARGING; fi
    pulse_pending=1; pulse_deadline=0
    log "PULSE_$pulse_state"
  fi
}
# 暂停从 MMI 停充回读成功后计时；充电从投票恢复并回读成功后计时。
pulse_commit() {
  [ "$pulse_pending" -eq 1 ] || return 0
  [ -z "$pulse_error" ] || return 0
  if [ "$pulse_state" = PAUSED ]; then
    if ! pulse_mmi_marker || [ "$mmi_boot" != "$(boot_id)" ] || [ "$(readbit "$MMI")" != 0 ]; then pulse_error=WRITE_ERROR; return; fi
  elif [ "$(readbit "$node/force_active")" != 1 ] || [ "$(cat "$node/force_val" 2>/dev/null)" != "$target" ]; then
    pulse_error=WRITE_ERROR; return
  fi
  pulse_started="$(uptime_ms)" || { pulse_error=CLOCK_ERROR; return; }
  duration=$((p_charge * 1000)); [ "$pulse_state" != PAUSED ] || duration="$p_pause"
  pulse_deadline=$((pulse_started + duration)); pulse_pending=0
}
pulse_sleep() {
  case "$pulse_state" in CHARGING|PAUSED)
    if [ "$pulse_deadline" -gt 0 ]; then
      sleep_now="$(uptime_ms)" || return 0
      remaining=$((pulse_deadline - sleep_now))
      [ "$remaining" -gt 0 ] || remaining=1
      if [ "$remaining" -lt "$effective_interval" ]; then ivl="$(interval_s "$remaining")"; fi
    fi;;
  esac
}
pulse_status() {
  pulse_config
  ps=OFF; pr=0
  if [ "$p_enabled" = YES ]; then
    ps=IDLE
    if monitor_on && daemon_running && [ "$(live_get "$LIVE" PHASE)" = RUNNING ]; then
      ps="$(live_get "$LIVE" PULSE_STATE)"; [ -n "$ps" ] || ps=IDLE
      case "$ps" in CHARGING|PAUSED)
        pd="$(live_get "$LIVE" PULSE_DEADLINE_MS)"
        pn="$(uptime_ms)" || { ps=CLOCK_ERROR; pn=0; pd=0; }
        case "$pd" in ''|*[!0-9]*) pd=0;; esac
        [ "${#pd}" -le 15 ] || pd=0
        pr=$((pd - pn)); [ "$pr" -ge 0 ] || pr=0;;
      esac
    fi
  fi
  if [ -e "$PMMIF" ] && [ "$(live_get "$LIVE" PHASE)" != RUNNING ]; then ps=RECOVERY_REQUIRED; fi
  ranges_encoded="$(printf '%s\n' "$p_ranges" | tr '\n' ':')"; ranges_encoded="${ranges_encoded%:}"
  printf 'PULSE_ENABLED=%s;PULSE_CHARGE_S=%s;PULSE_PAUSE_MS=%s;PULSE_RANGES=%s;PULSE_CONFIG_VALID=%s;PULSE_SOC=%s;PULSE_STATE=%s;PULSE_REMAIN_MS=%s\n' \
    "$p_enabled" "$p_charge" "$p_pause" "${ranges_encoded:-NONE}" "$p_valid" "$p_soc" "$ps" "$pr"
}
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
# 温度伪装：写入 0/1/2 三个通道后设为只读，保留 horae 的读取权限。
# 状态判定读 ls 的权限位，兼容 Android toybox 与 BSD ls。
faketemp_on() { [ "$(cat "$FTENF" 2>/dev/null)" = on ]; }
faketemp_value() { thermal_setting "$FTVALF" "$DEFAULT_FAKETEMP" "$FAKETEMP_MIN" "$FAKETEMP_MAX"; }
faketemp_horae_state() {
  record="$(cat "$FTHORAEF" 2>/dev/null)"
  if [ -n "${record%:*}" ] && [ "${record%:*}" = "$(boot_id)" ]; then
    case "${record##*:}" in TEST_SENT|NORMAL_SENT|ERROR) printf '%s' "${record##*:}"; return 0;; esac
  fi
  printf UNKNOWN
}
faketemp_horae() (
  result=ERROR
  if timeout 3 dumpsys horae testmode "$@" >/dev/null 2>&1; then
    result=TEST_SENT
    if [ "${1:-}" = false ]; then
      result=NORMAL_SENT
      dump="$(timeout 3 dumpsys horae 2>/dev/null)" || result=ERROR
      if printf '%s\n' "$dump" | grep -q '^TestModeShellTemp:'; then
        # 部分系统忽略 false，只在本模块有开启记录时兼容恢复。
        result=ERROR
        if [ "$(getprop init.svc.horae)" = running ] && setprop ctl.restart horae; then
          sleep 1
          if dump="$(timeout 3 dumpsys horae 2>/dev/null)" && [ -n "$dump" ] &&
             ! printf '%s\n' "$dump" | grep -q '^TestModeShellTemp:'; then result=NORMAL_SENT; fi
        fi
      fi
    fi
  fi
  save_setting "$FTHORAEF" "$(boot_id):$result" || return 1
  [ "$result" != ERROR ]
)
faketemp_apply() {
  if ! faketemp_on; then
    restored=0
    if [ -e "$SHELL_TEMP" ]; then chmod 0666 "$SHELL_TEMP" 2>/dev/null || restored=1; fi
    case "$(faketemp_horae_state)" in
      TEST_SENT|ERROR) faketemp_horae false || restored=1;;
    esac
    return "$restored"
  fi
  [ -e "$SHELL_TEMP" ] || return 1
  # horae 切模式可能重置节点，先切换，再写温度并锁定。
  chmod 0666 "$SHELL_TEMP" 2>/dev/null || return 1
  faketemp_horae || return 1
  if faketemp_write; then return 0; fi
  chmod 0666 "$SHELL_TEMP" 2>/dev/null || :
  faketemp_horae false || :
  return 1
}
faketemp_write() {
  # 节点按毫摄氏度接收；本地设置以 0.1°C 存储，故放大 100 倍。
  milli=$(( $(faketemp_value) * 100 ))
  chmod 0644 "$SHELL_TEMP" 2>/dev/null || return 1
  for channel in 0 1 2; do
    if ! printf '%s %s\n' "$channel" "$milli" > "$SHELL_TEMP" 2>/dev/null; then
      chmod 0666 "$SHELL_TEMP" 2>/dev/null || :
      return 1
    fi
  done
  chmod 0444 "$SHELL_TEMP" 2>/dev/null || return 1
}
faketemp_state() {
  faketemp_on || { printf 'OFF'; return 0; }
  [ -e "$SHELL_TEMP" ] || { printf 'UNAVAILABLE'; return 0; }
  [ "$(faketemp_horae_state)" = TEST_SENT ] || { printf 'PENDING'; return 0; }
  mode="$(ls -ld "$SHELL_TEMP" 2>/dev/null)" || { printf 'UNKNOWN'; return 0; }
  mode="${mode%% *}"
  case "$mode" in
    -r--r--r--*) printf 'APPLIED' ;;
    -*) printf 'PENDING' ;;
    *) printf 'UNKNOWN' ;;
  esac
}
faketemp_status() {
  fen=NO; faketemp_on && fen=YES
  printf 'FAKETEMP_ENABLED=%s;FAKETEMP_VALUE_DECI=%s;FAKETEMP_STATE=%s;FAKETEMP_HORAE_STATE=%s;\n' \
    "$fen" "$(faketemp_value)" "$(faketemp_state)" "$(faketemp_horae_state)"
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
  printf 'PHASE=%s\nPROTO=%s\nTARGET=%s\nREASON=%s\nTHERMAL_STATE=%s\nTHERMAL_BOOT=%s\nPULSE_STATE=%s\nPULSE_DEADLINE_MS=%s\n' \
    "$1" "$4" "$2" "$3" "$thermal_state" "$(boot_id)" "${pulse_error:-$pulse_state}" "$pulse_deadline" > "$LIVE.tmp.$$" 2>/dev/null &&
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
# 按租约核对协议节点与 force_val，仅关闭本模块的强制投票。
disable_own_force() {
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
}
revoke_own() {
  disable_own_force || return 1
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
  trap 'pulse_mmi_restore >/dev/null 2>&1 || :; unlock; daemon_unlock' EXIT
  trap 'exit 0' HUP INT TERM
  pulse_mmi_recover || :
  owning=0
  target=0
  normal_target=0
  proto=''
  previous_soc_match=NONE
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
      pulse_idle
      write_live IDLE 0 MONITOR_OFF ''
      break
    fi
    if [ "$pulse_state" != PAUSED ] && ! pulse_mmi_restore; then
      pulse_error=WRITE_ERROR
      write_live IDLE 0 MMI_RECOVERY_REQUIRED ''
      sleep "$ivl"
      continue
    fi
    # 当前在线的协议；仅当「有且仅有一个」且该协议开关开启时才接管。
    ap=''
    online=0
    for p in ufcs vooc pps; do
      if proto_online "$p"; then online=$((online + 1)); ap="$p"; fi
    done
    pulse_offline=0
    # MMI 停充可能让协议暂时离线；在 USB 未拔出时仍须完成暂停计时并恢复。
    if [ "$owning" -eq 1 ] && [ "$pulse_state" = PAUSED ] && [ "$online" -eq 0 ] &&
       proto_on "$proto" && [ "$(readbit /sys/class/power_supply/usb/online)" != 0 ]; then
      ap="$proto"; online=1; pulse_offline=1
    fi
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
      pulse_idle
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
      pulse_idle
    fi
    # revoke_own 会读取旧租约并更新 node，撤销后重新选择当前协议节点。
    node="$(proto_node "$ap")"
    load_control_params "$ap"
    ivl="$(interval_s "$effective_interval")"
    if [ "$owning" -eq 0 ]; then
      if lock; then
        target="$effective_initial"
        # 首次写入也受协议上限和温控限制，避免先写入较高初始值。
        max="$effective_max"
        [ "$target" -le "$max" ] || target="$max"
        thermal_clamp
        normal_target="$target"
        pulse_update
        if printf '%s %s %s %s %s\n' "$(boot_id)" "$(uptime_s)" "$$" "$target" "$ap" > "$L" &&
           printf '%s' "$target" > "$node/force_val" 2>/dev/null &&
           printf '1' > "$node/force_active" 2>/dev/null &&
           [ "$(readbit "$node/force_active")" = 1 ]; then
          owning=1
          proto="$ap"
          log "START_ADAPTIVE_$target"
          pulse_commit
          write_live RUNNING "$target" STARTED "$ap"
        else
          revoke_own 2>/dev/null || rm -f "$L" 2>/dev/null || :
          unlock
        fi
      fi
    else
      prev_target=$target
      target="$normal_target"
      range_changed=0
      if [ "$soc_match" != "$previous_soc_match" ]; then target="$effective_initial"; range_changed=1; fi
      lmv="$(proto_limit_mv "$ap")"
      vm="$effective_max"
      rstep="$effective_raise"
      lstep="$effective_lower"
      gap="$effective_gap"
      luv=$((lmv * 1000))
      raise_uv=$((luv + gap * 1000))
      v="$(voltage_now)" || v=''
      if [ "$range_changed" -eq 0 ] && [ "$pulse_state" != PAUSED ] && num "$v"; then
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
      normal_target="$target"
      previous_pulse="$pulse_state"
      pulse_update
      if [ "$previous_pulse" = PAUSED ] && [ "$pulse_state" != PAUSED ]; then pulse_resuming=1; fi
      if [ "$pulse_state" = PAUSED ]; then
        pulse_mmi_pause || pulse_error=WRITE_ERROR
      elif ! pulse_mmi_restore; then
        pulse_error=WRITE_ERROR
        write_live RUNNING "$target" PULSE_ERROR "$ap"
        sleep "$ivl"
        continue
      elif [ "$pulse_offline" -eq 1 ]; then
        revoke_own 2>/dev/null || :
        unlock; owning=0; proto=''; pulse_idle
        write_live IDLE 0 WAITING_PROTOCOL ''
        sleep "$ivl"
        continue
      else
        if [ "$pulse_resuming" -eq 1 ] && [ "$pulse_state" = CHARGING ]; then
          target="$effective_max"
          thermal_clamp
          normal_target="$target"
        fi
        if [ "$pulse_resuming" -eq 1 ] || [ "$target" -ne "$prev_target" ] ||
           [ "$target" != "$(cat "$node/force_val" 2>/dev/null)" ]; then
          printf '%s' "$target" > "$node/force_val" 2>/dev/null || :
          # 驱动仅在写 force_active 时回调重新投票，因此每次目标变化都要重写。
          printf '1' > "$node/force_active" 2>/dev/null || :
          printf '%s %s %s %s %s\n' "$(boot_id)" "$(uptime_s)" "$$" "$target" "$ap" > "$L" 2>/dev/null || :
          pulse_commit
          write_live RUNNING "$target" ADJUSTED "$ap"
          pulse_resuming=0
        fi
      fi
      if [ "$pulse_state" != PAUSED ] && [ "$(readbit "$node/force_active")" != 1 ]; then
        revoke_own 2>/dev/null || :
        unlock
        owning=0
        proto=''
        log 'FINISHED_OWNERSHIP_CHANGED'
        pulse_idle
        write_live IDLE 0 OWNERSHIP_CHANGED ''
      fi
    fi
    previous_soc_match="$soc_match"
    if [ "$owning" -eq 1 ]; then
      pulse_commit
      live_reason=ADJUSTED
      case "$thermal_state" in
        LIMITED) live_reason=THERMAL_LIMITED;;
        SENSOR_ERROR) live_reason=THERMAL_SENSOR_ERROR;;
      esac
      if [ "$pulse_state" = PAUSED ]; then live_reason=PULSE_PAUSED; fi
      case "$pulse_state" in CLOCK_ERROR|CONFIG_ERROR) live_reason=PULSE_ERROR;; esac
      if [ -n "$pulse_error" ]; then live_reason=PULSE_ERROR; fi
      # 正常起步原因保留到第一次目标变化，温控状态则每轮更新。
      if [ "$live_reason" = ADJUSTED ] && [ "$(live_get "$LIVE" REASON)" = STARTED ]; then live_reason=STARTED; fi
      write_live RUNNING "$target" "$live_reason" "$ap"
      pulse_sleep
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
    pulse_mmi_restore || fail MMI_RECOVERY_FAILED
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
    limit_max="$LIMIT_MAX_MV"; [ "$2" != ufcs ] || limit_max="$UFCS_LIMIT_MAX_MV"
    if [ "$mv" -lt "$LIMIT_MIN_MV" ] || [ "$mv" -gt "$limit_max" ]; then
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
  --pulse-enable|--pulse-disable)
    [ "$#" -eq 1 ] || exit 2
    mkdir -p "$D" || fail STORAGE
    value=off; [ "$CMD" != --pulse-enable ] || value=on
    save_setting "$PENF" "$value" || fail STORAGE
    if [ "$CMD" = --pulse-disable ]; then pulse_mmi_restore || fail MMI_RECOVERY_FAILED; fi
    echo "PULSE_ENABLED=$value"
    ;;
  --pulse-charge-set|--pulse-pause-set)
    [ "$#" -eq 2 ] || exit 2
    num "$2" || { echo INVALID_PULSE_VALUE >&2; exit 2; }
    if [ "$CMD" = --pulse-charge-set ]; then lo=1; hi=1200; path="$PCHARGEF"; else lo=0; hi=60000; path="$PPAUSEF"; fi
    [ "$2" -ge "$lo" ] && [ "$2" -le "$hi" ] || { echo INVALID_PULSE_VALUE >&2; exit 2; }
    mkdir -p "$D" || fail STORAGE
    save_setting "$path" "$2" || fail STORAGE
    echo PULSE_SAVED
    ;;
  --pulse-range-set|--pulse-range-delete)
    [ "$#" -eq 2 ] || exit 2
    mkdir -p "$D" || fail STORAGE
    action=set; [ "$CMD" != --pulse-range-delete ] || action=delete
    soc_edit "$action" "$2" 2 || exit 3
    echo PULSE_SAVED
    ;;
  --pulse-status)
    pulse_status
    ;;
  --soc-enable|--soc-disable)
    [ "$#" -eq 1 ] || exit 2
    mkdir -p "$D" || fail STORAGE
    value=off; [ "$CMD" != --soc-enable ] || value=on
    save_setting "$SOCENF" "$value" || fail STORAGE
    echo "SOC_ENABLED=$value"
    ;;
  --soc-range-set|--soc-range-delete)
    [ "$#" -eq 2 ] || exit 2
    mkdir -p "$D" || fail STORAGE
    action=set; [ "$CMD" != --soc-range-delete ] || action=delete
    soc_edit "$action" "$2" || exit 3
    echo SOC_SAVED
    ;;
  --soc-status)
    soc_status
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
  --faketemp-enable|--faketemp-disable)
    [ "$#" -eq 1 ] || exit 2
    mkdir -p "$D" || fail 'STORAGE'
    value=off; [ "$CMD" != --faketemp-enable ] || value=on
    save_setting "$FTENF" "$value" || fail 'STORAGE'
    faketemp_apply >/dev/null 2>&1 || fail FAKETEMP_APPLY_FAILED
    echo "FAKETEMP_ENABLED=$value"
    ;;
  --faketemp-value-set)
    [ "$#" -eq 2 ] || { echo 'USAGE: --faketemp-value-set DECI' >&2; exit 2; }
    case "$2" in ''|0*|*[!0-9]*) echo INVALID_FAKETEMP_VALUE >&2; exit 2;; esac
    num "$2" && [ "$2" -ge "$FAKETEMP_MIN" ] && [ "$2" -le "$FAKETEMP_MAX" ] ||
      { echo INVALID_FAKETEMP_VALUE >&2; exit 2; }
    mkdir -p "$D" || fail 'STORAGE'
    save_setting "$FTVALF" "$2" || fail 'STORAGE'
    faketemp_apply >/dev/null 2>&1 || fail FAKETEMP_APPLY_FAILED
    echo "FAKETEMP_VALUE_DECI=$2"
    ;;
  --faketemp-ensure)
    [ "$#" -eq 1 ] || exit 2
    faketemp_apply >/dev/null 2>&1 || fail FAKETEMP_APPLY_FAILED
    faketemp_status
    ;;
  --faketemp-status)
    faketemp_status
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
          if [ "$(live_get "$LIVE" PULSE_STATE)" = PAUSED ] && pulse_mmi_marker &&
             [ "$mmi_boot" = "$(boot_id)" ] && [ "$(readbit "$MMI")" = 0 ]; then
            state='RUNNING'
          elif [ "$(readbit "$node/force_active")" = 1 ] &&
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
    # 单行状态：伪装字段先出（去掉换行），由 thermal_status 收尾换行。
    printf '%s;' "$(soc_status)"
    printf '%s;' "$(pulse_status)"
    printf '%s' "$(faketemp_status)"
    thermal_status
    ;;
  --recover)
    pulse_mmi_recover || fail 'MMI_RECOVERY_FAILED'
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
    echo 'USAGE: --status|--control-run|--monitor-enable|--monitor-disable|--monitor-ensure|--proto-enable PROTO|--proto-disable PROTO|--limit-set PROTO MV|--vote-max-set PROTO N|--vote-initial-set N|--interval-set MS|--raise-step-set N|--lower-step-set N|--cutoff-gap-set MV|--soc-enable|--soc-disable|--soc-range-set CSV|--soc-range-delete CSV|--soc-status|--pulse-enable|--pulse-disable|--pulse-charge-set S|--pulse-pause-set MS|--pulse-range-set CSV|--pulse-range-delete CSV|--pulse-status|--thermal-enable|--thermal-disable|--thermal-limit-set C|--thermal-vote-set MA|--thermal-gap-set C|--thermal-status|--faketemp-enable|--faketemp-disable|--faketemp-value-set DECI|--faketemp-ensure|--faketemp-status|--recover' >&2
    exit 2
    ;;
esac
