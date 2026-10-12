# 怎么写检查命令

准则：

- **退出码即语义**：0 = 健康且沉默；任何非 0 = 失败，stderr/stdout 的尾部（约 1500 字符）会被送进修复 Thread。让失败自己说话。
- **只读、幂等**：反复运行不改动状态、不产生副作用文件。
- **便宜**：单次运行上限 300 秒（由 Worker 端计时，超时被杀同样算失败）；毫秒级读完最好。
- **不依赖登录环境**：按非交互 shell 写（显式路径、不依赖 shell 配置）；注意 Worker 系统差异（macOS 与 GNU 工具行为不同）。
- **失败可行动**：输出里带上期望值与现状，修复者不用二次侦查。

示例：

- 根分区使用率 < 90%：
  `test $(df -Pk / | awk 'NR==2 {print $5}' | tr -d %) -lt 90`
- 证书 7 天内不过期（未临近过期时 exit 0）：
  `openssl x509 -checkend 604800 -noout -in /etc/ssl/certs/server.pem`
- 24 小时内有新备份文件：
  `find /backups -maxdepth 1 -type f -mmin -1440 | grep -q .`

上手前先干跑：用 bash 工具在目标 Worker 上运行同一命令——确认健康态返回 0，并人为制造失败，检查输出是否可读。
