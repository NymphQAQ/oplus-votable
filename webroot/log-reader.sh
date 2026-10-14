#!/system/bin/sh
# WebUI 只读适配器：仅可查询本模块日志、电池读数和 UFCS 投票状态。
# 不接受任意文件路径/命令；不向 /proc/oplus-votable 写入任何值。
set -u
DIR='/data/adb/oplus-votable'
LOG="$DIR/events.log"
PREV="$DIR/events.log.prev"
LOCK="$DIR/.watchdog_lock"
MODE="${1:---status}"

# 固定路径只读探针：无写操作；不可读/格式异常返回 UNKNOWN。
probe_text() {
  [ -r "$1" ] || { printf 'UNKNOWN'; return; }
  value="$(head -c 96 "$1" 2>/dev/null)" || { printf 'UNKNOWN'; return; }
  case "$value" in
    ''|*[!a-zA-Z0-9_.-]*) printf 'UNKNOWN' ;;
    *) printf '%s' "$value" ;;
  esac
}

# 电流电压 sysfs 标准接口按 uA / uV 读取，失效或越界不参与估算。
probe_uint() {
  value="$(probe_text "$1")"
  case "$value" in ''|*[!0-9]*|UNKNOWN) printf 'UNKNOWN'; return ;; esac
  [ "${#value}" -le 10 ] || { printf 'UNKNOWN'; return; }
  printf '%s' "$value"
}

# 只读单个 Votable status 的 effective 行；输出原始值和投票者名称。
# 不读取 vote/check_points，也不尝试使投票生效。
probe_effective() {
  path="$1"
  [ -r "$path" ] || { printf 'UNKNOWN UNKNOWN'; return; }
  awk '
    NR>128 {exit}
    $2 ~ /^effective=(none|[A-Z0-9_]+)$/ &&
      $3 ~ /^type=(Min|Max|Set_any)$/ && $4 ~ /^v=-?[0-9]+$/ && NF==4 {
      owner=$2; sub(/^effective=/,"",owner)
      raw=$4; sub(/^v=/,"",raw)
      if (length(owner)<=64 && length(raw)<=16) print raw, owner
      exit
    }
  ' "$path" 2>/dev/null | awk 'NF==2 {print; found=1} END{if(!found)print "UNKNOWN UNKNOWN"}'
}

# OPLUS MMS 只在当前选择的 item_id 为 0 时解释 ONLINE 位。
# 不主动修改 item_id，也不将其它 item 的 data 错当在线状态。
probe_mms_online() {
  item="$(probe_text "$1/item_id")"
  data="$(probe_text "$1/data")"
  if [ "$item" = 0 ]; then
    case "$data" in 0|1) printf '%s' "$data" ;; *) printf 'UNKNOWN' ;; esac
  else
    printf 'UNKNOWN'
  fi
}

