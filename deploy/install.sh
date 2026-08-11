#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVE="${1:-/tmp/news-radar-release.tgz}"
APP_ROOT="/opt/news-radar"
RELEASE_ID="${2:-$(date -u +%Y%m%dT%H%M%SZ)}"
RELEASES_ROOT="$APP_ROOT/releases"
RELEASE_DIR="$RELEASES_ROOT/$RELEASE_ID"
CURRENT_LINK="$APP_ROOT/current"
DATA_DIR="$APP_ROOT/data"
ENV_FILE="/etc/news-radar.env"
NGINX_CONF="/etc/nginx/nginx.conf"
NGINX_SITE="/etc/nginx/sites-available/news"
NGINX_ENABLED="/etc/nginx/sites-enabled/news"
SERVICE_UNIT="/etc/systemd/system/news-radar.service"
SCHEDULER_SERVICE_UNIT="/etc/systemd/system/news-radar-scheduler.service"
CERTWATCH_SCRIPT="/usr/local/bin/news-radar-certwatch.sh"
CERTWATCH_SERVICE="/etc/systemd/system/news-radar-certwatch.service"
CERTWATCH_TIMER="/etc/systemd/system/news-radar-certwatch.timer"
ROLLBACK_DIR="/tmp/news-radar-rollback-$RELEASE_ID"

RELEASE_CREATED=0
ROLLBACK_READY=0
DEPLOY_COMMITTED=0
OLD_CURRENT=""
SERVICE_WAS_ACTIVE="inactive"
SERVICE_WAS_ENABLED="disabled"
SCHEDULER_SERVICE_WAS_ACTIVE="inactive"
SCHEDULER_SERVICE_WAS_ENABLED="disabled"
TIMER_WAS_ACTIVE="inactive"
TIMER_WAS_ENABLED="disabled"

backup_path() {
  local source="$1"
  local name="$2"
  if [[ -e "$source" || -L "$source" ]]; then
    cp -a -- "$source" "$ROLLBACK_DIR/$name"
  else
    : > "$ROLLBACK_DIR/$name.absent"
  fi
}

restore_path() {
  local target="$1"
  local name="$2"
  rm -f -- "$target"
  if [[ ! -f "$ROLLBACK_DIR/$name.absent" ]]; then
    cp -a -- "$ROLLBACK_DIR/$name" "$target"
  fi
}

restore_enablement() {
  local unit="$1"
  local previous="$2"
  if [[ "$previous" == "enabled" ]]; then
    systemctl enable "$unit" >/dev/null 2>&1 || true
  else
    systemctl disable "$unit" >/dev/null 2>&1 || true
  fi
}

rollback_deploy() {
  set +e
  echo "发布失败，正在恢复应用、systemd 与 nginx 配置" >&2

  systemctl stop news-radar-scheduler.service || true

  if [[ -n "$OLD_CURRENT" ]]; then
    ln -sfn "$OLD_CURRENT" "$CURRENT_LINK"
  else
    rm -f -- "$CURRENT_LINK"
  fi

  restore_path "$SERVICE_UNIT" service-unit
  restore_path "$SCHEDULER_SERVICE_UNIT" scheduler-service-unit
  restore_path "$CERTWATCH_SCRIPT" certwatch-script
  restore_path "$CERTWATCH_SERVICE" certwatch-service
  restore_path "$CERTWATCH_TIMER" certwatch-timer
  systemctl daemon-reload
  restore_enablement news-radar.service "$SERVICE_WAS_ENABLED"
  restore_enablement news-radar-scheduler.service "$SCHEDULER_SERVICE_WAS_ENABLED"
  restore_enablement news-radar-certwatch.timer "$TIMER_WAS_ENABLED"

  if [[ "$SERVICE_WAS_ACTIVE" == "active" && -n "$OLD_CURRENT" ]]; then
    systemctl restart news-radar.service || true
  else
    systemctl stop news-radar.service || true
  fi
  if [[ "$SCHEDULER_SERVICE_WAS_ACTIVE" == "active" && -n "$OLD_CURRENT" ]]; then
    systemctl restart news-radar-scheduler.service || true
  else
    systemctl stop news-radar-scheduler.service || true
  fi
  if [[ "$TIMER_WAS_ACTIVE" == "active" ]]; then
    systemctl start news-radar-certwatch.timer || true
  else
    systemctl stop news-radar-certwatch.timer || true
  fi

  restore_path "$NGINX_CONF" nginx-conf
  restore_path "$NGINX_SITE" nginx-site
  restore_path "$NGINX_ENABLED" nginx-enabled
  nginx -t && systemctl reload nginx || true

  if [[ "$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)" != "$RELEASE_DIR" ]]; then
    rm -rf -- "$RELEASE_DIR"
  fi
}

