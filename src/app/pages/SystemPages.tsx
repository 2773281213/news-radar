import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "wouter";
import type { AlertDTO, HealthDTO } from "../../shared/types";
import { CATEGORY_LABELS, CLAIM_STATUS_LABELS } from "../../shared/constants";
import {
  API_ROUTES,
  ApiRequestError,
  apiRequest,
  type CollectionEnvelope,
  unwrapCollection,
  unwrapItem,
  useApi,
} from "../api";
import {
  type DensityChoice,
  type MotionChoice,
  type ThemeChoice,
  usePreferences,
} from "../preferences";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  FormField,
  LoadingState,
  Notice,
  PageHeader,
  Panel,
  RefreshButton,
  SectionHeader,
  StatTile,
  SubtleSpinner,
  TableFrame,
  VisualRefreshFrame,
} from "../components/ui";
import {
  ALERT_LEVEL_LABELS,
  formatDateTime,
  formatRelativeTime,
} from "../utils";

export function AlertsPage() {
  const { timeZone, adminToken } = usePreferences();
  const [filter, setFilter] = useState<"all" | "unread" | AlertDTO["level"]>("all");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const state = useApi<CollectionEnvelope<AlertDTO>>(API_ROUTES.alerts, adminToken);
  const alerts = unwrapCollection(state.data);

  useEffect(() => {
    document.title = "提醒 · 新闻雷达";
  }, []);

  const visible = useMemo(
    () =>
      alerts.filter((alert) => {
        if (filter === "unread") return !alert.readAt;
        if (filter === "all") return true;
        return alert.level === filter;
      }),
    [alerts, filter],
  );

  const markRead = async (alert: AlertDTO) => {
    if (alert.readAt) return;
    setBusyId(alert.id);
    setActionError(null);
    try {
      await apiRequest(API_ROUTES.alertRead(alert.id), {
        method: "POST",
        adminToken,
      });
      state.reload();
    } catch (error) {
      setActionError(error instanceof ApiRequestError ? error.message : "无法标记提醒。 ");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page page-alerts">
      <PageHeader
        eyebrow="提醒 / ALERT DESK"
        title="只让真正发生变化的事件打断你"
        description="提醒必须说明触发原因，并保留回到事件证据页的路径。"
        actions={<RefreshButton refreshing={state.refreshing} onClick={state.reload} />}
      />

      <section className="alert-summary" aria-label="提醒统计">
        <StatTile label="全部提醒" value={alerts.length} />
        <StatTile label="未读" value={alerts.filter((alert) => !alert.readAt).length} tone="accent" />
        <StatTile label="突发" value={alerts.filter((alert) => alert.level === "breaking").length} tone="evidence" />
      </section>

      <div className="filter-strip" role="group" aria-label="提醒筛选">
        {(["all", "unread", "breaking", "notable", "info"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={filter === value ? "is-active" : undefined}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === "all" ? "全部" : value === "unread" ? "未读" : ALERT_LEVEL_LABELS[value]}
          </button>
        ))}
      </div>

      {actionError ? <Notice tone="danger" title="操作失败"><p>{actionError}</p></Notice> : null}
      {state.loading && !alerts.length ? <LoadingState label="正在读取提醒" /> : null}
      {state.error && !alerts.length ? <ErrorState error={state.error} onRetry={state.reload} title="无法读取提醒" /> : null}

      {alerts.length ? (
        <VisualRefreshFrame refreshing={state.refreshing}>
          {visible.length ? (
            <div className="alert-list">
              {visible.map((alert) => (
                <article className={alert.readAt ? "alert-card is-read" : "alert-card"} key={alert.id}>
                  <div className="alert-rail" aria-hidden="true" />
                  <div className="alert-card-body">
                    <div className="alert-card-topline">
                      <Badge tone={alert.level === "breaking" ? "danger" : alert.level === "notable" ? "evidence" : "info"}>
                        {ALERT_LEVEL_LABELS[alert.level]}
                      </Badge>
                      {!alert.readAt ? <Badge tone="accent">未读</Badge> : null}
                      <time dateTime={alert.createdAt} title={formatDateTime(alert.createdAt, timeZone)}>
                        {formatRelativeTime(alert.createdAt)}
                      </time>
                    </div>
                    <h2>{alert.title}</h2>
                    <p>{alert.body}</p>
                    <aside className="alert-reason"><strong>触发原因</strong><span>{alert.reason}</span></aside>
                    <div className="card-actions">
                      {alert.eventId ? (
                        <Link className="button button-secondary" href={`/events/${encodeURIComponent(alert.eventId)}`}>
                          查看事件证据
                        </Link>
                      ) : null}
                      {!alert.readAt ? (
                        <Button variant="ghost" disabled={busyId === alert.id} onClick={() => void markRead(alert)}>
                          {busyId === alert.id ? <><SubtleSpinner /> 处理中</> : "标记已读"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="当前筛选下没有提醒" description="切换筛选条件查看其他级别或已读提醒。" />
          )}
        </VisualRefreshFrame>
      ) : !state.loading && !state.error ? (
        <EmptyState title="提醒箱为空" description="后端产生真实事件变化提醒后，这里会说明级别与触发原因。" />
      ) : null}
    </div>
  );
}

const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string; description: string }> = [
  { value: "auto", label: "跟随设备", description: "随操作系统在纸张与墨色主题间切换" },
  { value: "light", label: "暖纸", description: "低眩光纸张底色与深墨文字" },
  { value: "dark", label: "炭黑", description: "深色编辑台与高对比证据标记" },
];

const DENSITY_OPTIONS: Array<{ value: DensityChoice; label: string }> = [
  { value: "comfortable", label: "舒展" },
  { value: "compact", label: "紧凑" },
];

const MOTION_OPTIONS: Array<{ value: MotionChoice; label: string }> = [
  { value: "auto", label: "跟随设备" },
  { value: "reduce", label: "减少动态" },
];

export function SettingsPage() {
  const preferences = usePreferences();
  const [timeZoneDraft, setTimeZoneDraft] = useState(preferences.timeZone);
  const [timeZoneMessage, setTimeZoneMessage] = useState<string | null>(null);
  const [serviceWorkerReady, setServiceWorkerReady] = useState<boolean | null>(null);
  const healthState = useApi<HealthDTO | { data: HealthDTO }>(API_ROUTES.health);
  const health = unwrapItem(healthState.data);

  useEffect(() => {
    document.title = "设置 · 新闻雷达";
    if (!("serviceWorker" in navigator)) {
      setServiceWorkerReady(false);
      return;
    }
    void navigator.serviceWorker.getRegistration().then((registration) => setServiceWorkerReady(Boolean(registration)));
  }, []);

  const saveTimeZone = (event: FormEvent) => {
    event.preventDefault();
    const success = preferences.setTimeZone(timeZoneDraft);
    setTimeZoneMessage(success ? "时区已更新。" : "无法识别该 IANA 时区，请检查拼写。 ");
  };

  return (
    <div className="page page-settings">
      <PageHeader
        eyebrow="设置 / READING ROOM"
        title="让界面适应阅读，而不是让阅读迁就界面"
        description="外观、密度、时区和动态效果保存在当前浏览器；管理员令牌只保留在本次内存会话。"
      />

      <div className="settings-layout">
        <section className="settings-main">
          <Panel className="settings-panel">
            <SectionHeader eyebrow="APPEARANCE" title="主题" />
            <div className="theme-options">
              {THEME_OPTIONS.map((option) => (
                <label key={option.value} className={preferences.theme === option.value ? "is-selected" : undefined}>
                  <input
                    type="radio"
                    name="theme"
                    value={option.value}
                    checked={preferences.theme === option.value}
                    onChange={() => preferences.setTheme(option.value)}
                  />
                  <span className={`theme-swatch theme-swatch-${option.value}`} aria-hidden="true" />
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </label>
              ))}
            </div>
          </Panel>

          <Panel className="settings-panel">
            <SectionHeader eyebrow="READABILITY" title="阅读密度与动态" />
            <fieldset className="choice-row">
              <legend>信息密度</legend>
              {DENSITY_OPTIONS.map((option) => (
                <label key={option.value}>
                  <input
                    type="radio"
                    name="density"
                    checked={preferences.density === option.value}
                    onChange={() => preferences.setDensity(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <fieldset className="choice-row">
              <legend>动态效果</legend>
              {MOTION_OPTIONS.map((option) => (
                <label key={option.value}>
                  <input
                    type="radio"
                    name="motion"
                    checked={preferences.motion === option.value}
                    onChange={() => preferences.setMotion(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          </Panel>

          <Panel className="settings-panel">
            <SectionHeader eyebrow="TIME" title="显示时区" />
            <form className="settings-form" onSubmit={saveTimeZone}>
              <FormField label="IANA 时区" hint="例如 Asia/Shanghai、Europe/London、America/New_York">
                <input value={timeZoneDraft} onChange={(event) => setTimeZoneDraft(event.target.value)} list="time-zone-options" />
              </FormField>
              <datalist id="time-zone-options">
                <option value="Asia/Shanghai" />
                <option value="Asia/Tokyo" />
                <option value="Europe/London" />
                <option value="Europe/Paris" />
                <option value="America/New_York" />
                <option value="America/Los_Angeles" />
                <option value="UTC" />
              </datalist>
              <Button type="submit">保存时区</Button>
              {timeZoneMessage ? <p className="form-status" role="status">{timeZoneMessage}</p> : null}
            </form>
          </Panel>

          <Panel className="settings-panel">
            <SectionHeader eyebrow="ADMIN" title="管理接口令牌" description="仅用于后端明确要求认证的操作。" />
            <FormField label="当前会话令牌" hint="不写入 localStorage，不会被提交到代码仓库。">
              <input
                type="password"
                value={preferences.adminToken}
                onChange={(event) => preferences.setAdminToken(event.target.value)}
                autoComplete="off"
                placeholder="后端实现认证后再填写"
              />
            </FormField>
          </Panel>
        </section>

        <aside className="settings-aside">
          <Panel className="runtime-panel">
            <SectionHeader eyebrow="RUNTIME" title="运行状态" />
            <dl>
              <div><dt>当前主题</dt><dd>{preferences.resolvedTheme === "dark" ? "炭黑" : "暖纸"}</dd></div>
              <div><dt>显示时区</dt><dd>{preferences.timeZone}</dd></div>
              <div><dt>Service Worker</dt><dd>{serviceWorkerReady === null ? "检查中" : serviceWorkerReady ? "已注册" : "未注册"}</dd></div>
              <div><dt>通知权限</dt><dd>{"Notification" in window ? Notification.permission : "浏览器不支持"}</dd></div>
            </dl>
          </Panel>

          {health ? (
            <Panel className="runtime-panel">
              <SectionHeader eyebrow={`VERSION ${health.version}`} title="数据服务" />
              <dl>
                <div><dt>服务</dt><dd>{health.ok ? "可用" : "异常"}</dd></div>
                <div><dt>数据库</dt><dd>{health.db ? "可用" : "异常"}</dd></div>
                <div><dt>调度器</dt><dd>{health.scheduler.running ? "运行中" : "未运行"}</dd></div>
                <div><dt>服务时间</dt><dd>{formatDateTime(health.now, preferences.timeZone)}</dd></div>
              </dl>
            </Panel>
          ) : healthState.error ? (
            <Notice tone="warning" title="健康接口尚未接通"><p>{healthState.error.message}</p></Notice>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

export function AboutPage() {
  const { timeZone } = usePreferences();
  const state = useApi<HealthDTO | { data: HealthDTO }>(API_ROUTES.health);
  const health = unwrapItem(state.data);

  useEffect(() => {
    document.title = "关于 · 新闻雷达";
  }, []);

  return (
    <div className="page page-about">
      <PageHeader
        eyebrow="关于 / METHOD"
        title="新闻雷达不是“真相按钮”，而是一套可检查的编辑流程"
        description="系统把文章聚合为事件，把说法拆成主张，再记录支持、报道、质疑与反驳它们的证据。"
        actions={<RefreshButton refreshing={state.refreshing} onClick={state.reload} />}
      />

      <section className="method-grid">
        <article>
          <span>01</span>
          <h2>采集不等于采信</h2>
          <p>来源进入系统只代表可被检索。身份核验、所有权、当事方属性与采集健康度分别记录。</p>
        </article>
        <article>
          <span>02</span>
          <h2>主张不等于事实</h2>
          <p>每条说法拥有独立状态；“有来源报道”不会自动升级为“已交叉确认”。</p>
        </article>
        <article>
          <span>03</span>
          <h2>引用必须可回溯</h2>
          <p>事件摘要、简报与自然语言回答只展示接口返回的真实引用，不使用占位新闻或虚构脚注。</p>
        </article>
        <article>
          <span>04</span>
          <h2>时间边界必须明确</h2>
          <p>简报与问答均显示材料截点；新版本通过增量说明变化，避免把后见之明写回旧结论。</p>
        </article>
        <article>
          <span>05</span>
          <h2>封驳不等于判假</h2>
          <p>门下省只检查当前证据是否达到发布门槛；证据不足会退回补查，但原始材料仍然保留并可阅读。</p>
        </article>
      </section>

      <div className="about-layout">
        <Panel className="method-panel">
          <SectionHeader eyebrow="CLAIM STATES" title="主张状态词典" />
          <TableFrame label="主张状态词典">
            <table>
              <caption>共享类型中定义的主张状态</caption>
              <thead><tr><th scope="col">状态键</th><th scope="col">界面标签</th></tr></thead>
              <tbody>
                {Object.entries(CLAIM_STATUS_LABELS).map(([key, label]) => (
                  <tr key={key}><th scope="row"><code>{key}</code></th><td>{label}</td></tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        </Panel>

        <Panel className="method-panel">
          <SectionHeader eyebrow="SOURCE MAP" title="来源类别" />
          <div className="category-definition-grid">
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
              <div key={key}><code>{key}</code><span>{label}</span></div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel className="system-health-panel">
        <SectionHeader eyebrow="LIVE SYSTEM" title="当前系统状态" />
        {state.loading && !health ? <LoadingState label="正在读取系统状态" /> : null}
        {state.error && !health ? <ErrorState error={state.error} onRetry={state.reload} title="健康接口不可用" /> : null}
        {health ? (
          <VisualRefreshFrame refreshing={state.refreshing}>
            <div className="stat-grid">
              <StatTile label="来源" value={health.counts.sources} />
              <StatTile label="文章" value={health.counts.articles} />
              <StatTile label="事件" value={health.counts.events} tone="accent" />
              <StatTile label="主张" value={health.counts.claims} tone="evidence" />
            </div>
            <dl className="health-facts">
              <div><dt>服务版本</dt><dd>{health.version}</dd></div>
              <div><dt>数据库</dt><dd>{health.db ? "可用" : "异常"}</dd></div>
              <div><dt>调度器</dt><dd>{health.scheduler.running ? "运行中" : "未运行"}</dd></div>
              <div><dt>工作流积压</dt><dd>{health.workflow.backlog}</dd></div>
              <div><dt>门下封驳</dt><dd>{health.workflow.remanded}</dd></div>
              <div><dt>已成报</dt><dd>{health.workflow.completed}</dd></div>
              <div><dt>检查时间</dt><dd>{formatDateTime(health.now, timeZone)}</dd></div>
            </dl>
          </VisualRefreshFrame>
        ) : null}
      </Panel>

      <div className="about-links">
        <Link className="button button-secondary" href="/sources">检查来源健康</Link>
        <Link className="button button-secondary" href="/assistant">向材料提问</Link>
      </div>
    </div>
  );
}
