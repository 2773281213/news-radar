import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "../shared/types";

// TODO: 后端路由落地后，用正式共享契约替换这里的集中声明。
export const API_ROUTES = {
  health: "/api/health",
  stats: "/api/stats",
  events: "/api/events",
  event: (id: string) => `/api/events/${encodeURIComponent(id)}`,
  eventWorkflow: (id: string) => `/api/events/${encodeURIComponent(id)}/workflow`,
  workflow: "/api/workflow",
  ministry: (slug: string) => `/api/ministries/${encodeURIComponent(slug)}`,
  briefings: "/api/briefings",
  briefing: (id: string) => `/api/briefings/${encodeURIComponent(id)}`,
  search: "/api/search",
  watchlists: "/api/watchlists",
  watchlist: (id: string) => `/api/watchlists/${encodeURIComponent(id)}`,
  sources: "/api/sources",
  fetchLogs: "/api/fetch-logs",
  ask: "/api/ask",
  alerts: "/api/alerts",
  alertRead: (id: number) => `/api/alerts/${id}/read`,
} as const;

export class ApiRequestError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.detail = detail;
  }
}

interface ApiRequestInit extends Omit<RequestInit, "body"> {
  json?: unknown;
  adminToken?: string;
  body?: BodyInit | null;
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { json, adminToken, headers: initialHeaders, ...requestInit } = init;
  const headers = new Headers(initialHeaders);
  headers.set("Accept", "application/json");

  if (json !== undefined) headers.set("Content-Type", "application/json");
  if (adminToken) headers.set("X-Admin-Token", adminToken);

  let response: Response;
  try {
    response = await fetch(path, {
      ...requestInit,
      headers,
      body: json === undefined ? requestInit.body : JSON.stringify(json),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiRequestError(
      navigator.onLine ? "无法连接数据服务，请稍后重试。" : "当前处于离线状态，无法读取这项数据。",
      0,
    );
  }

  const payload = await parseResponse(response);
  if (!response.ok) {
    const apiError =
      payload && typeof payload === "object" && "error" in payload
        ? (payload as ApiError)
        : undefined;
    throw new ApiRequestError(
      apiError?.error || `数据服务返回异常（HTTP ${response.status}）。`,
      response.status,
      apiError?.detail,
    );
  }

  return payload as T;
}

export interface ApiState<T> {
  data: T | undefined;
  error: ApiRequestError | null;
  loading: boolean;
  refreshing: boolean;
  reload: () => void;
}

export function useApi<T>(path: string | null, adminToken?: string): ApiState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const previousPath = useRef<string | null>(null);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!path) {
      previousPath.current = null;
      setData(undefined);
      setError(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const controller = new AbortController();
    const isSameResource = previousPath.current === path;
    previousPath.current = path;

    setError(null);
    if (isSameResource && data !== undefined) {
      setRefreshing(true);
    } else {
      setData(undefined);
      setLoading(true);
    }

    void apiRequest<T>(path, { signal: controller.signal, adminToken })
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(
          requestError instanceof ApiRequestError
            ? requestError
            : new ApiRequestError("读取数据时发生未知异常。", 0),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });

    return () => controller.abort();
  }, [adminToken, path, revision]);

  return { data, error, loading, refreshing, reload };
}

export type CollectionEnvelope<T> =
  | T[]
  | { items: T[]; total?: number }
  | { data: T[]; total?: number }
  | { results: T[]; total?: number };

export function unwrapCollection<T>(payload: CollectionEnvelope<T> | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if ("items" in payload && Array.isArray(payload.items)) return payload.items;
  if ("data" in payload && Array.isArray(payload.data)) return payload.data;
  if ("results" in payload && Array.isArray(payload.results)) return payload.results;
  return [];
}

export function unwrapItem<T>(payload: T | { data: T } | undefined): T | undefined {
  if (!payload) return undefined;
  if (typeof payload === "object" && "data" in payload) return payload.data;
  return payload;
}

export function withQuery(path: string, values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