on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$DEPLOY_COMMITTED" -ne 1 ]]; then
    if [[ "$ROLLBACK_READY" -eq 1 ]]; then
      rollback_deploy
    elif [[ "$RELEASE_CREATED" -eq 1 ]]; then
      rm -rf -- "$RELEASE_DIR"
    fi
  fi
  rm -rf -- "$ROLLBACK_DIR"
  exit "$status"
}
trap on_exit EXIT

if [[ "${EUID}" -ne 0 ]]; then
  echo "install.sh 必须以 root 运行" >&2
  exit 1
fi
if [[ ! "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "非法 RELEASE_ID：仅允许字母、数字、点、下划线和连字符" >&2
  exit 1
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "找不到发布包：$ARCHIVE" >&2
  exit 1
fi
if [[ ! -f "$ARCHIVE.sha256" ]]; then
  echo "找不到发布包校验文件：$ARCHIVE.sha256" >&2
  exit 1
fi
if ! id ubuntu >/dev/null 2>&1; then
  echo "服务器缺少 ubuntu 运行用户" >&2
  exit 1
fi
for protected_directory in "$APP_ROOT" "$RELEASES_ROOT" "$DATA_DIR"; do
  if [[ -L "$protected_directory" ]]; then
    echo "受保护目录不能是符号链接：$protected_directory" >&2
    exit 1
  fi
done
if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
  echo "$CURRENT_LINK 已存在但不是符号链接，拒绝覆盖" >&2
  exit 1
fi
if [[ -L "$CURRENT_LINK" ]]; then
  OLD_CURRENT="$(readlink -f "$CURRENT_LINK" || true)"
  if [[ -z "$OLD_CURRENT" || ! -d "$OLD_CURRENT" ]]; then
    echo "$CURRENT_LINK 指向无效发布目录，拒绝部署" >&2
    exit 1
  fi
  if [[ "$(dirname "$OLD_CURRENT")" != "$RELEASES_ROOT" ]]; then
    echo "$CURRENT_LINK 必须指向 $RELEASES_ROOT 的直接子目录，拒绝部署" >&2
    exit 1
  fi
fi
if [[ -e "$RELEASE_DIR" || -L "$RELEASE_DIR" ]]; then
  echo "发布目录已存在：$RELEASE_DIR" >&2
  exit 1
fi

(cd "$(dirname "$ARCHIVE")" && sha256sum -c -- "$(basename "$ARCHIVE.sha256")")
tar -tzf "$ARCHIVE" >/dev/null
mapfile -t archive_members < <(tar -tzf "$ARCHIVE")
for member in "${archive_members[@]}"; do
  normalized="${member#./}"
  [[ -z "$normalized" ]] && continue
  if [[ "$normalized" == /* || "$normalized" == *\\* || "$normalized" =~ (^|/)\.\.(/|$) ]]; then
    echo "发布包包含非法路径：$member" >&2
    exit 1
  fi
done
if tar -tvzf "$ARCHIVE" | awk 'substr($0, 1, 1) == "l" || substr($0, 1, 1) == "h" { found=1 } END { exit found ? 0 : 1 }'; then
  echo "发布包包含符号链接或硬链接，拒绝解压" >&2
  exit 1
fi

install -d -m 0755 "$APP_ROOT" "$RELEASES_ROOT"
install -d -m 0750 -o ubuntu -g ubuntu "$DATA_DIR"
install -d -m 0755 "$RELEASE_DIR"
RELEASE_CREATED=1
tar --no-same-owner --no-same-permissions -xzf "$ARCHIVE" -C "$RELEASE_DIR"

required_files=(
  package.json
  package-lock.json
  dist/server/index.mjs
  dist/server/scheduler-worker.mjs
  dist/client/index.html
  dist/client/sw.js
  dist/client/assets/index-B2Eg34rp.js
  dist/client/assets/index-b0lJDpbs.css
  deploy/preserve-hashed-assets.sh
  migrations/0000_tiny_nightcrawler.sql
  migrations/0001_massive_george_stacy.sql
  migrations/0002_careful_the_santerians.sql
  migrations/0003_flawless_blacklash.sql
  migrations/meta/_journal.json
  dist/migrations/0000_tiny_nightcrawler.sql
  dist/migrations/0001_massive_george_stacy.sql
  dist/migrations/0002_careful_the_santerians.sql
  dist/migrations/0003_flawless_blacklash.sql
  dist/migrations/meta/_journal.json
  deploy/nginx-news
  deploy/news-radar.service
  deploy/news-radar-scheduler.service
  deploy/news-radar-certwatch.sh
  deploy/news-radar-certwatch.service
  deploy/news-radar-certwatch.timer
)
for required in "${required_files[@]}"; do
  if [[ ! -f "$RELEASE_DIR/$required" ]]; then
    echo "发布包缺少必需文件：$required" >&2
    exit 1
  fi
done

source "$RELEASE_DIR/deploy/preserve-hashed-assets.sh"
preserve_hashed_assets "$RELEASES_ROOT" "$RELEASE_DIR"

chown -R ubuntu:ubuntu "$RELEASE_DIR"
dependencies_reused=0
if [[ -n "$OLD_CURRENT" \
  && -d "$OLD_CURRENT/node_modules" \
  && ! -L "$OLD_CURRENT/node_modules" \
  && -f "$OLD_CURRENT/package-lock.json" \
  && ! -L "$OLD_CURRENT/package-lock.json" ]] \
  && cmp -s "$OLD_CURRENT/package-lock.json" "$RELEASE_DIR/package-lock.json"; then
  if cp -al -- "$OLD_CURRENT/node_modules" "$RELEASE_DIR/node_modules"; then
    dependencies_reused=1
    echo "package-lock.json 未变化，已复用上一可信 release 的生产依赖"
  fi
fi
if [[ "$dependencies_reused" -ne 1 ]]; then
  rm -rf -- "$RELEASE_DIR/node_modules"
  runuser -u ubuntu -- bash -lc "cd '$RELEASE_DIR' && npm ci --omit=dev --no-audit --no-fund"
fi
runuser -u ubuntu -- bash -lc "cd '$RELEASE_DIR' && node --check dist/server/index.mjs && node -e \"require('better-sqlite3')\""

if [[ ! -f "$ENV_FILE" ]]; then
  admin_token="$(openssl rand -hex 32)"
  umask 077
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
DATA_DIR=$DATA_DIR
PUBLIC_BASE_URL=https://news.11451405.xyz
DEFAULT_TZ=Asia/Shanghai
ADMIN_TOKEN=$admin_token
RSSHUB_BASE=https://rsshub.app
FETCH_CONCURRENCY=4
USER_AGENT="NewsRadarBot/1.0 (+https://news.11451405.xyz/about)"
ALLOW_PROXY_FAKE_IP=0
AI_PROVIDER=none
AI_DAILY_BUDGET=200
EOF
  chmod 0600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
fi

install -d -m 0700 "$ROLLBACK_DIR"
backup_path "$NGINX_CONF" nginx-conf
backup_path "$NGINX_SITE" nginx-site
backup_path "$NGINX_ENABLED" nginx-enabled
backup_path "$SERVICE_UNIT" service-unit
backup_path "$SCHEDULER_SERVICE_UNIT" scheduler-service-unit
backup_path "$CERTWATCH_SCRIPT" certwatch-script
backup_path "$CERTWATCH_SERVICE" certwatch-service
backup_path "$CERTWATCH_TIMER" certwatch-timer
SERVICE_WAS_ACTIVE="$(systemctl is-active news-radar.service 2>/dev/null || true)"
SERVICE_WAS_ENABLED="$(systemctl is-enabled news-radar.service 2>/dev/null || true)"
SCHEDULER_SERVICE_WAS_ACTIVE="$(systemctl is-active news-radar-scheduler.service 2>/dev/null || true)"
SCHEDULER_SERVICE_WAS_ENABLED="$(systemctl is-enabled news-radar-scheduler.service 2>/dev/null || true)"
TIMER_WAS_ACTIVE="$(systemctl is-active news-radar-certwatch.timer 2>/dev/null || true)"
TIMER_WAS_ENABLED="$(systemctl is-enabled news-radar-certwatch.timer 2>/dev/null || true)"
ROLLBACK_READY=1

install -m 0644 "$RELEASE_DIR/deploy/news-radar.service" "$SERVICE_UNIT"
install -m 0644 "$RELEASE_DIR/deploy/news-radar-scheduler.service" "$SCHEDULER_SERVICE_UNIT"
install -m 0755 "$RELEASE_DIR/deploy/news-radar-certwatch.sh" "$CERTWATCH_SCRIPT"
install -m 0644 "$RELEASE_DIR/deploy/news-radar-certwatch.service" "$CERTWATCH_SERVICE"
install -m 0644 "$RELEASE_DIR/deploy/news-radar-certwatch.timer" "$CERTWATCH_TIMER"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
systemctl daemon-reload
systemctl enable news-radar.service >/dev/null
systemctl enable news-radar-scheduler.service >/dev/null
systemctl set-property --runtime news-radar-scheduler.service CPUWeight=1000 IOWeight=100
systemctl stop news-radar-scheduler.service >/dev/null 2>&1 || true
systemctl restart news-radar.service

healthy=0
for _ in {1..90}; do
  if curl -fsS --max-time 5 http://127.0.0.1:8787/api/ready >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" -ne 1 ]]; then
  journalctl -u news-radar.service -n 80 --no-pager >&2 || true
  echo "News Radar 健康检查失败" >&2
  exit 1
fi

systemctl restart news-radar-scheduler.service
scheduler_healthy=0
observed_scheduler_instance=""
observed_scheduler_heartbeat=""
for _ in {1..180}; do
  if systemctl is-active --quiet news-radar-scheduler.service; then
    scheduler_runtime="$(sqlite3 "$DATA_DIR/news.db" "
      SELECT json_extract(v, '$.instanceId') || '|' || json_extract(v, '$.heartbeatAt')
      FROM kv_store
      WHERE k = 'scheduler:runtime'
        AND json_extract(v, '$.state.running') = 1
        AND unixepoch(json_extract(v, '$.heartbeatAt')) >= unixepoch('now') - 120
      LIMIT 1;
    " 2>/dev/null || true)"
    scheduler_instance="${scheduler_runtime%%|*}"
    scheduler_heartbeat="${scheduler_runtime#*|}"
    if [[ -n "$scheduler_runtime" && "$scheduler_runtime" == *"|"* ]]; then
      if [[ "$scheduler_instance" == "$observed_scheduler_instance" \
        && -n "$observed_scheduler_heartbeat" \
        && "$scheduler_heartbeat" != "$observed_scheduler_heartbeat" ]]; then
        scheduler_healthy=1
        break
      fi
      observed_scheduler_instance="$scheduler_instance"
      observed_scheduler_heartbeat="$scheduler_heartbeat"
    fi
  fi
  sleep 1
done
if [[ "$scheduler_healthy" -ne 1 ]]; then
  journalctl -u news-radar-scheduler.service -n 80 --no-pager >&2 || true
  echo "News Radar 调度进程未产生连续心跳" >&2
  exit 1
fi

install -m 0644 "$RELEASE_DIR/deploy/nginx-news" "$NGINX_SITE"
ln -sfn "$NGINX_SITE" "$NGINX_ENABLED"
if ! grep -qE '^[[:space:]]*news\.11451405\.xyz[[:space:]]+127\.0\.0\.1:8443;' "$NGINX_CONF"; then
  if ! grep -qE '^[[:space:]]*question\.11451405\.xyz[[:space:]]+127\.0\.0\.1:8443;' "$NGINX_CONF"; then
    echo "无法定位 nginx SNI map 插入点" >&2
    exit 1
  fi
  sed -i '/^[[:space:]]*question\.11451405\.xyz[[:space:]]*127\.0\.0\.1:8443;/a\        news.11451405.xyz              127.0.0.1:8443;' "$NGINX_CONF"
fi
nginx -t
systemctl reload nginx
systemctl enable --now news-radar-certwatch.timer >/dev/null

DEPLOY_COMMITTED=1
echo "News Radar 发布成功：$RELEASE_DIR"
