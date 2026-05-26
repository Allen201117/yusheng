#!/usr/bin/env bash
# 余声 v2 数据备份脚本
# 用法：./scripts/backup.sh
# 效果：把 data/ 打包成 data/backups/yusheng-YYYYMMDD-HHMM.tar.gz
# 建议配合 cron 每天跑一次：
#   0 3 * * * cd /path/to/yusheng-v2 && ./scripts/backup.sh >> data/backups/backup.log 2>&1

set -euo pipefail

cd "$(dirname "$0")/.."

DATA_DIR="${DATA_DIR:-./data}"
BACKUP_DIR="${DATA_DIR}/backups"
TIMESTAMP=$(date +"%Y%m%d-%H%M")
BACKUP_FILE="${BACKUP_DIR}/yusheng-${TIMESTAMP}.tar.gz"
KEEP_DAYS="${KEEP_DAYS:-7}"  # 默认保留最近 7 天的备份

echo "[$(date)] 开始备份..."

mkdir -p "${BACKUP_DIR}"

# 打包 data/ 下除 backups/ 以外的所有内容
tar -czf "${BACKUP_FILE}" \
  --exclude="${DATA_DIR}/backups" \
  -C . \
  data/

SIZE=$(du -sh "${BACKUP_FILE}" | cut -f1)
echo "[$(date)] 备份完成: ${BACKUP_FILE} (${SIZE})"

# 清理旧备份
DELETED=$(find "${BACKUP_DIR}" -name "yusheng-*.tar.gz" -mtime +${KEEP_DAYS} -delete -print | wc -l)
if [ "${DELETED}" -gt 0 ]; then
  echo "[$(date)] 清理了 ${DELETED} 个超过 ${KEEP_DAYS} 天的旧备份"
fi

# 清理超过 30 天的日志文件
LOG_DIR="${DATA_DIR}/logs"
if [ -d "${LOG_DIR}" ]; then
  LOGS_DELETED=$(find "${LOG_DIR}" -name "yusheng-*.log" -mtime +30 -delete -print | wc -l)
  if [ "${LOGS_DELETED}" -gt 0 ]; then
    echo "[$(date)] 清理了 ${LOGS_DELETED} 个超过 30 天的日志文件"
  fi
fi
