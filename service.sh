#!/system/bin/sh
# 兼容 Magisk / KernelSU 的服务入口：独立运行，不 pkill、不 exec 其它进程。
MODDIR="${0%/*}"
while [ "$(getprop sys.boot_completed)" != '1' ]; do sleep 2; done
sleep 5
# 充电记录独立运行，自动监测关闭时也继续采样。
(
  while [ -f "$MODDIR/charging-history.sh" ]; do
    sh "$MODDIR/charging-history.sh" --run >/dev/null 2>&1
    sleep 5
  done
) &
# 温度伪装独立巡检，不能被常驻的租约守护阻塞；自适应模式由独立进程每秒更新。
(
  while [ -f "$MODDIR/charge-test.sh" ]; do
    sh "$MODDIR/charge-test.sh" --faketemp-ensure >/dev/null 2>&1
    sleep 5
  done
) &
# 「自动监测」总开关为开（默认）时拉起常驻控制守护；关闭时守护不启动、开机不自启。
# 守护器结束后延迟重启，只恢复本模块的控制租约与监测。
# 温度伪装开启时，/proc 在每次重启后重建，需重新切换 horae 模式、写入温度并将节点设为只读。
while :; do
  sh "$MODDIR/charge-test.sh" --monitor-ensure >/dev/null 2>&1
  sh "$MODDIR/watchdog.sh" --watch >/dev/null 2>&1
  sleep 15
done
