#!/system/bin/sh
# 独立采样电池读数，只写本模块的充电记录目录。
set -u
umask 077
D='/data/adb/oplus-votable'
H="$D/charging-history"
K="$H/.lock"
B='/sys/class/power_supply/battery'
MODE="${1:---list}"
boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
id=''; started=0; last_ms=0; count=0; first_soc=''
epoch_ms=0; epoch=0

uint() { case "$1" in ''|*[!0-9]*) return 1;; esac; [ "${#1}" -le 15 ]; }
session_id() {
  part="${1%%-*}"; rest="${1#*-}"; code="${rest%%-*}"; suffix="${rest#*-}"
  [ "$rest" != "$1" ] && [ "$suffix" != "$rest" ] && uint "$part" && [ "${#part}" -ge 9 ] && [ "${#part}" -le 12 ] && [ "${#code}" = 8 ] && uint "$suffix" || return 1
  case "$code" in *[!a-f0-9]*) return 1;; esac
}
safe_dir() { [ ! -L "$D" ] && [ ! -L "$H" ]; }
valid_meta() {
  IFS=, read -r meta_id meta_start meta_end meta_duration meta_first meta_last meta_count meta_state <<EOF
$1
EOF
  [ "$meta_id" = "$2" ] &&
    [ "$1" = "$meta_id,$meta_start,$meta_end,$meta_duration,$meta_first,$meta_last,$meta_count,$meta_state" ] || return 1
  for meta_time in "$meta_start" "$meta_end"; do
    uint "$meta_time" && [ "${#meta_time}" -le 12 ] || return 1
    case "$meta_time" in *[1-9]*) ;; *) return 1;; esac
  done
  uint "$meta_duration" && uint "$meta_count" || return 1
  case "$meta_count" in *[1-9]*) ;; *) return 1;; esac
  for meta_soc in "$meta_first" "$meta_last"; do
    [ -n "$meta_soc" ] || continue
    uint "$meta_soc" && [ "${#meta_soc}" -le 3 ] && [ "$meta_soc" -le 100 ] || return 1
  done
  case "$meta_state" in ACTIVE|UNPLUGGED|INTERRUPTED) return 0;; *) return 1;; esac
}
number() {
  value=''; raw=''
  [ -r "$1" ] || return 0
  IFS= read -r raw < "$1" || :
  digits="${raw#-}"
  case "$digits" in ''|*[!0-9]*) return 0;; esac
  [ "${#digits}" -le 9 ] || return 0
  # 去掉前导零，避免 shell 将节点值当成八进制。
  while [ "${digits#0}" != "$digits" ]; do digits="${digits#0}"; done
  case "$raw" in -*) raw="-${digits:-0}";; *) raw="${digits:-0}";; esac
  [ "$raw" -ge "$2" ] && [ "$raw" -le "$3" ] && value="$raw"
  return 0
}
running() {
  [ -f "$K/owner" ] && [ ! -L "$K" ] && [ ! -L "$K/owner" ] || return 1
  owner=''; IFS= read -r owner < "$K/owner" || :
  pid="${owner#*:}"
  [ "${owner%%:*}" = "$boot" ] && uint "$pid" && [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null
}
connected() {
  known=0; power=UNKNOWN
  for supply in usb wireless ac; do
    online=''
    [ ! -r "/sys/class/power_supply/$supply/online" ] || IFS= read -r online < "/sys/class/power_supply/$supply/online" || :
    case "$online" in 1) power=1; return;; 0) known=1;; esac
  done
  if [ "$known" = 1 ]; then power=0; return; fi
  status=''
  [ ! -r "$B/status" ] || IFS= read -r status < "$B/status" || :
  case "$status" in
    Charging|Full) power=1;; Discharging) power=0;;
  esac
}
save_meta() {
  [ ! -L "$H/$id.meta" ] && [ ! -L "$H/$id.meta.tmp" ] || return 1
  printf '%s,%s,%s,%s,%s,%s,%s,%s\n' "$id" "$start_epoch" "$epoch" "$elapsed" "$first_soc" "$soc" "$count" "$1" > "$H/$id.meta.tmp" &&
    mv -f "$H/$id.meta.tmp" "$H/$id.meta"
}
finish_session() {
  [ -n "$id" ] || return 0
  save_meta "$1" || return 1
  rm -f "$H/.active" || return 1
  id=''
}
sample() {
  uptime=''
  read -r uptime _ < /proc/uptime || :
  seconds="${uptime%%.*}"; fraction="${uptime#*.}000"
  fraction="${fraction%"${fraction#???}"}"
  uint "$seconds" && uint "$fraction" || return 1
  now=$((seconds * 1000 + 1$fraction - 1000))
  if [ "$epoch_ms" = 0 ] || [ "$now" -lt "$epoch_ms" ] || [ $((now - epoch_ms)) -ge 1000 ]; then
    epoch="$(date +%s)"
    uint "$epoch" || return 1
    epoch_ms="$now"
  fi
  connected
  number "$B/capacity" 0 100; soc="$value"
  if [ "$power" = UNKNOWN ]; then return 0; fi
  if [ "$power" = 0 ]; then
    [ -z "$id" ] || elapsed=$((now - started))
    finish_session UNPLUGGED
    return
  fi
  if [ -n "$id" ] && { [ "$now" -lt "$last_ms" ] || [ $((now - last_ms)) -gt 10000 ]; }; then
    finish_session INTERRUPTED || return 1
  fi
  [ -z "$id" ] || [ "$now" != "$last_ms" ] || return 0
  if [ -z "$id" ]; then
    id="$epoch-${boot%%-*}-$now"
    session_id "$id" || return 1
    [ ! -e "$H/$id.csv" ] && [ ! -L "$H/$id.csv" ] || return 1
    start_epoch="$epoch"; started="$now"; count=0; first_soc="$soc"
    [ ! -L "$H/.active" ] && [ ! -L "$H/.active.tmp" ] || return 1
    printf '%s %s %s %s\n' "$id" "$boot" "$started" "$now" > "$H/.active.tmp" && mv -f "$H/.active.tmp" "$H/.active" || return 1
  fi
  number "$B/temp" -500 1500; temp="$value"
  number "$B/voltage_now" 1000000 20000000; voltage="$value"
  number "$B/current_now" -100000000 100000000; current="$value"
  # OPLUS battery 驱动的电流接口为 mA，其它标准 power_supply 接口为 µA。
  model=''
  [ ! -r "$B/model_name" ] || IFS= read -r model < "$B/model_name" || :
  if [ "$model" = 'oplus battery' ] && [ -n "$current" ]; then
    if [ "$current" -ge -100000 ] && [ "$current" -le 100000 ]; then current=$((current * 1000)); else current=''; fi
  fi
  elapsed=$((now - started))
  [ ! -L "$H/$id.csv" ] && [ ! -L "$H/.active" ] && [ ! -L "$H/.active.tmp" ] || return 1
  printf '%s,%s,%s,%s,%s,%s\n' "$epoch" "$elapsed" "$soc" "$temp" "$voltage" "$current" >> "$H/$id.csv" || return 1
  count=$((count + 1)); last_ms="$now"
  save_meta ACTIVE || return 1
}
cleanup() {
  [ "$(cat "$K/owner" 2>/dev/null)" = "$boot:$$" ] || return
  rm -f "$K/owner" "$K/error"
  rmdir "$K" 2>/dev/null || :
}
case "$MODE" in
  --ensure)
    [ "$#" = 1 ] && safe_dir || exit 2
    running && exit 0
    nohup sh "$0" --run >/dev/null 2>&1 </dev/null &
    ;;
  --run)
    [ "$#" = 1 ] && safe_dir && [ -n "$boot" ] || exit 2
    mkdir -p "$H" || exit 4
    if ! mkdir "$K" 2>/dev/null; then
      running && exit 0
      [ ! -L "$K" ] || exit 4
      rm -f "$K/owner" "$K/error"
      rmdir "$K" && mkdir "$K" || exit 4
    fi
    printf '%s:%s\n' "$boot" "$$" > "$K/owner" || exit 4
    trap cleanup EXIT
    trap 'exit 0' HUP INT TERM
    if [ -f "$H/.active" ] && [ ! -L "$H/.active" ]; then
      read -r old_id old_boot old_started old_last < "$H/.active"
      if session_id "$old_id" && [ -f "$H/$old_id.meta" ] && [ ! -L "$H/$old_id.meta" ] &&
          [ -f "$H/$old_id.csv" ] && [ ! -L "$H/$old_id.csv" ]; then
        # 半行属于上次崩溃留下的数据；保留旧文件，另开会话，避免拼接出伪造采样。
        complete="$(tail -c 1 "$H/$old_id.csv" | wc -l | tr -d '[:space:]')"
        if [ "$old_boot" = "$boot" ] && uint "$old_started" && uint "$old_last" && [ "$complete" = 1 ]; then
          id="$old_id"; started="$old_started"; last_ms="$old_last"
          IFS=, read -r _ start_epoch epoch elapsed first_soc soc count _ < "$H/$id.meta"
          count="$(wc -l < "$H/$id.csv" | tr -d '[:space:]')"
          last_row="$(tail -n 1 "$H/$id.csv")"
          last_elapsed="${last_row#*,}"; last_elapsed="${last_elapsed%%,*}"
          if uint "$last_elapsed" && uint "$start_epoch" && uint "$count"; then last_ms=$((started + last_elapsed)); else id=''; fi
        else
          [ ! -L "$H/$old_id.meta.tmp" ] || exit 4
          sed 's/,ACTIVE$/,INTERRUPTED/' "$H/$old_id.meta" > "$H/$old_id.meta.tmp" && mv -f "$H/$old_id.meta.tmp" "$H/$old_id.meta"
        fi
      fi
    fi
    while [ -f "$0" ]; do
      if sample; then [ ! -e "$K/error" ] || rm -f "$K/error"; else printf STORAGE_ERROR > "$K/error"; fi
      sleep 0.2
    done
    ;;
  --stop)
    [ "$#" = 1 ] && safe_dir || exit 2
    if running; then
      case "$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" in
        *"$0 --run"*) kill -TERM "$pid";;
      esac
    fi
    ;;
  --list)
    [ "$#" -le 2 ] && safe_dir || exit 2
    offset="${2:-0}"
    uint "$offset" && [ "$offset" -le 1000000 ] || exit 2
    alive=NO; running && alive=YES
    active=NONE
    if [ "$alive" = YES ] && [ -f "$H/.active" ] && [ ! -L "$H/.active" ]; then
      read -r candidate active_boot _ _ < "$H/.active"
      if [ "$active_boot" = "$boot" ] && session_id "$candidate"; then active="$candidate"; fi
    fi
    error=''
    [ ! -r "$K/error" ] || [ -L "$K/error" ] || IFS= read -r error < "$K/error" || :
    [ "$error" = STORAGE_ERROR ] || error=NONE
    printf 'HISTORY_RUNNING=%s;HISTORY_ACTIVE=%s;HISTORY_ERROR=%s;HISTORY_SESSIONS=' "$alive" "$active" "$error"
    more=NO; n=0; skipped=0; rows=''
    for file in $(printf '%s\n' "$H/"*.meta | sort -r); do
      [ -f "$file" ] && [ ! -L "$file" ] || continue
      candidate="${file##*/}"; candidate="${candidate%.meta}"
      session_id "$candidate" || continue
      row=''; IFS= read -r row < "$file" || :
      # 损坏摘要不能生成空条目或阻断其它记录；只读校验，原文件保留。
      if [ "${#row}" -gt 256 ] || ! valid_meta "$row" "$candidate"; then skipped=$((skipped + 1)); continue; fi
      n=$((n + 1)); [ "$n" -gt "$offset" ] || continue
      if [ "$n" -gt $((offset + 20)) ]; then more=YES; break; fi
      if [ "$candidate" != "$active" ]; then
        case "$row" in *,ACTIVE) row="${row%,ACTIVE},INTERRUPTED";; esac
      fi
      rows="$rows${rows:+:}$row"
    done
    printf '%s;HISTORY_MORE=%s;HISTORY_SKIPPED=%s\n' "${rows:-NONE}" "$more" "$skipped"
    ;;
  --read)
    { [ "$#" = 2 ] || [ "$#" = 4 ]; } && safe_dir && session_id "$2" || exit 2
    from="${3:-0}"; to="${4:-999999999999999}"
    uint "$from" && uint "$to" || exit 2
    # Android mksh 的 test 会截断大整数，毫秒范围交给 awk 比较。
    awk -v lo="$from" -v hi="$to" 'BEGIN {exit (lo+0>hi+0)}' || exit 2
    file="$H/$2.csv"
    [ -f "$file" ] && [ ! -L "$file" ] || { echo HISTORY_NOT_FOUND >&2; exit 3; }
    total="$(wc -l < "$file" | tr -d '[:space:]')"
    uint "$total" || exit 4
    bounds=NO; extent=0
    if [ -f "$H/$2.meta" ] && [ ! -L "$H/$2.meta" ]; then
      meta_id=''; meta_count=''
      IFS=, read -r meta_id _ _ extent _ _ meta_count _ < "$H/$2.meta" || :
      if [ "$meta_id" = "$2" ] && uint "$extent" && [ "$meta_count" = "$total" ]; then bounds=YES; fi
    fi
    if [ "$#" = 4 ]; then
      if [ "$bounds" = NO ]; then extent="$to"; fi
      bounds=YES
    fi
    printf 'HISTORY_ID=%s;HISTORY_TOTAL=%s;HISTORY_DATA_B64=' "$2" "$total"
    # 按真实时间分桶保留四项曲线的极值；只读取快照内完整行，原始 CSV 不变。
    awk -v file="$file" -v n="$total" -v lo="$from" -v hi="$to" -v bounds="$bounds" -v extent="$extent" '
      function in_window(line) {
        return split(line,a,",")==6 && a[2]~/^[0-9]+$/ && length(a[2])<=15 && a[2]>=lo && a[2]<=hi
      }
      function extremum(bucket,metric,value,idx,line, key) {
        if (value=="") return
        key=bucket ":" metric
        if (!(key in minv) || value+0<minv[key]) {minv[key]=value+0;mini[key]=idx;minrow[key]=line}
        if (!(key in maxv) || value+0>maxv[key]) {maxv[key]=value+0;maxi[key]=idx;maxrow[key]=line}
      }
      function bucket_point(idx,line, bucket,amps) {
        bucket=int((a[2]-start)*149/span)
        if (bucket<0) bucket=0
        if (bucket>148) bucket=148
        extremum(bucket,"soc",a[3],idx,line)
        extremum(bucket,"temp",a[4],idx,line)
        extremum(bucket,"voltage",a[5],idx,line)
        amps=a[6]+0;if (amps<0) amps=-amps
        if (a[5]!="" && a[6]!="") extremum(bucket,"power",a[5]*amps,idx,line)
      }
      BEGIN {
        if (extent>hi) extent=hi
        size=0;start=lo;span=extent-lo+1;if (span<1) span=1
        for (i=1;i<=n && (getline line < file)>0;i++) {
          if (in_window(line)) {
            if (!size) {first=i;firstrow=line;if (bounds!="YES") start=a[2]+0}
            last=i;lastrow=line;end=a[2]+0;size++
            if (size<=1201) small[size]=line
            if (bounds=="YES") bucket_point(i,line)
          } else if (a[2]~/^[0-9]+$/ && a[2]+0>hi) break
        }
        close(file)
        if (size<=1201) {for (i=1;i<=size;i++) print small[i];exit}
        if (bounds!="YES") {
          span=end-start+1
          for (i=1;i<=n && (getline line < file)>0;i++) if (in_window(line)) bucket_point(i,line)
          close(file)
        }
        keep[first]=firstrow;keep[last]=lastrow
        for (key in mini) {keep[mini[key]]=minrow[key];keep[maxi[key]]=maxrow[key]}
        for (i=1;i<=n;i++) if (i in keep) print keep[i]
      }
    ' | base64 | tr -d '\r\n'
    printf '\n'
    ;;
  *) echo 'USAGE: --ensure|--run|--stop|--list [OFFSET]|--read ID [FROM_MS TO_MS]' >&2; exit 2;;
esac
