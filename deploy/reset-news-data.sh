#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="/opt/news-radar"
DATA_DIR="$APP_ROOT/data"
DB_FILE="$DATA_DIR/news.db"
BACKUP_ROOT="$APP_ROOT/backups"
CONFIRMATION="${1:-}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "reset-news-data.sh 必须以 root 运行" >&2
  exit 1
fi
if [[ "$CONFIRMATION" != "--confirm-reset" ]]; then
  echo "拒绝执行：必须显式传入 --confirm-reset" >&2
  exit 1
fi
if [[ ! -f "$DB_FILE" || -L "$DB_FILE" ]]; then
  echo "数据库不存在或路径不是普通文件：$DB_FILE" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "缺少 sqlite3，无法创建一致性备份" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$BACKUP_ROOT/news-before-reset-$stamp.db"
service_was_active="$(systemctl is-active news-radar.service 2>/dev/null || true)"
scheduler_was_active="$(systemctl is-active news-radar-scheduler.service 2>/dev/null || true)"

restart_services() {
  if [[ "$service_was_active" == "active" ]]; then
    systemctl start news-radar.service >/dev/null 2>&1 || true
  fi
  if [[ "$scheduler_was_active" == "active" ]]; then
    systemctl start news-radar-scheduler.service >/dev/null 2>&1 || true
  fi
}
trap restart_services EXIT

systemctl stop news-radar-scheduler.service >/dev/null 2>&1 || true
systemctl stop news-radar.service
if [[ -e "$BACKUP_ROOT" && ( -L "$BACKUP_ROOT" || ! -d "$BACKUP_ROOT" ) ]]; then
  echo "备份目录不是可信普通目录：$BACKUP_ROOT" >&2
  exit 1
fi
install -d -m 0750 -o ubuntu -g ubuntu "$BACKUP_ROOT"
if [[ "$(realpath -e "$BACKUP_ROOT")" != "$(realpath -e "$APP_ROOT")/backups" ]]; then
  echo "备份目录越出应用目录：$BACKUP_ROOT" >&2
  exit 1
fi
if [[ -e "$backup" || -L "$backup" ]]; then
  echo "拒绝覆盖已有备份：$backup" >&2
  exit 1
fi
sqlite3 "$DB_FILE" "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 "$DB_FILE" ".backup '$backup'"
chmod 0640 "$backup"
chown ubuntu:ubuntu "$backup"
sha256sum "$backup" > "$backup.sha256"
chmod 0640 "$backup.sha256"
chown ubuntu:ubuntu "$backup.sha256"

sqlite3 "$DB_FILE" <<'SQL'
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
DELETE FROM workflow_ministry_reports;
DELETE FROM workflow_ministry_assignments;
DELETE FROM workflow_transitions;
DELETE FROM workflow_runs;
DELETE FROM workflow_cases;
DELETE FROM claim_evidence;
DELETE FROM claims;
DELETE FROM claims_fts;
DELETE FROM event_articles;
DELETE FROM event_versions;
DELETE FROM events;
DELETE FROM article_versions;
DELETE FROM articles;
DELETE FROM articles_fts;
DELETE FROM briefings;
DELETE FROM alerts;
DELETE FROM fetch_log;
DELETE FROM kv_store;
DELETE FROM sqlite_sequence
WHERE name IN (
  'workflow_ministry_reports',
  'workflow_ministry_assignments',
  'workflow_transitions',
  'claim_evidence',
  'event_versions',
  'article_versions',
  'alerts',
  'fetch_log'
);
UPDATE sources
SET last_fetch_at = NULL,
    last_success_at = NULL,
    consec_fails = 0,
    backoff_until = NULL,
    health = CASE WHEN enabled = 1 THEN 'unknown' ELSE health END;
COMMIT;
VACUUM;
PRAGMA optimize;
SQL

remaining="$(sqlite3 "$DB_FILE" "SELECT (SELECT count(*) FROM articles) + (SELECT count(*) FROM events) + (SELECT count(*) FROM claims) + (SELECT count(*) FROM workflow_cases) + (SELECT count(*) FROM briefings);")"
source_count="$(sqlite3 "$DB_FILE" "SELECT count(*) FROM sources;")"
if [[ "$remaining" != "0" || "$source_count" -lt 1 ]]; then
  echo "重置后校验失败：remaining=$remaining sources=$source_count；备份位于 $backup" >&2
  exit 1
fi

chown ubuntu:ubuntu "$DB_FILE"
systemctl start news-radar.service
service_was_active="inactive"
for _ in {1..90}; do
  if curl -fsS --max-time 5 http://127.0.0.1:8787/api/ready >/dev/null; then
    if [[ "$scheduler_was_active" == "active" ]]; then
      systemctl start news-radar-scheduler.service
      scheduler_was_active="inactive"
    fi
    echo "旧新闻数据已清理；保留来源 $source_count 个；备份：$backup"
    exit 0
  fi
  sleep 1
done

echo "数据已清理，但服务健康检查失败；备份位于 $backup" >&2
exit 1
