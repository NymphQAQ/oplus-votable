#!/system/bin/sh
# 自适应多协议电流控制：仅 UFCS / PPS；VOOC 仅保留旧租约撤销兼容。
#   监测总开关开启、对应协议在线、且该协议开关开启时，接管其 *_CURR 投票节点。
#   投票值从「投票初始值」起步，每「监控时间」检查一次：
#     电压 < 设定值 + 升流截止压差 -> 投票值 + 提升步进（最高为投票值上限）
#     电压 > 设定值               -> 按实际经过周期降低投票值（最低 1000）
#     设定值+截止压差..设定值      -> 保持不变
# 设定电压按协议独立保存：UFCS 默认 4560 / 最高 4660，PPS 默认 4460 / 最高 4560。
# UFCS 投票上限默认 10900 / 最高 13500；PPS 默认 5800 / 最高 5800。
# 高级参数（投票初始值、监控时间、提升/降低步进、升流截止压差）全局共用。
# 接管/切区间/间断恢复先检查电压；异常读数保守限流；超压后等待一秒再允许升流。
# 协议不再在线、对应开关关闭或监测关闭时立即撤销限流并入日志。
# 温控读取真实电池温度，超温或读温失败时限流，降温后按恢复温差解除。
# 温度伪装独立于温控：固定温度或真实电池温度减去温差，二选一写入外壳节点。
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
EARLYGAPF="$D/auto-control.early-gap-mv"
EARLYSTEPF="$D/auto-control.early-step-ma"
early_pending=0
SOCENF="$D/auto-control.ufcs.soc-enabled"
SOCRF="$D/auto-control.ufcs.soc-ranges"
PENF="$D/auto-control.pulse-enabled"
PCHARGEF="$D/auto-control.pulse-charge-s"
PPAUSEF="$D/auto-control.pulse-pause-ms"
PRANGESF="$D/auto-control.pulse-ranges"
PMMIF="$D/pulse-mmi.lease"
MMI='/sys/devices/virtual/oplus_chg/battery/mmi_charging_enable'
DEFAULT_PULSE_CHARGE=60
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
DEFAULT_THERMAL_LIMIT=50
DEFAULT_THERMAL_VOTE=1000
DEFAULT_THERMAL_GAP=2
FTENF="$D/auto-control.fake-temp-enabled"
FTVALF="$D/auto-control.fake-temp-deci"
FTOFFSETF="$D/auto-control.fake-temp-offset-c"
FTLIVE="$D/fake-temp.live"
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
DEFAULT_INITIAL=2000
INITIAL_MIN=1000
INITIAL_MAX=10000
DEFAULT_INTERVAL=100
INTERVAL_MIN=20
INTERVAL_MAX=200
DEFAULT_RAISE_STEP=100
RAISE_STEP_MIN=10
RAISE_STEP_MAX=500
DEFAULT_LOWER_STEP=1000
LOWER_STEP_MIN=100
LOWER_STEP_MAX=1000
DEFAULT_GAP=-50
GAP_MIN=-100
GAP_MAX=0
DEFAULT_VOTE_MAX=10900
DEFAULT_PPS_VOTE_MAX=5800
VOTE_MAX_MIN=1000
VOTE_MAX_MAX=13500
PPS_VOTE_MAX_MAX=5800
DEFAULT_LIMIT_MV=4560
DEFAULT_PPS_LIMIT_MV=4460
cv_enabled=0
cv_next_at=0
cv_target_mv=0
cv_last_write=0
HSL="$D/system-handoff.soc"
bypass_state=UNKNOWN
bypass_checked=-1
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
# 内核节点与设置均为单行；保留尾随空行兼容，拒绝额外数据，避免热循环反复启动 cat。
read_value() {
  value=''; read_extra=''
  {
    IFS= read -r value || [ -n "$value" ] || return 1
    while IFS= read -r read_extra || [ -n "$read_extra" ]; do
      [ -z "$read_extra" ] || return 1
    done
  } 2>/dev/null < "$1"
}
# 可带负号的有符号整数（用于升流截止压差）。
snum() {
  case "$1" in
    ''|'-') return 1;;
    -*) num "${1#-}";;
    *) num "$1";;
  esac
}
read_clock() {
  clock_up=''; clock_seconds=0; clock_ms=0
  IFS=' ' read -r clock_up clock_unused < /proc/uptime || [ -n "$clock_up" ] || return 1
  clock_seconds="${clock_up%%.*}"
  case "$clock_up" in *.*) clock_fraction="${clock_up#*.}000";; *) clock_fraction=000;; esac
  clock_fraction="${clock_fraction%"${clock_fraction#???}"}"
  num "$clock_seconds" && num "$clock_fraction" || return 1
  clock_ms=$((clock_seconds * 1000 + 1$clock_fraction - 1000))
}
uptime_s() { read_clock && printf '%s' "$clock_seconds"; }
uptime_ms() { read_clock && printf '%s' "$clock_ms"; }
readbit() {
  read_value "$1" || return 1
  b="$value"
  [ "$b" = 0 ] || [ "$b" = 1 ] || return 1
  printf '%s' "$b"
}
current_boot=''
read_value /proc/sys/kernel/random/boot_id && current_boot="$value"
boot_id() { [ -n "$current_boot" ] && printf '%s' "$current_boot"; }

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
  read_value "/sys/class/oplus_mms/$1/item_id" && [ "$value" = 0 ] || return 1
  read_value "/sys/class/oplus_mms/$1/data" && [ "$value" = 1 ]
}
proto_config() { printf '%s/auto-control.%s.%s' "$D" "$1" "$2"; }
# 协议开关：文件缺失或缺省即视为开，只有显式 off 才是关。
proto_on() { read_value "$D/auto-control.$1.enabled" || value=''; [ "$value" != off ]; }
# 该协议的设定电压（mV）：缺失或越界回落到各自默认值。
read_proto_limit() {
  limit_max="$LIMIT_MAX_MV"; [ "$1" != ufcs ] || limit_max="$UFCS_LIMIT_MAX_MV"
  limit_default="$DEFAULT_LIMIT_MV"; [ "$1" != pps ] || limit_default="$DEFAULT_PPS_LIMIT_MV"
  read_setting "$D/auto-control.$1.limit-mv" "$limit_default" "$LIMIT_MIN_MV" "$limit_max"
  effective_limit_mv="$setting_value"
}
proto_limit_mv() { read_proto_limit "$1"; printf '%s' "$effective_limit_mv"; }
# PPS 最大不得超过 5800；历史 PPS 配置 >5800 时只在运行时夹到 5800。
# 已有 1000..5800 的用户配置保留，不强制改写存储。
read_proto_vote_max() {
  read_value "$D/auto-control.$1.vote-max" || value=''
  v="$value"
  max="$VOTE_MAX_MAX"
  default="$DEFAULT_VOTE_MAX"
  if [ "$1" = pps ]; then max="$PPS_VOTE_MAX_MAX"; default="$DEFAULT_PPS_VOTE_MAX"; fi
  if num "$v" && [ "$v" -ge "$VOTE_MAX_MIN" ]; then
    [ "$v" -le "$max" ] || v="$max"
    effective_max="$v"
  else
    effective_max="$default"
  fi
}
proto_vote_max() { read_proto_vote_max "$1"; printf '%s' "$effective_max"; }
# 高级参数：文件缺失或越界时回落到默认值。
read_setting() {
  read_value "$1" || value=''
  setting_value="$2"
  if snum "$value" && [ "$value" -ge "$3" ] && [ "$value" -le "$4" ]; then setting_value="$value"; fi
  setting_sign=''
  case "$setting_value" in -*) setting_sign=-; setting_value="${setting_value#-}";; esac
  while [ "${setting_value#0}" != "$setting_value" ]; do setting_value="${setting_value#0}"; done
  setting_value="$setting_sign${setting_value:-0}"
}
file_num() { read_setting "$@"; printf '%s' "$setting_value"; }
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
cutoff_gap() { file_num "$GAPF" "$DEFAULT_GAP" "$GAP_MIN" "$GAP_MAX"; }
load_early_params() {
  read_setting "$EARLYGAPF" -10 -50 0; early_gap="$setting_value"; [ "${#early_gap}" -le 3 ] || early_gap=-10
  read_setting "$EARLYSTEPF" 200 0 1000; early_step="$setting_value"; [ "${#early_step}" -le 4 ] || early_step=200
}
soc_on() { read_value "$SOCENF" && [ "$value" = on ]; }
soc_now() {
  read_value /sys/class/power_supply/battery/capacity || return 1
  capacity="$value"
  num "$capacity" && [ "$capacity" -ge 0 ] && [ "$capacity" -le 100 ] || return 1
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
read_rule_text() {
  rule_text=''; rule_text_valid=YES; rule_line=''
  if [ ! -e "$1" ]; then
    case "$1" in
      "$PRANGESF") rule_text='0,90';;
      "$D/auto-control.ufcs.soc-ranges") rule_text='0,60,10700,8000,50,100,500,-50
