import { useEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import type { HealthDTO } from "../../shared/types";
import { API_ROUTES, unwrapItem, useApi } from "../api";
import { useOnlineStatus, usePreferences } from "../preferences";
import { cx, formatDateTime, formatRelativeTime } from "../utils";

const PRIMARY_NAV = [
  { href: "/", label: "中枢总览", index: "01" },
  { href: "/live", label: "实时事件", index: "02" },
  { href: "/briefings", label: "每日简报", index: "03" },
  { href: "/workflow", label: "三省六部", index: "04" },
  { href: "/search", label: "搜索与追踪", index: "05" },
  { href: "/sources", label: "来源中心", index: "06" },
  { href: "/assistant", label: "自然语言助手", index: "07" },
] as const;

const MOBILE_NAV = [
  { href: "/", label: "中枢", index: "01" },
  { href: "/live", label: "实时", index: "02" },
  { href: "/briefings", label: "简报", index: "03" },
  { href: "/workflow", label: "三省六部", index: "04" },
  { href: "/search", label: "搜索", index: "05" },
] as const;

const UTILITY_NAV = [
  { href: "/alerts", label: "提醒" },
  { href: "/settings", label: "设置" },
  { href: "/about", label: "关于" },
] as const;

function isActive(location: string, href: string): boolean {
  if (href === "/") return location === "/";
  return location === href || location.startsWith(`${href}/`);
}

function NavLink({ href, label, index }: { href: string; label: string; index?: string }) {
  const [location] = useLocation();
  const active = isActive(location, href);
  return (
    <Link className={cx("nav-link", active && "is-active")} href={href} aria-current={active ? "page" : undefined}>
      {index ? <span className="nav-index">{index}</span> : null}
      <span>{label}</span>
    </Link>
  );
}

function RuntimeStatus() {
  const { timeZone } = usePreferences();
  const online = useOnlineStatus();
  const healthState = useApi<HealthDTO | { data: HealthDTO }>(API_ROUTES.health);
  const health = unwrapItem(healthState.data);
  const ready = online && Boolean(health?.ok);

  return (
    <div className="runtime-status" aria-live="polite">
      <div className="runtime-status-line">
        <span className={cx("live-dot", ready ? "is-live" : "is-muted")} aria-hidden="true" />
        <strong>{!online ? "离线" : healthState.error ? "接口待连接" : ready ? "雷达在线" : "正在校验"}</strong>
      </div>
      {health ? (
        <p title={formatDateTime(health.now, timeZone)}>
          {health.scheduler.running ? "调度器运行中" : "调度器未运行"}
          {health.scheduler.lastTickAt ? ` · ${formatRelativeTime(health.scheduler.lastTickAt)}巡检` : ""}
        </p>
      ) : (
        <p>同源 /api 数据通道</p>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const online = useOnlineStatus();
  const workspaceRoute = location === "/workflow" || location.startsWith("/ministries/");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [location]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      <header className="app-header">
        <div className="app-header-inner">
          <Link className="brand" href="/" aria-label="新闻雷达首页">
            <span className="brand-seal" aria-hidden="true">闻</span>
            <span className="brand-copy">
              <strong>新闻雷达</strong>
              <small>三省六部 · NEWS RADAR</small>
            </span>
          </Link>

          <nav className="primary-nav" aria-label="主导航">
            {PRIMARY_NAV.map((item) => <NavLink key={item.href} {...item} />)}
          </nav>

          <div className="header-utilities">
            <nav className="utility-nav" aria-label="工具导航">
              {UTILITY_NAV.slice(0, 2).map((item) => <NavLink key={item.href} {...item} />)}
            </nav>
            <RuntimeStatus />
          </div>
        </div>
      </header>

      <div className={cx("shell-body", workspaceRoute && "is-workspace-route")}>

        {!online ? (
          <div className="offline-banner" role="status">
            当前离线。最近读取过的简报可能仍可访问，其他实时数据将在联网后恢复。
          </div>
        ) : null}

        <main
          id="main-content"
          className={cx("main-content", workspaceRoute && "main-content-workspace")}
          ref={mainRef}
          tabIndex={-1}
        >
          {children}
        </main>

        <footer className={cx("site-footer", workspaceRoute && "workspace-footer")}>
          <p>以来源、时间与证据链组织信息；不把单一报道包装成确定事实。</p>
          <Link href="/about">查看方法与边界</Link>
        </footer>
      </div>

      <nav className="mobile-bottom-nav" aria-label="移动端主导航">
        {MOBILE_NAV.map((item) => {
          const active = isActive(location, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cx(active && "is-active")}
              aria-current={active ? "page" : undefined}
            >
              <span>{item.index}</span>
              <strong>{item.label.replace("自然语言", "")}</strong>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
