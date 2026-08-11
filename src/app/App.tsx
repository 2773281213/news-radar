import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import { PreferencesProvider } from "./preferences";
import { AppShell } from "./components/AppShell";
import { EmptyState, Button } from "./components/ui";
import { HomePage } from "./pages/HomePage";
import { OverviewPage } from "./pages/OverviewPage";
import { WorkflowPage } from "./pages/WorkflowPage";
import { MinistryPage } from "./pages/MinistryPage";
import { EventDetailPage } from "./pages/EventDetailPage";
import { BriefingsPage } from "./pages/BriefingsPage";
import { SearchPage } from "./pages/SearchPage";
import { SourcesPage } from "./pages/SourcesPage";
import { AssistantPage } from "./pages/AssistantPage";
import { AboutPage, AlertsPage, SettingsPage } from "./pages/SystemPages";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function RouteEffects() {
  const [location] = useLocation();

  useEffect(() => {
    if (window.location.hash) {
      const id = window.location.hash.slice(1);
      window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
      return;
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [location]);

  return null;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("前端渲染异常", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fatal-error" role="alert">
        <p className="eyebrow">RENDER ERROR</p>
        <h1>页面没有完成渲染</h1>
        <p>界面遇到未处理异常。刷新页面不会改动任何新闻数据。</p>
        <Button onClick={() => window.location.reload()}>重新加载应用</Button>
      </div>
    );
  }
}

function NotFoundPage() {
  useEffect(() => {
    document.title = "页面不存在 · 新闻雷达";
  }, []);

  return (
    <div className="page not-found-page">
      <EmptyState
        title="这条路径不在雷达范围内"
        description="地址可能已变化，或对应页面尚未建立。"
        action={<Link className="button button-primary" href="/">返回总览</Link>}
      />
    </div>
  );
}

function Routes() {
  return (
    <Switch>
      <Route path="/" component={OverviewPage} />
      <Route path="/workflow" component={WorkflowPage} />
      <Route path="/live" component={HomePage} />
      <Route path="/ministries/:slug">
        {(params) => <MinistryPage slug={safeDecode(params.slug)} />}
      </Route>
      <Route path="/events/:id">
        {(params) => <EventDetailPage eventId={safeDecode(params.id)} />}
      </Route>
      <Route path="/briefings" component={BriefingsPage} />
      <Route path="/search" component={SearchPage} />
      <Route path="/sources" component={SourcesPage} />
      <Route path="/assistant" component={AssistantPage} />
      <Route path="/alerts" component={AlertsPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/about" component={AboutPage} />
      <Route component={NotFoundPage} />
    </Switch>
  );
}

export function App() {
  return (
    <AppErrorBoundary>
      <PreferencesProvider>
        <RouteEffects />
        <AppShell>
          <Routes />
        </AppShell>
      </PreferencesProvider>
    </AppErrorBoundary>
  );
}
