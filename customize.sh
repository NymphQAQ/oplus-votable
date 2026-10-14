#!/system/bin/sh
# 撤销旧版温度开关，旧进程会在下一轮停止；不写温度节点。
if [ -d /data/adb/oplus-votable ] && [ ! -L /data/adb/oplus-votable ]; then
  rm -f /data/adb/oplus-votable/temperature.enabled || abort '无法停止旧版温度写入'
fi
