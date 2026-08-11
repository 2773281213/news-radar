import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemeChoice = "auto" | "light" | "dark";
export type DensityChoice = "comfortable" | "compact";
export type MotionChoice = "auto" | "reduce";

interface PreferencesValue {
  theme: ThemeChoice;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: ThemeChoice) => void;
  density: DensityChoice;
  setDensity: (density: DensityChoice) => void;
  motion: MotionChoice;
  setMotion: (motion: MotionChoice) => void;
  timeZone: string;
  setTimeZone: (timeZone: string) => boolean;
  adminToken: string;
  setAdminToken: (token: string) => void;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readTimeZone(): string {
  try {
    const stored = window.localStorage.getItem("nr-time-zone");
    if (stored && isValidTimeZone(stored)) return stored;
  } catch {
    // 本地存储不可用时回退到浏览器时区。
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 偏好持久化失败不应阻断页面使用。
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(() =>
    readChoice("nr-theme", ["auto", "light", "dark"] as const, "auto"),
  );
  const [density, setDensityState] = useState<DensityChoice>(() =>
    readChoice("nr-density", ["comfortable", "compact"] as const, "comfortable"),
  );
  const [motion, setMotionState] = useState<MotionChoice>(() =>
    readChoice("nr-motion", ["auto", "reduce"] as const, "auto"),
  );
  const [timeZone, setTimeZoneState] = useState(readTimeZone);
  const [adminToken, setAdminToken] = useState("");
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

  const resolvedTheme = theme === "auto" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.density = density;
    root.dataset.motion = motion;
    root.style.colorScheme = resolvedTheme;

    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    themeMeta?.setAttribute("content", resolvedTheme === "dark" ? "#15181d" : "#f4efe4");
  }, [density, motion, resolvedTheme]);

  const setTheme = (next: ThemeChoice) => {
    setThemeState(next);
    persist("nr-theme", next);
  };

  const setDensity = (next: DensityChoice) => {
    setDensityState(next);
    persist("nr-density", next);
  };

  const setMotion = (next: MotionChoice) => {
    setMotionState(next);
    persist("nr-motion", next);
  };

  const setTimeZone = (next: string): boolean => {
    const value = next.trim();
    if (!isValidTimeZone(value)) return false;
    setTimeZoneState(value);
    persist("nr-time-zone", value);
    return true;
  };

  const value = useMemo<PreferencesValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
      density,
      setDensity,
      motion,
      setMotion,
      timeZone,
      setTimeZone,
      adminToken,
      setAdminToken,
    }),
    [adminToken, density, motion, resolvedTheme, theme, timeZone],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences 必须在 PreferencesProvider 内使用。");
  return value;
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return online;
}
