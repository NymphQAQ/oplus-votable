#!/system/bin/sh
# 兼容 Magisk / KernelSU 的服务入口：独立运行，不 pkill、不 exec 其它进程。
MODDIR="${0%/*}"
while [ "$(getprop sys.boot_completed)" != '1' ]; do sleep 2; done
sleep 5
# 「自动监测」总开关为开（默认）时拉起常驻控制守护；关闭时守护不启动、开机不自启。
# 守护器结束后延迟重启，只恢复本模块的控制租约与监测。
while :; do
  sh "$MODDIR/charge-test.sh" --monitor-ensure >/dev/null 2>&1
  sh "$MODDIR/watchdog.sh" --watch >/dev/null 2>&1
  sleep 15
done