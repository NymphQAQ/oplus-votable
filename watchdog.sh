#!/system/bin/sh
# oplus-votable - 本模块控制租约守护。
# 发现本模块控制租约或 MMI 停充记录残留时，请求撤销自有投票并恢复 MMI。
# 唯一文件写入：私有数据目录下的 events.log/锁目录。
set -u
umask 077

DATA_DIR='/data/adb/oplus-votable'

MODE="${1:---watch}"
case "$MODE" in
  --watch) [ "$#" -eq 1 ] || exit 2 ;;
  *) echo 'usage: watchdog.sh --watch' >&2; exit 2 ;;
esac

INTERVAL="${OPLUS_VOTABLE_INTERVAL:-5}"
case "$INTERVAL" in ''|*[!0-9]*) echo 'invalid interval' >&2; exit 2;; esac
[ "$INTERVAL" -ge 2 ] && [ "$INTERVAL" -le 60 ] || { echo 'invalid interval 2..60' >&2; exit 2; }

say_event() {
  # 仅输出受控枚举，不包含设备身份及原始电流数据。
  line="$1"
  printf '%s\n' "$line"
  # 轻量级轮转，全部写入本模块私有的数据目录。
  if [ -f "$DATA_DIR/events.log" ]; then
    bytes="$(wc -c < "$DATA_DIR/events.log" 2>/dev/null || echo 0)"
    [ "$bytes" -lt 65536 ] || mv "$DATA_DIR/events.log" "$DATA_DIR/events.log.prev" 2>/dev/null || :
  fi
  printf '%s\n' "$line" >> "$DATA_DIR/events.log"
}

safe_number() {
  case "$1" in ''|*[!0-9]*) return 1;; esac
  [ "${#1}" -le 12 ] || return 1
  return 0
}

# UFCS/PPS 是可控节点，VOOC 仅为旧版本租约恢复保留节点可读检查。
preflight() {
  for p in UFCS_CURR VOOC_CURR PPS_CURR; do
    [ -r "/proc/oplus-votable/$p/status" ] && return 0
  done
  return 1
}

# 先准备私有日志目录，确保投票节点不可用时也能在 WebUI 中看到原因。
# 只创建 oplus-votable 的数据目录，不触碰任何充电节点。
mkdir -p "$DATA_DIR" || exit 4
chmod 700 "$DATA_DIR" 2>/dev/null || :

if ! preflight; then
  say_event 'state=UNSUPPORTED_CURR_NODE write=NEVER'
  exit 3
fi

# 同一 boot 内只允许一个守护实例；崩溃留下的过期锁才可清除。
LOCKDIR="$DATA_DIR/.watchdog_lock"
this_boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo UNKNOWN)"
[ "$this_boot" != UNKNOWN ] || exit 5
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  owner="$(cat "$LOCKDIR/owner" 2>/dev/null || echo UNKNOWN)"
  old_boot="${owner%%:*}"
  old_pid="${owner#*:}"
  if [ "$old_boot" = "$this_boot" ] && safe_number "$old_pid" && kill -0 "$old_pid" 2>/dev/null; then
    echo 'state=WATCHDOG_ALREADY_RUNNING write=NEVER'
    exit 0
  fi
  rm -f "$LOCKDIR/owner" 2>/dev/null || exit 5
  rmdir "$LOCKDIR" 2>/dev/null || exit 5
  mkdir "$LOCKDIR" 2>/dev/null || exit 5
fi
printf '%s:%s\n' "$this_boot" "$$" > "$LOCKDIR/owner" || exit 5
cleanup_lock() {
  owner="$(cat "$LOCKDIR/owner" 2>/dev/null || echo UNKNOWN)"
  if [ "$owner" = "$this_boot:$$" ]; then
    rm -f "$LOCKDIR/owner" 2>/dev/null || :
    rmdir "$LOCKDIR" 2>/dev/null || :
  fi
}
trap cleanup_lock EXIT
trap 'exit 0' HUP INT TERM

MODDIR="${0%/*}"
while :; do
  # 仅当本模块存在测试租约时，调用受固件/所有权保护的退出请求；
  # 该请求通过 charge-test.sh 撤销本模块自己的强制投票，不写其它任何节点。
  if { [ -f "$DATA_DIR/active-test.lease" ] || [ -f "$DATA_DIR/pulse-mmi.lease" ]; } && [ -f "$MODDIR/charge-test.sh" ]; then
    sh "$MODDIR/charge-test.sh" --recover >/dev/null 2>&1 || :
  fi
  sleep "$INTERVAL"
done
