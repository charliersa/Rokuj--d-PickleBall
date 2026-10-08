/* 六甲頂匹克球 PWA service worker
   - 網頁本身（index.html）走「網路優先」：有網路就拿最新版，沒網路才用快取，改版不用叫大家清快取
   - support.js、圖示：先給快取、背景再更新
   - unpkg 的 React/Babel 與 Google 字型網址都有版本號，內容不會變，快取優先
   - Apps Script 後台（script.google.com）完全不碰，資料一律直接連線 */
const CACHE = 'ljd-pickle-v3';
const SHELL = [
  './',
  './index.html',
  './support.js',
  './manifest.webmanifest?v=3',
  './icons/icon-192-v2.png',
  './icons/icon-512-v2.png',
  './icons/maskable-192-v2.png',
  './icons/maskable-512-v2.png',
  './icons/favicon-32-v2.png',
  './icons/apple-touch-icon-v2.png'
];
const CDN = [
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 繞過瀏覽器的 HTTP 快取，改版後裝新的 service worker 時才不會又存到舊檔
    await cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    // CDN 抓不到不要讓安裝失敗，第一次正常開頁面時也會補進快取
    await Promise.all(CDN.map(url =>
      fetch(url, { mode: 'cors' }).then(res => res.ok && cache.put(url, res)).catch(() => {})
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const cacheable = res => res && (res.ok || res.type === 'opaque');

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req, { ignoreSearch: true })) ||
           (await cache.match('./index.html')) || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const update = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || update;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
      event.respondWith(networkFirst(req));
    } else {
      event.respondWith(staleWhileRevalidate(req));
    }
    return;
  }
  if (url.hostname === 'unpkg.com' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req));
  }
  // 其他網域（含 Apps Script 後台）交給瀏覽器直接連線
});