case "$MODE" in
  --status)
    state='STOPPED'
    if [ -r "$LOCK/owner" ]; then
      owner="$(cat "$LOCK/owner" 2>/dev/null || echo INVALID)"
      current_boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo UNKNOWN)"
      lock_boot="${owner%%:*}"
      lock_pid="${owner#*:}"
      case "$lock_pid" in ''|*[!0-9]*) lock_pid='INVALID' ;; esac
      if [ "$lock_boot" = "$current_boot" ] && [ "$lock_pid" != INVALID ] &&
          kill -0 "$lock_pid" 2>/dev/null; then
        state='RUNNING'
      fi
    fi
    # SukiSU 某些 WebUI 版本只返回命令 stdout 的最后一行。
    # 将所有元数据一次输出在同一行，不依赖换行传递。
    current='NO'
    bytes='0'
    previous='NO'
    if [ -r "$LOG" ]; then
      current='YES'
      bytes="$(wc -c < "$LOG" 2>/dev/null | tr -d '[:space:]')"
      case "$bytes" in ''|*[!0-9]*) bytes='UNKNOWN' ;; esac
    fi
    [ ! -r "$PREV" ] || previous='YES'
    printf 'WATCHDOG=%s;CURRENT_LOG=%s;CURRENT_BYTES=%s;PREVIOUS_LOG=%s\n' \
      "$state" "$current" "$bytes" "$previous"
    ;;
  --battery)
    raw="$(dumpsys battery 2>/dev/null)" || raw=''
    temp="$(printf '%s\n' "$raw" | awk -F ': ' '/^[[:space:]]*temperature:/ {print $2;exit}')"
    ac="$(printf '%s\n' "$raw" | awk -F ': ' '/^[[:space:]]*AC powered:/ {print $2;exit}')"
    usb="$(printf '%s\n' "$raw" | awk -F ': ' '/^[[:space:]]*USB powered:/ {print $2;exit}')"
    voltage="$(cat /sys/class/power_supply/battery/voltage_now 2>/dev/null)" || voltage=''
    current="$(cat /sys/class/power_supply/battery/current_now 2>/dev/null)" || current='UNKNOWN'
    if ! printf '%s\n' "$current" | grep -Eq '^-?[0-9]{1,12}$'; then current='UNKNOWN'; fi
    case "$temp" in ''|*[!0-9]*) temp='UNKNOWN';; esac
    case "$voltage" in ''|*[!0-9]*) voltage='UNKNOWN';; esac
    if [ "$temp" != UNKNOWN ] && { [ "$temp" -gt 1000 ] || [ "$temp" -lt 0 ]; }; then temp='UNKNOWN'; fi
    if [ "$voltage" != UNKNOWN ] && { [ "$voltage" -gt 20000000 ] || [ "$voltage" -lt 1000000 ]; }; then voltage='UNKNOWN'; fi
    power='UNKNOWN'
    if [ "$ac" = true ] || [ "$usb" = true ]; then power='POWERED'; fi
    if [ "$ac" = false ] && [ "$usb" = false ]; then power='UNPLUGGED'; fi
    printf 'BATTERY_TEMP_DECI=%s;BATTERY_VOLTAGE_UV=%s;POWER=%s;BATTERY_CURRENT_RAW=%s\n' \
      "$temp" "$voltage" "$power" "$current"
    ;;
  --protocol)
    # 不写任何 sysfs/proc 节点。MMS data 与 item_id 必须配对解读。
    mms='/sys/class/oplus_mms'
    usb='/sys/class/power_supply/usb'
    ufcs="$(probe_mms_online "$mms/ufcs")"
    vooc="$(probe_mms_online "$mms/vooc")"
    pps="$(probe_mms_online "$mms/pps")"
    real_type="$(probe_text "$usb/real_type")"
    usb_type="$(probe_text "$usb/type")"
    pd_active="$(probe_text "$usb/pd_active")"
    pps_active="$(probe_text "$usb/pps_active")"
    usb_online="$(probe_text "$usb/online")"
    wireless_online="$(probe_text /sys/class/power_supply/wireless/online)"
    cpa_item="$(probe_text "$mms/cpa/item_id")"
    cpa_data="$(probe_text "$mms/cpa/data")"
    # dumpsys 仅用于辅助判断是否有外部供电，避免拔线后的残留信息。
    battery_dump="$(dumpsys battery 2>/dev/null)" || battery_dump=''
    power='UNKNOWN'
    if printf '%s\n' "$battery_dump" | grep -Eq '^[[:space:]]*(AC|USB|Wireless) powered: true$'; then
      power='YES'
    elif [ -n "$battery_dump" ] &&
         [ "$(printf '%s\n' "$battery_dump" | grep -Ec '^[[:space:]]*(AC|USB|Wireless) powered: false$')" -eq 3 ]; then
      power='NO'
    fi
    printf 'UFCS=%s;VOOC=%s;PPS=%s;USB_REAL_TYPE=%s;USB_TYPE=%s;PD_ACTIVE=%s;PPS_ACTIVE=%s;USB_ONLINE=%s;WIRELESS_ONLINE=%s;POWER=%s;CPA_ITEM_ID=%s;CPA_DATA=%s\n' \
      "$ufcs" "$vooc" "$pps" "$real_type" "$usb_type" "$pd_active" "$pps_active" \
      "$usb_online" "$wireless_online" "$power" "$cpa_item" "$cpa_data"
    ;;
  --negotiation)
    # 只读交叉快照：USB power_supply 报告的输入能力 ≠ PD/PPS APDO 能力表。
    # 仅使用固定节点，不写 sysfs/proc，不猜测充电线和充电器的额定能力。
    usb='/sys/class/power_supply/usb'
    volt="$(probe_uint "$usb/voltage_now")"
    vmax="$(probe_uint "$usb/voltage_max")"
    cmax="$(probe_uint "$usb/current_max")"
    icl="$(probe_uint "$usb/input_current_limit")"
    cnow="$(probe_uint "$usb/current_now")"
    usb_online="$(probe_text "$usb/online")"
    case "$usb_online" in 0|1) : ;; *) usb_online='UNKNOWN' ;; esac
    # 断开 USB 时，系统可能保留上次协议/电流档位，不展示残留为当前协商。
    if [ "$usb_online" != 1 ]; then
      volt='UNKNOWN'; vmax='UNKNOWN'; cmax='UNKNOWN'; icl='UNKNOWN'; cnow='UNKNOWN'
    fi
    soc="$(probe_uint /sys/class/power_supply/battery/capacity)"
    temp="$(probe_uint /sys/class/power_supply/battery/temp)"
    # 同时只允许一个 OPLUS 协议报告在线，避免借用非当前协议的 force_val。
    proto='NONE'
    count=0
    for candidate in ufcs vooc pps; do
      if [ "$(probe_mms_online "/sys/class/oplus_mms/$candidate")" = 1 ]; then
        proto="$candidate"
        count=$((count + 1))
      fi
    done
    [ "$count" -eq 1 ] || proto='NONE'
    vote_dir=''
    case "$proto" in
      ufcs) vote_dir='/proc/oplus-votable/UFCS_CURR' ;;
      vooc) vote_dir='/proc/oplus-votable/VOOC_CURR' ;;
      pps) vote_dir='/proc/oplus-votable/PPS_CURR' ;;
    esac
    effective='UNKNOWN'; voter='UNKNOWN'; fa='UNKNOWN'; fv='UNKNOWN'
    if [ -n "$vote_dir" ]; then
      set -- $(probe_effective "$vote_dir/status")
      effective="$1"; voter="$2"
      fa="$(probe_text "$vote_dir/force_active")"
      case "$fa" in 0|1) : ;; *) fa='UNKNOWN' ;; esac
      fv="$(probe_uint "$vote_dir/force_val")"
    fi
    # WIRED_* 为通用充电系统投票，可能并不约束当前 PPS/VOOC 路径。
    wired_icl='UNKNOWN'; wired_icl_owner='UNKNOWN'
    wired_fcc='UNKNOWN'; wired_fcc_owner='UNKNOWN'
    if [ "$usb_online" = 1 ]; then
      set -- $(probe_effective /proc/oplus-votable/WIRED_ICL/status)
      wired_icl="$1"; wired_icl_owner="$2"
      set -- $(probe_effective /proc/oplus-votable/WIRED_FCC/status)
      wired_fcc="$1"; wired_fcc_owner="$2"
    fi
    printf 'USB_ONLINE=%s;USB_VOLTAGE_UV=%s;USB_VOLTAGE_MAX_UV=%s;USB_CURRENT_MAX_UA=%s;USB_INPUT_LIMIT_UA=%s;USB_CURRENT_NOW_UA=%s;SOC=%s;BATTERY_TEMP_DECI=%s;VOTE_PROTOCOL=%s;VOTE_EFFECTIVE=%s;VOTE_OWNER=%s;VOTE_FORCE_ACTIVE=%s;VOTE_FORCE_VAL=%s;WIRED_ICL_EFFECTIVE=%s;WIRED_ICL_OWNER=%s;WIRED_FCC_EFFECTIVE=%s;WIRED_FCC_OWNER=%s\n' \
      "$usb_online" "$volt" "$vmax" "$cmax" "$icl" "$cnow" "$soc" "$temp" \
      "$proto" "$effective" "$voter" "$fa" "$fv" \
      "$wired_icl" "$wired_icl_owner" "$wired_fcc" "$wired_fcc_owner"
    ;;
  --votables)
    # 只读枚举驱动实际存在的 Votable，严格限制目录名和输出字段。
    # 一次性 Base64 成单行，兼容仅返回最后一行 stdout 的 WebUI 桥接。
    # 不读取 vote/check_points，不接受用户路径，不向内核写入数据。
    votable_root='/proc/oplus-votable'
    if [ ! -d "$votable_root" ]; then
      printf 'VOTABLES_UNAVAILABLE\n'
    else
      printf 'VOTABLES_B64='
      (
        count=0
        for dir in "$votable_root"/*; do
          [ -d "$dir" ] && [ ! -L "$dir" ] || continue
          name="${dir##*/}"
          case "$name" in
            ''|*[!A-Z0-9_]* ) continue ;;
          esac
          count=$((count + 1))
          [ "$count" -le 128 ] || break

          active="$(cat "$dir/force_active" 2>/dev/null)" || active='?'
          case "$active" in 0|1) : ;; *) active='?' ;; esac
          force="$(cat "$dir/force_val" 2>/dev/null)" || force='?'
          case "$force" in
            ''|*[!0-9-]* ) force='?' ;;
            -* ) numeric="${force#-}"; case "$numeric" in ''|*[!0-9]*) force='?' ;; esac ;;
          esac
          [ "${#force}" -le 16 ] || force='?'
          printf 'G\t%s\t%s\t%s\n' "$name" "$active" "$force"
          if [ ! -r "$dir/status" ]; then
            printf 'R\t%s\tUNREADABLE\n' "$name"
            continue
          fi
          awk -v n="$name" '
            NR>128 {exit}
            $1==n":" && $2 ~ /^[A-Z0-9_]+:$/ && $3 ~ /^en=[01]$/ &&
              $4 ~ /^v=-?[0-9]+$/ && NF==4 {
              v=$2; sub(/:$/,"",v)
              en=$3; sub(/^en=/,"",en)
              val=$4; sub(/^v=/,"",val)
              printf "V\t%s\t%s\t%s\t%s\n",n,v,en,val
            }
            $1==n":" && $2 ~ /^effective=[A-Za-z0-9_]+$/ &&
              $3 ~ /^type=(Min|Max|Set_any)$/ && $4 ~ /^v=-?[0-9]+$/ && NF==4 {
              owner=$2; sub(/^effective=/,"",owner)
              typ=$3; sub(/^type=/,"",typ)
              val=$4; sub(/^v=/,"",val)
              printf "E\t%s\t%s\t%s\t%s\n",n,owner,typ,val
            }
          ' "$dir/status" 2>/dev/null
        done
      ) | base64 | tr -d '\r\n'
      printf '\n'
    fi
    ;;
  --votes)
    # 只读取固定的 UFCS_CURR/status，筛选投票行并打包为单行。
    # 不将驱动原始文本当作命令或 HTML；由前端再次严格解析。
    source='/proc/oplus-votable/UFCS_CURR/status'
    if [ ! -r "$source" ]; then
      printf 'VOTES_UNAVAILABLE\n'
    else
      printf 'VOTES_B64='
      awk '
        /^UFCS_CURR:[[:space:]]+[A-Z0-9_]+:[[:space:]]+en=[01][[:space:]]+v=-?[0-9]+$/ ||
        /^UFCS_CURR:[[:space:]]+effective=[A-Za-z0-9_]+[[:space:]]+type=[A-Za-z]+[[:space:]]+v=-?[0-9]+$/ {
          print
          count++
          if (count>=65) exit
        }
      ' "$source" 2>/dev/null | base64 | tr -d '\r\n'
      printf '\n'
    fi
    ;;
  --diagnostics)
    # 内核控制快照：所有字段均为只读；原始电流不假设单位是 mA。
    uf='/proc/oplus-votable/UFCS_CURR'
    fv="$(cat "$uf/force_val" 2>/dev/null)" || fv='UNKNOWN'
    fa="$(cat "$uf/force_active" 2>/dev/null)" || fa='UNKNOWN'
    case "$fv" in ''|*[!0-9]*) fv='UNKNOWN';; esac
    case "$fa" in 0|1) :;; *) fa='UNKNOWN';; esac
    effective="$(awk '/^UFCS_CURR:[[:space:]]+effective=/ {
      for (i=1;i<=NF;i++) if ($i ~ /^v=-?[0-9]+$/) {sub(/^v=/,"",$i);print $i;exit}
    }' "$uf/status" 2>/dev/null)"
    case "$effective" in ''|*[!0-9-]*) effective='UNKNOWN';; esac
    proto="$(cat /sys/class/oplus_mms/ufcs/data 2>/dev/null)" || proto='UNKNOWN'
    case "$proto" in 0|1) :;; *) proto='UNKNOWN';; esac
    current="$(cat /sys/class/power_supply/battery/current_now 2>/dev/null)" || current='UNKNOWN'
    case "$current" in ''|*[!0-9-]*) current='UNKNOWN';; esac
    disable="$(awk '/^UFCS_DISABLE:[[:space:]]+effective=/ {
      for (i=1;i<=NF;i++) if ($i ~ /^v=-?[0-9]+$/) {sub(/^v=/,"",$i);print $i;exit}
    }' /proc/oplus-votable/UFCS_DISABLE/status 2>/dev/null)"
    case "$disable" in 0|1) :;; *) disable='UNKNOWN';; esac
    chgfull="$(awk '/^UFCS_DISABLE:[[:space:]]+CHG_FULL_VOTER:/ {
      for (i=1;i<=NF;i++) if ($i ~ /^en=[01]$/) {sub(/^en=/,"",$i);print $i;exit}
    }' /proc/oplus-votable/UFCS_DISABLE/status 2>/dev/null)"
    case "$chgfull" in 0|1) :;; *) chgfull='UNKNOWN';; esac
    printf 'FORCE_ACTIVE=%s;FORCE_VAL=%s;UFCS_EFFECTIVE=%s;UFCS_ONLINE=%s;BATTERY_CURRENT_RAW=%s;UFCS_DISABLED=%s;CHG_FULL_ENABLED=%s\n' \
      "$fa" "$fv" "$effective" "$proto" "$current" "$disable" "$chgfull"
    ;;
  --kernel-ufcs)
    # 仅在用户主动点击时读取一次，并且只返回与 UFCS 电流请求/退出有关的内核行。
    # 这是一段历史日志，不等同于当前硬件电流。
    now="$(awk '{print int($1)}' /proc/uptime 2>/dev/null)"
    case "$now" in ''|*[!0-9]*) now='UNKNOWN';; esac
    printf 'KERNEL_NOW_UPTIME=%s;KERNEL_B64=' "$now"
    dmesg 2>/dev/null | awk '
      length($0)<=450 &&
      (/oplus_ufcs_current_work/ ||
       /success set vbus_mv = [0-9]+, ibus_ma = [0-9]+/ ||
       /oplus_ufcs_check_sw_full/ ||
       /normal hw full/ ||
       /CHG_FULL_VOTER set ufcs disable/ ||
       /exit ufcs fast charge/ ||
       /ufcs force exit/ ||
       /ufcs handshake error/ ||
       /ufcs reset notify/) {print}
    ' | tail -n 32 | base64 | tr -d '\r\n'
    printf '\n'
    ;;
  --latest|--previous)
    # 日志也转为一行 base64，保留多行日志内容并避免被 WebUI 桥接截成最后一条。
    if [ "$MODE" = '--latest' ]; then
      target="$LOG"
      missing='NO_LOGS_YET'
    else
      target="$PREV"
      missing='NO_PREVIOUS_LOG'
    fi
    if [ -r "$target" ]; then
      printf 'LOG_B64='
      tail -n 200 "$target" | base64 | tr -d '\r\n'
      printf '\n'
    else
      printf '%s\n' "$missing"
    fi
    ;;
  *)
    printf 'INVALID_ACTION\n' >&2
    exit 2
    ;;
esac
