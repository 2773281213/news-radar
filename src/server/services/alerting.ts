import webpush from "web-push";
import type { AlertDTO, EventDetailDTO, WatchlistDTO } from "../../shared/types";
import type { Config } from "../config";
import type { NotificationStore } from "./notification-store";

/** Alert Agent：站内提醒为基线，Telegram、邮件、Web Push 按配置可插拔 */
export class AlertingService {
  constructor(
    private config: Config,
    private store: NotificationStore
  ) {
    if (config.vapidPublicKey && config.vapidPrivateKey) {
      webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
    }
  }

  async evaluateEvent(event: EventDetailDTO): Promise<AlertDTO[]> {
    const created: AlertDTO[] = [];
    if (event.trackMode === "breaking" || event.importance >= 85) {
      const alert = await this.createAndSend(
        {
          level: "breaking",
          eventId: event.id,
          title: event.title,
          body: event.oneLiner || "该事件进入高优先级跟踪模式。",
          reason: `重要程度 ${event.importance}，跟踪模式 ${event.trackMode}`,
          dedupeKey: `breaking:${event.id}:v${event.version}`,
        },
        ["web", "telegram", "email", "push"]
      );
      if (alert) created.push(alert);
    }

    for (const watch of await this.store.listWatchlists()) {
      if (!watch.enabled || event.importance < watch.minImportance || !matchesWatchlist(watch, event)) continue;
      const alert = await this.createAndSend(
        {
          level: event.trackMode === "breaking" ? "breaking" : "notable",
          eventId: event.id,
          title: `${watch.name}：${event.title}`,
          body: event.oneLiner || "观察列表出现相关事件更新。",
          reason: `命中观察列表「${watch.name}」`,
          dedupeKey: `watch:${watch.id}:${event.id}:v${event.version}`,
        },
        watch.channels
      );
      if (alert) created.push(alert);
    }
    return created;
  }

  async createAndSend(
    input: {
      level: AlertDTO["level"];
      eventId?: string | null;
      claimId?: string | null;
      title: string;
      body: string;
      reason: string;
      dedupeKey?: string | null;
    },
    requestedChannels: string[]
  ): Promise<AlertDTO | null> {
    const alert = await this.store.addAlert(input);
    if (!alert) return null;
    const channels = new Set(requestedChannels);
    channels.add("web"); // 所有提醒都保留站内记录
    const sent = ["web"];
    const url = input.eventId ? `${this.config.publicBaseUrl}/events/${encodeURIComponent(input.eventId)}` : this.config.publicBaseUrl;

    if (channels.has("telegram") && (await this.sendTelegram(alert, url))) sent.push("telegram");
    if (channels.has("email") && (await this.sendEmail(alert, url))) sent.push("email");
    if (channels.has("push") && (await this.sendWebPush(alert, url))) sent.push("push");
    await this.store.setSentChannels(alert.id, sent);
    return alert;
  }

  private async sendTelegram(alert: AlertDTO, url: string): Promise<boolean> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) return false;
    const endpoint = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.telegramChatId,
          text: `${alert.level === "breaking" ? "【突发】" : "【新闻雷达】"}${alert.title}\n\n${alert.body}\n\n${url}`,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      return res.ok;
    } catch (error) {
      console.warn(`[提醒] Telegram 发送失败: ${safeMessage(error)}`);
      return false;
    }
  }

  private async sendEmail(alert: AlertDTO, url: string): Promise<boolean> {
    if (!this.config.resendApiKey || !this.config.alertEmailFrom || !this.config.alertEmailTo) return false;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.resendApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.config.alertEmailFrom,
          to: [this.config.alertEmailTo],
          subject: `${alert.level === "breaking" ? "[突发] " : ""}${alert.title}`,
          text: `${alert.body}\n\n提醒原因：${alert.reason}\n\n查看事件：${url}`,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      return res.ok;
    } catch (error) {
      console.warn(`[提醒] 邮件发送失败: ${safeMessage(error)}`);
      return false;
    }
  }

  private async sendWebPush(alert: AlertDTO, url: string): Promise<boolean> {
    if (!this.config.vapidPublicKey || !this.config.vapidPrivateKey) return false;
    const subs = await this.store.pushSubscriptions();
    if (subs.length === 0) return false;
    let delivered = false;
    const payload = JSON.stringify({ title: alert.title, body: alert.body, url });
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: alert.level === "breaking" ? 3600 : 21_600 }
        );
        delivered = true;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await this.store.removePushEndpoint(sub.endpoint);
        else console.warn(`[提醒] Web Push 发送失败: ${safeMessage(error)}`);
      }
    }
    return delivered;
  }
}

function matchesWatchlist(watch: WatchlistDTO, event: EventDetailDTO): boolean {
  const haystack = [
    event.title,
    event.oneLiner || "",
    event.summary?.oneLiner || "",
    event.topics.join(" "),
    event.countries.join(" "),
    ...event.claims.slice(0, 30).map((claim) => claim.text),
  ]
    .join("\n")
    .toLocaleLowerCase();
  const terms = [...watch.keywords, ...watch.entities].map((term) => term.toLocaleLowerCase().trim()).filter(Boolean);
  return terms.length > 0 && terms.some((term) => haystack.includes(term));
}

function safeMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/bot\d+:[a-z0-9_-]+/gi, "bot[REDACTED]")
    .replace(/sk-[a-z0-9_-]+/gi, "sk-[REDACTED]")
    .slice(0, 500);
}