61,70,10700,8000,50,100,1000,-50';;
    esac
    return 0
  fi
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then rule_text_valid=NO; return; fi
  while IFS= read -r rule_line || [ -n "$rule_line" ]; do
    rule_text="$rule_text$rule_line
"
    [ "${#rule_text}" -le 26000 ] || { rule_text_valid=NO; break; }
  done < "$1"
}
soc_edit() (
  fields="${3:-8}"
  K="$D/.soc-settings-lock"
  if [ "$fields" = 2 ]; then K="$D/.pulse-settings-lock"; SOCRF="$PRANGESF"; fi
  lock || fail SOC_SETTINGS_BUSY
  trap unlock EXIT
  old_rules=''
  read_rule_text "$SOCRF"
  [ "$rule_text_valid" = YES ] || fail SOC_CONFIG_INVALID
  old_rules="$(printf '%s\n' "$rule_text" | soc_validate "$fields")" || fail SOC_CONFIG_INVALID
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
  read_proto_vote_max "$1"
  read_proto_limit "$1"
  read_setting "$INITF" "$DEFAULT_INITIAL" "$INITIAL_MIN" "$INITIAL_MAX"; effective_initial="$setting_value"
  read_setting "$IVLF" "$DEFAULT_INTERVAL" "$INTERVAL_MIN" "$INTERVAL_MAX"; effective_interval="$setting_value"
  read_setting "$RSTEPF" "$DEFAULT_RAISE_STEP" "$RAISE_STEP_MIN" "$RAISE_STEP_MAX"; effective_raise="$setting_value"
  read_setting "$LSTEPF" "$DEFAULT_LOWER_STEP" "$LOWER_STEP_MIN" "$LOWER_STEP_MAX"; effective_lower="$setting_value"
  read_setting "$GAPF" "$DEFAULT_GAP" "$GAP_MIN" "$GAP_MAX"; effective_gap="$setting_value"
  soc_match=NONE
  soc_percent=UNKNOWN
  soc_valid=YES
  soc_rows=''
  soc_now && soc_percent="$capacity" || soc_percent=UNKNOWN
  [ "$1" = ufcs ] || return 0
  read_rule_text "$SOCRF"
  soc_raw="$rule_text"
  if [ "$rule_text_valid" != YES ]; then soc_valid=NO; return 0; fi
  # 仅规则文本改变时重新校验，循环内不为相同区间启动 awk。
  if [ "${soc_cache_loaded:-NO}" != YES ] || [ "$soc_raw" != "${soc_cache_raw:-}" ]; then
    soc_cache_raw="$soc_raw"; soc_cache_loaded=YES; soc_cache_valid=YES
    soc_cache_rows="$(printf '%s' "$soc_raw" | soc_validate)" || soc_cache_valid=NO
  fi
  soc_valid="$soc_cache_valid"; [ "$soc_valid" = YES ] || return 0
  soc_rows="$soc_cache_rows"
  soc_on && [ "$soc_percent" != UNKNOWN ] || return 0
  while IFS=, read -r sr_start sr_end sr_max sr_initial sr_interval sr_raise sr_lower sr_gap; do
    [ -n "$sr_start" ] || continue
    if [ "$soc_percent" -ge "$sr_start" ] && [ "$soc_percent" -le "$sr_end" ]; then
      soc_match="$sr_start,$sr_end"
      effective_max="$sr_max"; effective_initial="$sr_initial"; effective_interval="$sr_interval"
      effective_raise="$sr_raise"; effective_lower="$sr_lower"; effective_gap="$sr_gap"
      break
    fi
  done <<EOF
$soc_rows
EOF
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
thermal_on() { [ ! -e "$TENF" ] || { read_value "$TENF" && [ "$value" = on ]; }; }
thermal_limit() { file_num "$TLIMF" "$DEFAULT_THERMAL_LIMIT" 20 60; }
thermal_vote() { file_num "$TVOTEF" "$DEFAULT_THERMAL_VOTE" 500 5000; }
thermal_gap() { file_num "$TGAPF" "$DEFAULT_THERMAL_GAP" 1 5; }
pulse_on() { read_value "$PENF" && [ "$value" = on ]; }
pulse_config() {
  p_enabled=NO; pulse_on && p_enabled=YES
  read_setting "$PCHARGEF" "$DEFAULT_PULSE_CHARGE" 1 1200; p_charge="$setting_value"
  read_setting "$PPAUSEF" "$DEFAULT_PULSE_PAUSE" 0 60000; p_pause="$setting_value"
  p_valid=YES
  read_rule_text "$PRANGESF"
  if [ "$rule_text_valid" != YES ]; then p_valid=NO; p_ranges=''
  else
    if [ "${pulse_cache_loaded:-NO}" != YES ] || [ "$rule_text" != "${pulse_cache_raw:-}" ]; then
      pulse_cache_raw="$rule_text"; pulse_cache_loaded=YES; pulse_cache_valid=YES
      pulse_cache_ranges="$(printf '%s' "$rule_text" | soc_validate 2)" || pulse_cache_valid=NO
    fi
    p_valid="$pulse_cache_valid"; p_ranges="$pulse_cache_ranges"
  fi
  soc_now && p_soc="$capacity" || p_soc=UNKNOWN
  p_match=ALL
  if [ -n "$p_ranges" ]; then
    p_match=NONE
    if [ "$p_soc" != UNKNOWN ]; then
      while IFS=, read -r pr_start pr_end; do
        [ -n "$pr_start" ] || continue
        if [ "$p_soc" -ge "$pr_start" ] && [ "$p_soc" -le "$pr_end" ]; then p_match="$pr_start,$pr_end"; break; fi
      done <<EOF
$p_ranges
EOF
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
  read_clock || { pulse_reset CLOCK_ERROR; return; }
  pulse_now="$clock_ms"
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
  read_clock || { pulse_error=CLOCK_ERROR; return; }
  pulse_started="$clock_ms"
  duration=$((p_charge * 1000)); [ "$pulse_state" != PAUSED ] || duration="$p_pause"
  pulse_deadline=$((pulse_started + duration)); pulse_pending=0
}
pulse_sleep() {
  case "$pulse_state" in CHARGING|PAUSED)
    if [ "$pulse_deadline" -gt 0 ]; then
      read_clock || return 0
      sleep_now="$clock_ms"
      remaining=$((pulse_deadline - sleep_now))
      [ "$remaining" -gt 0 ] || remaining=1
      if [ "$remaining" -lt "$sleep_ms" ]; then sleep_ms="$remaining"; set_interval "$sleep_ms"; fi
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
  temperature_sign=''
  case "$temperature" in -*) temperature_sign=-; temperature="${temperature#-}";; esac
  while [ "${temperature#0}" != "$temperature" ]; do temperature="${temperature#0}"; done
  printf '%s' "$temperature_sign${temperature:-0}"
}
thermal_update() {
  previous_thermal="$thermal_state"
  if ! thermal_on; then
    thermal_state=OFF
    thermal_held=0
    thermal_sample_at=-1
  else
    read_clock && sample_now="$clock_seconds" || sample_now=''
    if ! num "$sample_now" || [ "$thermal_sample_at" != "$sample_now" ]; then
      thermal_temp="$(temperature_now)" || thermal_temp=''
      thermal_sample_at="$sample_now"
    fi
    read_setting "$TLIMF" "$DEFAULT_THERMAL_LIMIT" 20 60; tlimit="$setting_value"
    read_setting "$TGAPF" "$DEFAULT_THERMAL_GAP" 1 5; tgap="$setting_value"
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
  read_setting "$TVOTEF" "$DEFAULT_THERMAL_VOTE" 500 5000; thermal_cap="$setting_value"
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
# 单个设置原子保存三种模式，兼容原有 on/off，避免两个开关同时生效。
faketemp_mode() {
  if [ ! -e "$FTENF" ]; then printf FIXED; return; fi
  read_value "$FTENF" || value=off
  case "$value" in on) printf FIXED;; adaptive) printf ADAPTIVE;; *) printf OFF;; esac
}
faketemp_on() { [ "$(faketemp_mode)" = FIXED ]; }
faketemp_value() { file_num "$FTVALF" "$DEFAULT_FAKETEMP" "$FAKETEMP_MIN" "$FAKETEMP_MAX"; }
faketemp_offset() { file_num "$FTOFFSETF" 5 0 20; }
faketemp_running() ( DK="$D/.fake-temp-daemon.lock"; daemon_running; )
faketemp_start() (
  faketemp_running && return 0
  nohup sh "$0" --faketemp-run >/dev/null 2>&1 </dev/null &
  tries=0
  until faketemp_running; do
    tries=$((tries + 1)); [ "$tries" -lt 20 ] || return 1
    sleep 0.05
  done
)
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
faketemp_release() {
  restored=0
  if [ -e "$SHELL_TEMP" ]; then chmod 0666 "$SHELL_TEMP" 2>/dev/null || restored=1; fi
  case "$(faketemp_horae_state)" in
    TEST_SENT|ERROR) faketemp_horae false || restored=1;;
  esac
  return "$restored"
}
faketemp_live() {
  save_setting "$FTLIVE" "$(boot_id):$(uptime_s):$1:$2:$3"
}
faketemp_sample() {
  fake_real=UNKNOWN; fake_target=UNKNOWN; fake_sample=PENDING
  IFS=: read -r fake_boot fake_at fake_read fake_written fake_result 2>/dev/null < "$FTLIVE" || return 0
  [ "$fake_boot" = "$(boot_id)" ] && num "$fake_at" || return 0
  fake_now="$(uptime_s)" || return 0
  [ "$fake_now" -ge "$fake_at" ] && [ $((fake_now - fake_at)) -le 5 ] || return 0
  case "$fake_result" in
    APPLIED)
      snum "$fake_read" && snum "$fake_written" || return 0
      [ "$fake_written" -eq $((fake_read - $(faketemp_offset) * 10)) ] || return 0
      fake_real="$fake_read"; fake_target="$fake_written"; fake_sample=APPLIED;;
    SENSOR_ERROR) fake_sample=SENSOR_ERROR;;
  esac
}
faketemp_apply() {
  fake_mode="$(faketemp_mode)"
  [ "$fake_mode" != OFF ] || { faketemp_release; return; }
  fake_deci="$(faketemp_value)"
  if [ "$fake_mode" = ADAPTIVE ]; then
    if ! fake_real="$(temperature_now)"; then
      faketemp_release || :
      faketemp_live UNKNOWN UNKNOWN SENSOR_ERROR || :
      return 1
    fi
    fake_deci=$((fake_real - $(faketemp_offset) * 10))
  fi
  [ -e "$SHELL_TEMP" ] || return 1
  # horae 切模式可能重置节点，先切换，再写温度并锁定。
  if [ "$fake_mode" = FIXED ] || [ "$(faketemp_horae_state)" != TEST_SENT ]; then
    chmod 0666 "$SHELL_TEMP" 2>/dev/null || return 1
    faketemp_horae || return 1
  fi
  if faketemp_write "$fake_deci"; then
    if [ "$fake_mode" = ADAPTIVE ] && ! faketemp_live "$fake_real" "$fake_deci" APPLIED; then
      faketemp_release || :
      return 1
    fi
    return 0
  fi
  faketemp_release || :
  return 1
}
faketemp_write() {
  # 节点按毫摄氏度接收；本地设置以 0.1°C 存储，故放大 100 倍。
  milli=$(( $1 * 100 ))
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
  fake_mode="${1:-$(faketemp_mode)}"
  [ "$fake_mode" != OFF ] || { printf 'OFF'; return 0; }
  [ -e "$SHELL_TEMP" ] || { printf 'UNAVAILABLE'; return 0; }
  if [ "$fake_mode" = ADAPTIVE ]; then
    faketemp_running || { printf PENDING; return 0; }
    faketemp_sample
    [ "$fake_sample" = APPLIED ] || { printf '%s' "$fake_sample"; return 0; }
  fi
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
  fake_mode="$(faketemp_mode)"
  fen=NO; [ "$fake_mode" != FIXED ] || fen=YES
  faen=NO; fake_real=UNKNOWN; fake_target=UNKNOWN
  if [ "$fake_mode" = ADAPTIVE ]; then
    faen=YES
    if faketemp_running; then faketemp_sample; fi
  fi
  printf 'FAKETEMP_ENABLED=%s;FAKETEMP_VALUE_DECI=%s;FAKETEMP_STATE=%s;FAKETEMP_HORAE_STATE=%s;FAKETEMP_ADAPTIVE_ENABLED=%s;FAKETEMP_OFFSET_C=%s;FAKETEMP_REAL_DECI=%s;FAKETEMP_TARGET_DECI=%s;\n' \
    "$fen" "$(faketemp_value)" "$(faketemp_state "$fake_mode")" "$(faketemp_horae_state)" \
    "$faen" "$(faketemp_offset)" "$fake_real" "$fake_target"
}
# 模式切换、参数保存和每次写入共用一把锁，旧模式不能覆盖新设置。
faketemp_edit() (
  mkdir -p "$D" || return 1
  K="$D/.fake-temp-lock"; tries=0
  until lock; do
    tries=$((tries + 1)); [ "$tries" -lt 100 ] || return 1
    sleep 0.1
  done
  trap unlock EXIT
  case "$1" in
    --faketemp-enable) save_setting "$FTENF" on || return 1;;
    --faketemp-disable) save_setting "$FTENF" off || return 1;;
    --faketemp-adaptive-enable) save_setting "$FTENF" adaptive || return 1;;
    --faketemp-adaptive-disable)
      [ "$(faketemp_mode)" = ADAPTIVE ] || return 0
      save_setting "$FTENF" off || return 1;;
    --faketemp-value-set) save_setting "$FTVALF" "$2" || return 1;;
    --faketemp-offset-set)
      save_setting "$FTOFFSETF" "$2" || return 1
      [ "$(faketemp_mode)" = ADAPTIVE ] || return 0;;
    --faketemp-tick) [ "$(faketemp_mode)" = ADAPTIVE ] || return 0;;
    --faketemp-stop)
      [ "$(faketemp_mode)" != ADAPTIVE ] || faketemp_release
      return $?;;
    --faketemp-ensure)
      if faketemp_on && [ "$(faketemp_state)" = APPLIED ]; then return 0; fi;;
  esac
  if [ "$1" != --faketemp-tick ] && [ "$(faketemp_mode)" = ADAPTIVE ]; then
    faketemp_start || { faketemp_release; return 1; }
  fi
  faketemp_apply
)
faketemp_run() {
  mkdir -p "$D" || exit 4
  DK="$D/.fake-temp-daemon.lock"
  background_ready || exit 3
  daemon_lock || exit 0
  trap 'faketemp_edit --faketemp-stop >/dev/null 2>&1 || :; daemon_unlock' EXIT
  trap 'exit 0' HUP INT TERM
  while [ -f "$0" ]; do
    if [ "$(faketemp_mode)" = ADAPTIVE ]; then
      faketemp_edit --faketemp-tick >/dev/null 2>&1 || :
    fi
    sleep 1
  done
}
set_interval() {
  case "$1" in ?) ivl="0.00$1";; ??) ivl="0.0$1";; *) ivl="0.$1";; esac
}
voltage_now() {
  read_value /sys/class/power_supply/battery/voltage_now || return 1
  voltage="$value"
  num "$voltage" && [ "$voltage" -ge 1000000 ] && [ "$voltage" -le 20000000 ]
}
# 首次接管、切区间及恢复阶段不能用高初始值绕过电压检查。
voltage_start_clamp() {
  if [ "$voltage_state" = SENSOR_ERROR ] || [ "$v" -ge "$luv" ]; then
    [ "$target" -le "$VOTE_MIN" ] || target="$VOTE_MIN"
    [ "$voltage_state" = SENSOR_ERROR ] || voltage_state=LIMITED
  fi
}
load_handoff_params() {
  read_value "$D/auto-control.handoff.enabled" || value=''
  handoff_enabled=NO; [ "$value" != on ] || handoff_enabled=YES
  read_setting "$D/auto-control.handoff.soc" 100 0 100; handoff_soc="$setting_value"
  [ "${#handoff_soc}" -le 3 ] || handoff_soc=100
  read_value "$D/auto-control.handoff.bypass-enabled" || value=''
  handoff_bypass=YES; [ "$value" != off ] || handoff_bypass=NO
}
bypass_read() {
  bypass_state=UNKNOWN
  bypass_raw="$(timeout 2 settings --user current get system bypass_charge_state 2>/dev/null)" || return 0
  case "$bypass_raw" in 0) bypass_state=OFF;; 1) bypass_state=ON;; null) bypass_state=UNAVAILABLE;; esac
}
handoff_update() {
  load_handoff_params
  handoff_reason=''
  # settings 会启动系统进程，每秒查询一次，不叠加到每个电压监控周期。
  if [ "$handoff_bypass" = YES ]; then
    if [ "$bypass_checked" -lt 0 ] || [ "$loop_started" -le 0 ] ||
       [ "$loop_started" -lt "$bypass_checked" ] || [ $((loop_started - bypass_checked)) -ge 1000 ]; then
      bypass_read; bypass_checked="$loop_started"
    fi
    case "$bypass_state" in ON) handoff_reason=SYSTEM_BYPASS;; UNKNOWN) handoff_reason=SYSTEM_BYPASS_UNKNOWN;; esac
  else bypass_checked=-1; fi
  handoff_key="$current_boot:$handoff_soc"
  read_value "$HSL" || value=''
  handoff_saved="$value"
  if [ "$handoff_enabled" != YES ] || [ "$(readbit /sys/class/power_supply/usb/online)" = 0 ]; then
    [ ! -e "$HSL" ] || rm -f "$HSL"
  elif [ "$handoff_saved" = "$handoff_key" ]; then
    [ -n "$handoff_reason" ] || handoff_reason=SYSTEM_SOC
  elif [ "$(readbit /sys/class/power_supply/usb/online)" = 1 ] && soc_now && [ "$capacity" -ge "$handoff_soc" ]; then
    if ! save_setting "$HSL" "$handoff_key"; then handoff_reason=SYSTEM_HANDOFF_ERROR
    else [ -n "$handoff_reason" ] || handoff_reason=SYSTEM_SOC; fi
  elif [ -e "$HSL" ]; then rm -f "$HSL"; fi
}
handoff_status() {
  load_handoff_params
  bypass_read
  handoff_active=NO; handoff_live_reason=NONE
  if monitor_on && daemon_running && [ "$(live_get "$LIVE" PHASE)" = SYSTEM ]; then
    handoff_active=YES; handoff_live_reason="$(live_get "$LIVE" REASON)"
  fi
  printf 'HANDOFF_ENABLED=%s;HANDOFF_SOC=%s;HANDOFF_BYPASS_ENABLED=%s;BYPASS_STATE=%s;HANDOFF_ACTIVE=%s;HANDOFF_REASON=%s\n' \
    "$handoff_enabled" "$handoff_soc" "$handoff_bypass" "$bypass_state" "$handoff_active" "$handoff_live_reason"
}
# 后段轻微越界仍等待驱动响应；明显超限与读数异常由外层优先处理。
load_cv_params() {
  read_value "$D/auto-control.cv.enabled" || value=''
  cv_config_on=YES; [ "$value" != off ] || cv_config_on=NO
  read_setting "$D/auto-control.cv.start-soc" 80 0 100; cv_start="$setting_value"; [ "${#cv_start}" -le 3 ] || cv_start=80
  read_setting "$D/auto-control.cv.offset-mv" -5 -50 0; cv_offset="$setting_value"; [ "${#cv_offset}" -le 3 ] || cv_offset=-5
  read_setting "$D/auto-control.cv.band-mv" 5 1 15; cv_band="$setting_value"; [ "${#cv_band}" -le 2 ] || cv_band=5
  read_setting "$D/auto-control.cv.raise-ma" 50 10 500; cv_raise="$setting_value"; [ "${#cv_raise}" -le 3 ] || cv_raise=50
  read_setting "$D/auto-control.cv.lower-ma" 100 10 1000; cv_lower="$setting_value"; [ "${#cv_lower}" -le 4 ] || cv_lower=100
  read_setting "$D/auto-control.cv.wait-ms" 1500 200 10000; cv_wait="$setting_value"; [ "${#cv_wait}" -le 5 ] || cv_wait=1500
  read_setting "$D/auto-control.cv.fast-gap-mv" 15 0 50; cv_fast_gap="$setting_value"; [ "${#cv_fast_gap}" -le 2 ] || cv_fast_gap=15
}
cv_status() {
  load_cv_params
  cv_active=NO; cv_live_target=0
  if [ "$cv_config_on" = YES ] && monitor_on && daemon_running &&
      [ "$(live_get "$LIVE" PHASE)" = RUNNING ] && [ "$(live_get "$LIVE" CONTROL_CV)" = 1 ]; then
    cv_active=YES
    cv_live_target="$(live_get "$LIVE" CONTROL_TARGET_MV)"
  fi
  printf 'CV_ENABLED=%s;CV_START_SOC=%s;CV_BAND_MV=%s;CV_RAISE_MA=%s;CV_LOWER_MA=%s;CV_WAIT_MS=%s;CV_ACTIVE=%s;CV_TARGET_MV=%s;CV_OFFSET_MV=%s;CV_FAST_GAP_MV=%s\n' \
    "$cv_config_on" "$cv_start" "$cv_band" "$cv_raise" "$cv_lower" "$cv_wait" "$cv_active" "$cv_live_target" "$cv_offset" "$cv_fast_gap"
}
cv_step() {
  if [ "$loop_started" -le 0 ]; then
    [ "$target" -le "$VOTE_MIN" ] || target="$VOTE_MIN"
    return
  fi
  [ "$loop_started" -ge "$cv_next_at" ] || return 0
  read_value /sys/class/power_supply/battery/status || value=''
  [ "$value" != Full ] || [ "$v" -gt "$luv" ] || return 0
  if { [ "$v" -gt "$luv" ] || [ "$v" -gt $((cv_target_mv * 1000 + cv_band * 1000)) ]; } && [ "$target" -gt "$VOTE_MIN" ]; then
    cv_delta="$lstep"; [ "$cv_delta" -le "$cv_lower" ] || cv_delta="$cv_lower"
    target=$((target - cv_delta)); [ "$target" -ge "$VOTE_MIN" ] || target="$VOTE_MIN"
  elif [ "$v" -lt $((cv_target_mv * 1000 - cv_band * 1000)) ] && [ "$thermal_held" -eq 0 ] &&
       [ "$loop_started" -ge "$voltage_hold_until" ] && [ "$hr_block_raise" -eq 0 ] && [ "$target" -lt "$vm" ]; then
    cv_delta="$rstep"; [ "$cv_delta" -le "$cv_raise" ] || cv_delta="$cv_raise"
    target=$((target + cv_delta)); [ "$target" -le "$vm" ] || target="$vm"
  fi
}
write_vote() {
  read_value "$node/force_val" && num "$value" || return 1
  vote_previous_value="$value"
  printf '%s %s %s %s %s\n' "$current_boot" "$clock_seconds" "$$" "$target" "$ap" > "$L" || return 1
  if ! printf '%s' "$target" > "$node/force_val" 2>/dev/null; then
    printf '%s %s %s %s %s\n' "$current_boot" "$clock_seconds" "$$" "$vote_previous_value" "$ap" > "$L" 2>/dev/null || :
    return 1
  fi
  # 只有 force_active 写入才触发驱动回调；两次写入及保存值均须校验。
  printf '1' > "$node/force_active" 2>/dev/null || return 1
  read_value "$node/force_val" && [ "$value" = "$target" ] || return 1
  read_value "$node/force_active" && [ "$value" = 1 ] || return 1
  hr_last_write="$loop_started"
  if [ "$cv_enabled" -eq 1 ]; then cv_last_write="$loop_started"; cv_next_at=$((cv_last_write + cv_wait)); fi
  if [ "$early_pending" -eq 1 ]; then voltage_hold_until=$((loop_started + cv_wait)); fi
  return 0
}
# 用电流对小步投票的响应寻找生效点，不把电池侧电流直接换算成 UFCS/PPS 投票。
headroom_reset() {
  hr_cap=0; hr_pending=NONE; hr_direction=DOWN; hr_next_probe=0
  hr_window_at=0; hr_low=0; hr_high=0; hr_reference=0
  hr_origin=0; hr_probe=0; hr_observed=0; hr_key=''
  hr_current=''; hr_last_write="$loop_started"
}
headroom_current() {
  read_value /sys/class/power_supply/battery/status && [ "$value" = Charging ] || return 1
  read_value /sys/class/power_supply/battery/current_now && snum "$value" || return 1
  case "$value" in -*) hr_read="${value#-}";; *) return 1;; esac
  while [ "${hr_read#0}" != "$hr_read" ]; do hr_read="${hr_read#0}"; done
  hr_read="${hr_read:-0}"
  [ "$hr_read" -le 100000000 ] || return 1
  read_value /sys/class/power_supply/battery/model_name || return 1
  case "$value" in 'oplus battery') ;; *) hr_read=$((hr_read / 1000));; esac
  [ "$hr_read" -ge 100 ] && [ "$hr_read" -le 30000 ]
}
headroom_update() {
  hr_block_raise=0
  hr_context="$ap:$soc_match:$effective_max"
  if [ "$hr_key" != "$hr_context" ] || [ "$loop_started" -le 0 ] ||
      [ "$loop_ms" -lt 0 ] || [ "$loop_ms" -gt 5000 ]; then
    headroom_reset; hr_key="$hr_context"; hr_sample_at="$loop_started"
  fi
  if [ "$loop_started" -le 0 ] || [ "$voltage_state" = SENSOR_ERROR ] ||
      [ "$thermal_held" -ne 0 ] || [ "$pulse_state" = PAUSED ] ||
      [ -n "$pulse_error" ] || [ "$vote_error" -ne 0 ]; then
    headroom_reset; return
  fi
  [ "$hr_cap" -eq 0 ] || [ "$vm" -le "$hr_cap" ] || vm="$hr_cap"
  if [ "$target" -ne "$hr_observed" ]; then
    if [ "$hr_pending" != NONE ] && [ "$target" -ne "$hr_probe" ]; then
      hr_pending=NONE; hr_next_probe=$((loop_started + 5000))
    fi
    hr_observed="$target"; hr_window_at=0
  fi
  [ "$loop_started" -ge "$hr_sample_at" ] || return 0
  hr_sample_at=$((loop_started + 500))
  if ! headroom_current; then
    headroom_reset; hr_key="$hr_context"; vm="$effective_max"
    return
  fi
  hr_current="$hr_read"
  # 起步、写入响应、暂停恢复及电压调节期间不试探；保持已学到的上限。
  if [ $((loop_started - hr_last_write)) -lt 1500 ] ||
      [ "$loop_started" -lt "$cv_next_at" ] || [ "$loop_started" -lt "$voltage_hold_until" ] ||
      [ "$v" -ge $((luv - 30000)) ] || [ "$early_band" -eq 1 ] ||
      { [ "$cv_enabled" -eq 1 ] && [ "$v" -ge $(((cv_target_mv - cv_band) * 1000)) ]; } ||
      { [ "$pulse_state" = CHARGING ] && [ $((pulse_deadline - loop_started)) -lt 3000 ]; }; then
    hr_window_at=0
    return
  fi
  if [ "$hr_window_at" -eq 0 ]; then
    hr_window_at="$loop_started"; hr_low="$hr_read"; hr_high="$hr_read"; return
  fi
  [ "$hr_read" -ge "$hr_low" ] || hr_low="$hr_read"
  [ "$hr_read" -le "$hr_high" ] || hr_high="$hr_read"
  hr_noise=$((hr_high * 3 / 100)); [ "$hr_noise" -ge 150 ] || hr_noise=150
  if [ $((hr_high - hr_low)) -gt "$hr_noise" ]; then
    hr_window_at="$loop_started"; hr_low="$hr_read"; hr_high="$hr_read"; return
  fi
  [ $((loop_started - hr_window_at)) -ge 1000 ] || return 0
  hr_change=$((hr_reference / 100)); [ "$hr_change" -ge 75 ] || hr_change=75
  case "$hr_pending" in
    DOWN)
      if [ $((hr_reference - hr_high)) -ge "$hr_change" ]; then
        hr_cap="$hr_origin"; vm="$hr_cap"; hr_pending=NONE; hr_direction=UP
        hr_next_probe=$((loop_started + 10000)); hr_window_at=0
        log "HEADROOM_FOUND cap_ma=$hr_cap current_ma=$hr_current"
        return
      fi
      hr_pending=NONE
      ;;
    UP)
      hr_change=$((hr_reference / 400)); [ "$hr_change" -ge 25 ] || hr_change=25
      if [ $((hr_low - hr_reference)) -lt "$hr_change" ]; then
        hr_cap="$hr_origin"; target="$hr_origin"; hr_direction=DOWN
      else hr_direction=UP; fi
      vm="$hr_cap"; hr_pending=NONE; hr_block_raise=1
      hr_next_probe=$((loop_started + 10000)); hr_window_at=0; hr_observed="$target"
      log "HEADROOM_PROBE_DONE cap_ma=$hr_cap current_ma=$hr_current"
      return
      ;;
  esac
  [ "$loop_started" -ge "$hr_next_probe" ] || return 0
  hr_origin="$target"
  if [ "$hr_direction" = UP ]; then
    # 恢复能力只通过原升流步进试探，仍受恒压升流上限约束。
    [ "$cv_enabled" -eq 1 ] || [ "$v" -lt "$raise_uv" ] || return 0
    hr_step="$rstep"; [ "$hr_step" -le 200 ] || hr_step=200
    if [ "$cv_enabled" -eq 1 ] && [ "$hr_step" -gt "$cv_raise" ]; then hr_step="$cv_raise"; fi
    hr_probe=$((target + hr_step)); [ "$hr_probe" -le "$effective_max" ] || hr_probe="$effective_max"
  else
    [ "$target" -gt "$VOTE_MIN" ] || { hr_direction=UP; hr_next_probe=$((loop_started + 10000)); return; }
    hr_probe=$((target - 200)); [ "$hr_probe" -ge "$VOTE_MIN" ] || hr_probe="$VOTE_MIN"
  fi
  if [ "$hr_probe" -eq "$target" ]; then
    if [ "$hr_direction" = UP ]; then hr_direction=DOWN; else hr_direction=UP; fi
    hr_next_probe=$((loop_started + 10000)); return
  fi
  hr_reference="$hr_high"; hr_pending="$hr_direction"
  target="$hr_probe"; hr_cap="$target"; vm="$hr_cap"; hr_block_raise=1
  hr_window_at=0; hr_observed="$target"
  log "HEADROOM_PROBE_$hr_pending from_ma=$hr_origin target_ma=$target current_ma=$hr_current"
}
# 总开关「自动监测」：文件缺失或缺省即视为开，只有显式 off 才是关。
monitor_on() { read_value "$MON" || value=''; [ "$value" != off ]; }
write_live() {
  [ -d "$D" ] || return 0
  printf 'PHASE=%s\nPROTO=%s\nTARGET=%s\nREASON=%s\nTHERMAL_STATE=%s\nTHERMAL_BOOT=%s\nPULSE_STATE=%s\nPULSE_DEADLINE_MS=%s\n' \
    "$1" "$4" "$2" "$3" "$thermal_state" "$current_boot" "${pulse_error:-$pulse_state}" "$pulse_deadline" > "$LIVE.tmp.$$" 2>/dev/null &&
    printf 'CONTROL_VOLTAGE_UV=%s\nCONTROL_LIMIT_MV=%s\nLOOP_MS=%s\n' "${v:-UNKNOWN}" "${effective_limit_mv:-UNKNOWN}" "${loop_ms:-0}" >> "$LIVE.tmp.$$" 2>/dev/null &&
    printf 'CONTROL_CV=%s\nCONTROL_TARGET_MV=%s\n' "$cv_enabled" "$cv_target_mv" >> "$LIVE.tmp.$$" 2>/dev/null &&
    printf 'HEADROOM_CAP_MA=%s\nHEADROOM_PROBE=%s\nHEADROOM_CURRENT_MA=%s\n' "${hr_cap:-0}" "${hr_pending:-NONE}" "${hr_current:-UNKNOWN}" >> "$LIVE.tmp.$$" 2>/dev/null &&
    mv -f "$LIVE.tmp.$$" "$LIVE" 2>/dev/null && last_live_reason="$3" || :
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
background_ready() {
  group="$(awk -F: '$1==0{print $3;exit}' /proc/$$/cgroup 2>/dev/null)"
  case "$group" in /apps/*|/uid_*) ;; *) return 0;; esac
  # WebUI 启动的进程会继承应用冻结组；仅移动自身，避免页面关闭后投票失去反馈。
  if ! { printf '%s\n' "$$" > /sys/fs/cgroup/cgroup.procs; } 2>/dev/null ||
     ! grep -qx "$$" /sys/fs/cgroup/cgroup.procs 2>/dev/null; then
    log BACKGROUND_FREEZER_ERROR
    return 1
  fi
}
# 常驻控制循环：监测总开关开启即存活；关闭时撤销并退出（不常驻）。
control_run() {
  mkdir -p "$D" || exit 4
  daemon_lock || exit 0
  background_ready || { write_live IDLE 0 BACKGROUND_FREEZER_ERROR ''; exit 3; }
  trap 'pulse_mmi_restore >/dev/null 2>&1 || :; unlock; daemon_unlock' EXIT
  trap 'exit 0' HUP INT TERM
  pulse_mmi_recover || :
  owning=0
  target=0
  normal_target=0
  prev_target=0
  voltage_hold_until=0
  voltage_state=NORMAL
  previous_voltage_state=NORMAL
  previous_loop_ms=0
  vote_error=0
  proto=''
  previous_soc_match=NONE
  loop_started=0; hr_sample_at=0; hr_block_raise=0
  headroom_reset
  if [ "$(live_get "$LIVE" THERMAL_BOOT)" = "$(boot_id)" ]; then
    case "$(live_get "$LIVE" THERMAL_STATE)" in LIMITED|SENSOR_ERROR) thermal_held=1;; esac
  fi
  while :; do
    loop_started=0; loop_ms=0; early_pending=0; early_band=0
    if read_clock; then
      loop_started="$clock_ms"
      [ "$previous_loop_ms" -eq 0 ] || loop_ms=$((loop_started - previous_loop_ms))
      previous_loop_ms="$loop_started"
    fi
    read_setting "$IVLF" "$DEFAULT_INTERVAL" "$INTERVAL_MIN" "$INTERVAL_MAX"
    set_interval "$setting_value"
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
    handoff_update
    if [ -n "$handoff_reason" ]; then
      # 先撤销自身投票，再恢复自身的 MMI 暂停；清理失败时不能声称系统已接管。
      if [ -e "$L" ]; then
        if { [ "$owning" -eq 0 ] && ! lock; } || ! revoke_own; then
          write_live IDLE 0 SYSTEM_HANDOFF_ERROR ''
          [ "$owning" -ne 0 ] || unlock
          sleep "$ivl"; continue
        fi
      fi
      unlock; owning=0; proto=''; target=0; normal_target=0
      headroom_reset
      cv_enabled=0; cv_next_at=0; cv_target_mv=0; cv_last_write=0
      pulse_idle
      if [ -n "$pulse_error" ]; then
        write_live IDLE 0 MMI_RECOVERY_REQUIRED ''
      elif [ "$handoff_reason" = SYSTEM_HANDOFF_ERROR ]; then
        write_live IDLE 0 SYSTEM_HANDOFF_ERROR ''
      else
        [ "${last_live_reason:-}" = "$handoff_reason" ] || log "$handoff_reason"
        write_live SYSTEM 0 "$handoff_reason" ''
      fi
      sleep "$ivl"; continue
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
      cv_enabled=0; cv_next_at=0; cv_target_mv=0; cv_last_write=0
      headroom_reset
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
    set_interval "$effective_interval"
    lmv="$effective_limit_mv"
    luv=$((lmv * 1000))
    raise_uv=$((luv + effective_gap * 1000))
    load_cv_params
    load_early_params
    previous_cv="$cv_enabled"
    if [ "$owning" -eq 0 ]; then cv_enabled=0; cv_next_at=0; cv_last_write=0; fi
    if [ "${previous_cv_start:-$cv_start}" != "$cv_start" ]; then cv_enabled=0; fi
    previous_cv_start="$cv_start"
    cv_exit=$((cv_start - 2)); [ "$cv_exit" -ge 0 ] || cv_exit=0
    if [ "$soc_percent" != UNKNOWN ]; then
      if [ "$soc_percent" -ge "$cv_start" ]; then cv_enabled=1
      elif [ "$soc_percent" -lt "$cv_exit" ]; then cv_enabled=0; fi
    fi
    [ "$cv_config_on" = YES ] || cv_enabled=0
    if [ "$cv_enabled" -eq 0 ]; then cv_next_at=0; cv_last_write=0
    elif [ "$cv_last_write" -gt 0 ]; then cv_next_at=$((cv_last_write + cv_wait)); fi
    cv_target_mv=0
    if [ "$cv_enabled" -eq 1 ]; then
      cv_target_mv=$((lmv + cv_offset))
    fi
    if [ "$previous_cv" != "$cv_enabled" ]; then log "CV_MODE_$cv_enabled target_mv=$cv_target_mv"; fi
    voltage_state=NORMAL
    if voltage_now; then v="$voltage"
    else v=''; voltage_state=SENSOR_ERROR; fi
    if [ "$voltage_state" != SENSOR_ERROR ] && [ "$early_gap" -lt 0 ] && [ "$early_step" -gt 0 ] &&
        [ "$v" -ge $((luv + early_gap * 1000)) ] && [ "$v" -le "$luv" ]; then early_band=1; fi
    if [ "$owning" -eq 0 ]; then
      headroom_reset
      if lock; then
        target="$effective_initial"
        # 首次写入也受协议上限和温控限制，避免先写入较高初始值。
        max="$effective_max"
        [ "$target" -le "$max" ] || target="$max"
        if [ "$cv_enabled" -eq 1 ] && [ "$target" -gt "$VOTE_MIN" ]; then target="$VOTE_MIN"; fi
        voltage_start_clamp
        thermal_clamp
        normal_target="$target"
        pulse_update
        if write_vote; then
          vote_error=0
          owning=1
          proto="$ap"
          log "START_ADAPTIVE_$target"
          pulse_commit
          write_live RUNNING "$target" STARTED "$ap"
        else
          [ "$vote_error" -eq 1 ] || log "VOTE_WRITE_ERROR target_ma=$target voltage_uv=${v:-UNKNOWN}"
          vote_error=1
          revoke_own 2>/dev/null || :
          write_live IDLE 0 VOTE_WRITE_ERROR "$ap"
          unlock
        fi
      fi
    else
      prev_target=$target
      target="$normal_target"
      range_changed=0
      if [ "$soc_match" != "$previous_soc_match" ]; then
        [ "$cv_enabled" -eq 1 ] || target="$effective_initial"
        range_changed=1
      fi
      vm="$effective_max"
      rstep="$effective_raise"
      lstep="$effective_lower"
      gap="$effective_gap"
      headroom_update
      if [ "$voltage_state" = SENSOR_ERROR ] || { [ "$range_changed" -eq 1 ] && [ "$cv_enabled" -eq 0 ]; }; then voltage_start_clamp
      elif [ "$pulse_state" != PAUSED ]; then
        if [ "$v" -gt "$luv" ] && [ "$target" -gt "$VOTE_MIN" ] &&
           { [ "$cv_enabled" -eq 0 ] || [ "$v" -ge $((luv + cv_fast_gap * 1000)) ]; }; then
          # 调度晚于监控周期时补齐降流步数；升流不补步，避免延迟造成大幅跳升。
          lower_count=$((loop_ms / effective_interval))
          [ "$lower_count" -gt 0 ] || lower_count=1
          lower_max=$(((target - VOTE_MIN + lstep - 1) / lstep))
          [ "$lower_count" -le "$lower_max" ] || lower_count="$lower_max"
          target=$((target - lstep * lower_count))
          [ "$target" -ge "$VOTE_MIN" ] || target=$VOTE_MIN
        elif [ "$early_band" -eq 1 ]; then
          if [ "$target" -gt "$VOTE_MIN" ]; then
            if [ "$loop_started" -le 0 ]; then target="$VOTE_MIN"
            elif [ "$loop_started" -ge "$voltage_hold_until" ] &&
                { [ "$cv_enabled" -eq 0 ] || [ "$loop_started" -ge "$cv_next_at" ]; }; then
              target=$((target - early_step)); [ "$target" -ge "$VOTE_MIN" ] || target="$VOTE_MIN"
              early_pending=1
            fi
          fi
        elif [ "$cv_enabled" -eq 1 ]; then cv_step
        elif [ "$v" -lt "$raise_uv" ] && [ "$target" -lt "$vm" ] && [ "$thermal_held" -eq 0 ] &&
             [ "$loop_started" -gt 0 ] && [ "$loop_started" -ge "$voltage_hold_until" ] && [ "$hr_block_raise" -eq 0 ]; then
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
          # 保留已收敛的目标，避免每次恢复都重新冲到上限。
          target="$normal_target"
          voltage_start_clamp
          thermal_clamp
          normal_target="$target"
        fi
        read_value "$node/force_val" && current_vote="$value" || current_vote=UNKNOWN
        if [ "$vote_error" -eq 1 ] || [ "$pulse_resuming" -eq 1 ] || [ "$target" -ne "$prev_target" ] ||
           [ "$target" != "$current_vote" ]; then
          if ! write_vote; then
            [ "$vote_error" -eq 1 ] || log "VOTE_WRITE_ERROR target_ma=$target voltage_uv=${v:-UNKNOWN}"
            vote_error=1
            target="$prev_target"; normal_target="$prev_target"
            write_live RUNNING "$target" VOTE_WRITE_ERROR "$ap"
            sleep "$ivl"
            continue
          fi
          if [ "$vote_error" -eq 1 ]; then log VOTE_WRITE_RECOVERED; fi
          vote_error=0
          pulse_commit
          write_live RUNNING "$target" ADJUSTED "$ap"
          pulse_resuming=0
        fi
      fi
      read_value "$node/force_active" || value=''
      if [ "$pulse_state" != PAUSED ] && [ "$value" != 1 ]; then
        revoke_own 2>/dev/null || :
        unlock
        owning=0
        proto=''
        log 'FINISHED_OWNERSHIP_CHANGED'
        pulse_idle
        write_live IDLE 0 OWNERSHIP_CHANGED ''
      fi
    fi
    if [ "$voltage_state" != SENSOR_ERROR ] && [ "$v" -gt "$luv" ]; then
      voltage_state=LIMITED
      voltage_hold_until=$((loop_started + 1000))
    elif [ "$voltage_state" = NORMAL ] && [ "$loop_started" -lt "$voltage_hold_until" ]; then
      voltage_state=RECOVERING
    fi
    if [ "$early_band" -eq 1 ] && [ "$voltage_state" != SENSOR_ERROR ]; then voltage_state=EARLY; fi
    if [ "$voltage_state" != "$previous_voltage_state" ]; then
      log "VOLTAGE_$voltage_state voltage_uv=${v:-UNKNOWN} limit_mv=$lmv target_ma=$target loop_ms=$loop_ms"
      previous_voltage_state="$voltage_state"
    fi
    previous_soc_match="$soc_match"
    if [ "$owning" -eq 1 ]; then
      pulse_commit
      live_reason=ADJUSTED
      [ "$cv_enabled" -eq 0 ] || live_reason=VOLTAGE_TRACKING
      case "$voltage_state" in
        LIMITED) live_reason=VOLTAGE_LIMITED;;
        RECOVERING) live_reason=VOLTAGE_RECOVERING;;
        EARLY) live_reason=VOLTAGE_EARLY;;
        SENSOR_ERROR) live_reason=VOLTAGE_SENSOR_ERROR;;
      esac
      case "$thermal_state" in
        LIMITED) live_reason=THERMAL_LIMITED;;
        SENSOR_ERROR) live_reason=THERMAL_SENSOR_ERROR;;
      esac
      if [ "$pulse_state" = PAUSED ]; then live_reason=PULSE_PAUSED; fi
      case "$pulse_state" in CLOCK_ERROR|CONFIG_ERROR) live_reason=PULSE_ERROR;; esac
      if [ -n "$pulse_error" ]; then live_reason=PULSE_ERROR; fi
      # 正常起步原因保留到第一次目标变化，温控状态则每轮更新。
      if [ "$live_reason" = ADJUSTED ] && [ "${last_live_reason:-}" = STARTED ]; then live_reason=STARTED; fi
      write_live RUNNING "$target" "$live_reason" "$ap"
      sleep_ms="$effective_interval"
      # 监控时间包含本轮处理开销，不再额外叠加一个完整的等待间隔。
      if [ "$loop_started" -gt 0 ] && read_clock; then
        sleep_ms=$((loop_started + effective_interval - clock_ms))
        [ "$sleep_ms" -gt 0 ] || sleep_ms=1
      fi
      set_interval "$sleep_ms"
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
  --early-gap-set|--early-step-set)
    [ "$#" -eq 2 ] || exit 2
    snum "$2" && [ "${#2}" -le 4 ] || { echo INVALID_EARLY_VALUE >&2; exit 2; }
    load_early_params
    if [ "$CMD" = --early-gap-set ]; then
      [ "$2" -ge -50 ] && [ "$2" -le 0 ] || { echo INVALID_EARLY_VALUE >&2; exit 2; }
      path="$EARLYGAPF"; key=EARLY_GAP_MV
    else
      [ "$2" -ge 0 ] && [ "$2" -le 1000 ] || { echo INVALID_EARLY_VALUE >&2; exit 2; }
      [ "$early_gap" -lt 0 ] || [ "$2" -eq 0 ] || { echo EARLY_GAP_DISABLED >&2; exit 2; }
      path="$EARLYSTEPF"; key=EARLY_STEP_MA
    fi
    mkdir -p "$D" || fail STORAGE
    save_setting "$path" "$2" || fail STORAGE
    printf '%s=%s\n' "$key" "$2"
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
  --cv-enable|--cv-disable)
    [ "$#" -eq 1 ] || exit 2
    mkdir -p "$D" || fail STORAGE
    value=off; [ "$CMD" != --cv-enable ] || value=on
    save_setting "$D/auto-control.cv.enabled" "$value" || fail STORAGE
    echo CV_SAVED
    ;;
  --cv-start-set|--cv-offset-set|--cv-band-set|--cv-raise-set|--cv-lower-set|--cv-wait-set|--cv-fast-gap-set)
    [ "$#" -eq 2 ] || exit 2
    if [ "$CMD" = --cv-offset-set ]; then
      snum "$2" && [ "${#2}" -le 3 ] || { echo INVALID_CV_VALUE >&2; exit 2; }
    else
      case "$2" in 0) ;; ''|0*|*[!0-9]*) echo INVALID_CV_VALUE >&2; exit 2;; esac
    fi
    case "$CMD" in
      --cv-start-set) path="$D/auto-control.cv.start-soc"; lo=0; hi=100;;
      --cv-offset-set) path="$D/auto-control.cv.offset-mv"; lo=-50; hi=0;;
      --cv-band-set) path="$D/auto-control.cv.band-mv"; lo=1; hi=15;;
      --cv-raise-set) path="$D/auto-control.cv.raise-ma"; lo=10; hi=500;;
      --cv-lower-set) path="$D/auto-control.cv.lower-ma"; lo=10; hi=1000;;
      --cv-wait-set) path="$D/auto-control.cv.wait-ms"; lo=200; hi=10000;;
      --cv-fast-gap-set) path="$D/auto-control.cv.fast-gap-mv"; lo=0; hi=50;;
    esac
    snum "$2" && [ "${#2}" -le 5 ] && [ "$2" -ge "$lo" ] && [ "$2" -le "$hi" ] || { echo INVALID_CV_VALUE >&2; exit 2; }
    mkdir -p "$D" || fail STORAGE
    save_setting "$path" "$2" || fail STORAGE
    echo CV_SAVED
    ;;
  --cv-status)
    [ "$#" -eq 1 ] || exit 2
    cv_status
    ;;
  --handoff-enable|--handoff-disable|--handoff-bypass-enable|--handoff-bypass-disable)
    [ "$#" -eq 1 ] || exit 2
    path="$D/auto-control.handoff.enabled"
    case "$CMD" in --handoff-bypass-*) path="$D/auto-control.handoff.bypass-enabled";; esac
    case "$CMD" in *-enable) value=on;; *) value=off;; esac
    mkdir -p "$D" || fail STORAGE
    save_setting "$path" "$value" || fail STORAGE
    # 关闭后立刻解除会话标记，重新开启时按当前电量判断。
    [ "$CMD" != --handoff-disable ] || rm -f "$HSL"
    echo HANDOFF_SAVED
    ;;
  --handoff-soc-set)
    [ "$#" -eq 2 ] || exit 2
    case "$2" in 0) ;; ''|0*|*[!0-9]*) echo INVALID_HANDOFF_VALUE >&2; exit 2;; esac
    num "$2" && [ "${#2}" -le 3 ] && [ "$2" -le 100 ] || { echo INVALID_HANDOFF_VALUE >&2; exit 2; }
    mkdir -p "$D" || fail STORAGE
    save_setting "$D/auto-control.handoff.soc" "$2" || fail STORAGE
    echo HANDOFF_SAVED
    ;;
  --handoff-status)
    [ "$#" -eq 1 ] || exit 2
    handoff_status
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
  --faketemp-enable|--faketemp-disable|--faketemp-adaptive-enable|--faketemp-adaptive-disable)
    [ "$#" -eq 1 ] || exit 2
    faketemp_edit "$@" >/dev/null 2>&1 || fail FAKETEMP_APPLY_FAILED
    case "$CMD" in
      --faketemp-enable) echo FAKETEMP_ENABLED=on;;
      --faketemp-disable) echo FAKETEMP_ENABLED=off;;
      *) faketemp_status;;
    esac
    ;;
  --faketemp-value-set)
    [ "$#" -eq 2 ] || { echo 'USAGE: --faketemp-value-set DECI' >&2; exit 2; }
    case "$2" in ''|0*|*[!0-9]*) echo INVALID_FAKETEMP_VALUE >&2; exit 2;; esac
    num "$2" && [ "$2" -ge "$FAKETEMP_MIN" ] && [ "$2" -le "$FAKETEMP_MAX" ] ||
      { echo INVALID_FAKETEMP_VALUE >&2; exit 2; }
    faketemp_edit "$@" >/dev/null 2>&1 || fail FAKETEMP_APPLY_FAILED
    echo "FAKETEMP_VALUE_DECI=$2"
    ;;
  --faketemp-offset-set)
    [ "$#" -eq 2 ] || exit 2
    case "$2" in 0|[1-9]|1[0-9]|20) ;; *) echo INVALID_FAKETEMP_OFFSET >&2; exit 2;; esac
    faketemp_edit "$@" >/dev/null 2>&1 || fail FAKETEMP_APPLY_FAILED
    echo "FAKETEMP_OFFSET_C=$2"
    ;;
  --faketemp-run)
    [ "$#" -eq 1 ] || exit 2
    faketemp_run
    ;;
  --faketemp-ensure)
    [ "$#" -eq 1 ] || exit 2
    faketemp_edit "$@" >/dev/null 2>&1 || fail FAKETEMP_APPLY_FAILED
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
    load_early_params
    printf 'EARLY_GAP_MV=%s;EARLY_STEP_MA=%s;' "$early_gap" "$early_step"
    printf '%s;' "$(soc_status)"
    printf '%s;' "$(pulse_status)"
    printf '%s' "$(faketemp_status)"
    printf '%s;' "$(cv_status)"
    printf '%s;' "$(handoff_status)"
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
    echo 'USAGE: --handoff-status|--handoff-enable|--handoff-disable|--handoff-soc-set PERCENT|--handoff-bypass-enable|--handoff-bypass-disable|--cv-status|--cv-enable|--cv-disable|--cv-start-set PERCENT|--cv-offset-set MV|--cv-band-set MV|--cv-raise-set MA|--cv-lower-set MA|--cv-wait-set MS|--cv-fast-gap-set MV|--status|--control-run|--monitor-enable|--monitor-disable|--monitor-ensure|--proto-enable PROTO|--proto-disable PROTO|--limit-set PROTO MV|--vote-max-set PROTO N|--vote-initial-set N|--interval-set MS|--raise-step-set N|--lower-step-set N|--cutoff-gap-set MV|--early-gap-set MV|--early-step-set MA|--soc-enable|--soc-disable|--soc-range-set CSV|--soc-range-delete CSV|--soc-status|--pulse-enable|--pulse-disable|--pulse-charge-set S|--pulse-pause-set MS|--pulse-range-set CSV|--pulse-range-delete CSV|--pulse-status|--thermal-enable|--thermal-disable|--thermal-limit-set C|--thermal-vote-set MA|--thermal-gap-set C|--thermal-status|--faketemp-enable|--faketemp-disable|--faketemp-value-set DECI|--faketemp-adaptive-enable|--faketemp-adaptive-disable|--faketemp-offset-set C|--faketemp-run|--faketemp-ensure|--faketemp-status|--recover' >&2
    exit 2
    ;;
esac
