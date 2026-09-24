#!/bin/sh
# 测试用假 security：吞掉 stdin，睡眠远超测试注入的超时时间
cat >/dev/null
sleep 5
exit 0
