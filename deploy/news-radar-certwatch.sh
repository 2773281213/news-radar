#!/usr/bin/env bash
# Wait for public routing, issue the dedicated HTTP-01 certificate, then switch atomically.
set -Eeuo pipefail
DOMAIN=news.11451405.xyz
LIVE=/etc/letsencrypt/live/$DOMAIN
VHOST=/etc/nginx/sites-available/news
LOG=/var/log/news-radar-certwatch.log
ORIGIN_CERT=/etc/nginx/ssl/news-radar-origin.crt
ORIGIN_KEY=/etc/nginx/ssl/news-radar-origin.key

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

finish() {
    [ -f "$LIVE/fullchain.pem" ] || return 1
    local backup
    backup="$(mktemp)"
    cp -- "$VHOST" "$backup"
    sed -i \
        -e "s#$ORIGIN_CERT#$LIVE/fullchain.pem#g" \
        -e "s#$ORIGIN_KEY#$LIVE/privkey.pem#g" \
        "$VHOST"
    if nginx -t >> "$LOG" 2>&1; then
        systemctl reload nginx
        rm -f -- "$backup"
        log "vhost 已切换到专属证书"
    else
        cp -- "$backup" "$VHOST"
        rm -f -- "$backup"
        log "nginx 校验失败，已回滚证书路径"
        exit 1
    fi
    systemctl disable --now news-radar-certwatch.timer >> "$LOG" 2>&1 || true
    log "证书任务完成，定时器已禁用"
}

[ -f "$LIVE/fullchain.pem" ] && { finish; exit 0; }

# 同时要求公网 DNS 存在且 HTTP 请求确实到达本机，避免为错误解析反复申请。
if ! command -v dig >/dev/null 2>&1 || ! dig +short "$DOMAIN" @1.1.1.1 | grep -q .; then
    exit 0
fi

TOKEN="news-radar-$(date +%s)-$$"
mkdir -p /var/www/certbot/.well-known/acme-challenge
printf '%s' "$TOKEN" > "/var/www/certbot/.well-known/acme-challenge/news-radar-probe"
if ! curl -kfsSL --max-time 20 "http://$DOMAIN/.well-known/acme-challenge/news-radar-probe" | grep -q "$TOKEN"; then
    log "DNS 已存在，但 ACME HTTP 探针尚未到达本机"
    exit 0
fi
rm -f "/var/www/certbot/.well-known/acme-challenge/news-radar-probe"

log "DNS 与 HTTP 探针就绪，尝试签发证书"
certbot certonly --webroot -w /var/www/certbot -n --agree-tos \
    --register-unsafely-without-email \
    --cert-name "$DOMAIN" -d "$DOMAIN" \
    --deploy-hook "systemctl reload nginx" >> "$LOG" 2>&1

if [ -f "$LIVE/fullchain.pem" ]; then
    log "证书签发成功"
    finish
else
    log "签发失败，等待下一轮重试"
fi
