#!/system/bin/sh
D='/data/adb/oplus-votable'
if [ -d "$D" ] && [ ! -L "$D" ]; then
  rm -f "$D/events.log" "$D/events.log.prev" "$D/.watchdog_lock/owner" 2>/dev/null || :
  rmdir "$D/.watchdog_lock" 2>/dev/null || :
  rmdir "$D" 2>/dev/null || :
fi
exit 0
