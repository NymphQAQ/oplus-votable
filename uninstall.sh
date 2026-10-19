#!/system/bin/sh
MODDIR="${0%/*}"
D='/data/adb/oplus-votable'
if [ -d "$D" ] && [ ! -L "$D" ]; then
  if [ -f "$MODDIR/charging-history.sh" ]; then
    sh "$MODDIR/charging-history.sh" --stop >/dev/null 2>&1 || :
  fi
  if [ -f "$MODDIR/charge-test.sh" ]; then
    sh "$MODDIR/charge-test.sh" --monitor-disable >/dev/null 2>&1 || :
    sh "$MODDIR/charge-test.sh" --pulse-disable >/dev/null 2>&1 || :
    sh "$MODDIR/charge-test.sh" --faketemp-disable >/dev/null 2>&1 || :
  fi
  rm -f "$D/events.log" "$D/events.log.prev" "$D/.watchdog_lock/owner" 2>/dev/null || :
  rmdir "$D/.watchdog_lock" 2>/dev/null || :
  rmdir "$D" 2>/dev/null || :
fi
exit 0
