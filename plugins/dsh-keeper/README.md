# @dsh-friends/dsh-keeper

`dsh --profile feishu` 进程保活：装在**主 profile**（web）里，发现飞书渠道进程缺失就自动拉起；崩溃按 backoff 重启（10s 起步、上限 5 分钟）；检测到手动启动的存量进程会主动让位，不产生双实例。

## 可移植默认值

- 所有路径默认落在 `$DSH_HOME`（未设则 `~/.dsh`）
- dsh 入口默认取宿主进程自己的入口，识别不到回退 PATH 上的 `dsh`
- 全部可被 profile config 覆盖：`bin` / `profile` / `logFile` / `exitFile` / `keeperLog` / `home` / `dshHome`

## 说明

- 进程探测走 `/proc`（Linux/容器最佳）；无 `/proc` 环境自动退化为仅自托管子进程管理
- 停用方式：config `enabled: false`；主进程退出时托管子进程一并终止
