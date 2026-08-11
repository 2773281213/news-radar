// 新闻雷达 Service Worker：导航始终网络优先，避免旧 HTML 引用已删除的哈希资源。
const SHELL_CACHE = "nr-shell-v4";
const DATA_CACHE = "nr-data-v3";
const NAVIGATION_FALLBACK = "/__news-radar-offline-shell__";
const SHELL_URLS = ["/manifest.webmanifest", "/favicon.svg", "/icons/radar.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_URLS);
    try {
      const shell = await fetch("/", { cache: "reload" });
      if (shell.ok) await cache.put(NAVIGATION_FALLBACK, shell);
    } catch {
      // 首次安装时网络异常不应让整个 Service Worker 安装失败。
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // 页面导航：先取当前 release 的 index.html，离线时才回退上次成功外壳。
  if (e.request.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const response = await fetch(e.request, { cache: "no-store" });
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put(NAVIGATION_FALLBACK, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(NAVIGATION_FALLBACK)) || Response.error();
      }
    })());
    return;
  }

  // 简报接口：网络优先，失败回退缓存（离线阅读最近简报）
  if (url.pathname.startsWith("/api/briefings")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            e.waitUntil(caches.open(DATA_CACHE).then((c) => c.put(e.request, copy)));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((m) => m || Response.error()))
    );
    return;
  }
  // 其余 API 不缓存
  if (url.pathname.startsWith("/api/")) return;

  // 内容哈希静态资源可安全缓存优先；导航 HTML 已在上方单独处理。
  e.respondWith(
    caches.match(e.request).then(
      (m) =>
        m ||
        fetch(e.request).then((res) => {
          if (res.ok && (url.pathname.startsWith("/assets/") || SHELL_URLS.includes(url.pathname))) {
            const copy = res.clone();
            e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy)));
          }
          return res;
        })
    )
  );
});

// Web Push 展示
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: "新闻雷达", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(data.title || "新闻雷达提醒", {
      body: data.body || "",
      icon: "/icons/radar.svg",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url || "/"));
});
