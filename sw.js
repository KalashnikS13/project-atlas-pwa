/**
 * Service Worker for Project Atlas PWA (v6)
 * - Cache namespaces: `atlas-static-v6`, `atlas-api-v6`, `atlas-meta-v1`
 * - Controlled updates via `SKIP_WAITING` + UpdateToast UI
 * - Pre-cached App Shell, Network-First SPA navigation & Drive reads, SWR assets
 * - Bypass for OAuth/Firebase Auth endpoints and non-GET mutations
 * - Chromium Background Sync (`sync-offline-mutations`)
 * - Web Periodic Background Sync (`atlas-business-day-audit`) backed by `AtlasOfflineDB` (Dexie v4)
 * - Push Notification & notification click focus handling
 */

const STATIC_CACHE_NAME = 'atlas-static-v8';
const API_CACHE_NAME = 'atlas-api-v6';
const META_CACHE_NAME = 'atlas-meta-v1';

const ATLAS_IDB_NAME = 'AtlasOfflineDB';
const ATLAS_IDB_SCHEMA_VERSION = 4; // Dexie v4 stores native IDB version = 40

const SW_CONFIG_REQUEST = '/__atlas_sw_config__';
const SW_AUDIT_STATE_REQUEST = '/__atlas_periodic_audit__';

const resolveScopedUrl = (relativePath) => new URL(relativePath, self.registration.scope).href;

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json?v=2',
  './logo.jpg',
  './logo.svg',
  './icon.svg?v=2',
  './apple-touch-icon.png?v=2',
  './pwa-192x192.png?v=2',
  './pwa-512x512.png?v=2'
];

const MAX_API_ENTRIES = 50;
const MAX_STATIC_ENTRIES = 80;
const MAX_OPAQUE_ENTRIES = 15;

const AUTH_BYPASS_HOSTS = [
  'accounts.google.com',
  'apis.google.com',
  'oauth2.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com'
];

const EMPTY_ROLLOVER_SUMMARY = Object.freeze({
  activeCount: 0,
  missedYesterdayCount: 0,
  pendingTodayCount: 0
});

// ----------------------------------------------------------------------------
// 1. Lifecycle Management (Controlled Updates)
// ----------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS.map(resolveScopedUrl)))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter(
              (name) =>
                name !== STATIC_CACHE_NAME &&
                name !== API_CACHE_NAME &&
                name !== META_CACHE_NAME
            )
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') return;

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (event.data.type === 'ATLAS_SYNC_CONFIG') {
    const dayOffset = Number(event.data.dayOffset);
    const networkTimeOffset = Number(event.data.networkTimeOffset);
    event.waitUntil(
      persistSwConfig({
        dayOffset: Number.isFinite(dayOffset) ? dayOffset : 4,
        networkTimeOffset: Number.isFinite(networkTimeOffset) ? networkTimeOffset : 0,
        updatedAt: new Date().toISOString()
      })
    );
    return;
  }

  if (event.data.type === 'RUN_PERIODIC_BUSINESS_DAY_AUDIT') {
    event.waitUntil(runPeriodicBusinessDayAudit());
  }
});

// ----------------------------------------------------------------------------
// 2. Meta Storage, Time Calibration & AtlasOfflineDB Rollover Inspection
// ----------------------------------------------------------------------------

async function persistSwConfig(config) {
  try {
    const cache = await caches.open(META_CACHE_NAME);
    await cache.put(
      SW_CONFIG_REQUEST,
      new Response(JSON.stringify(config), {
        headers: { 'Content-Type': 'application/json' }
      })
    );
  } catch (err) {
    console.warn('[SW v6] Failed to persist runtime config:', err);
  }
}

async function readSwConfig() {
  try {
    const cache = await caches.open(META_CACHE_NAME);
    const res = await cache.match(SW_CONFIG_REQUEST);
    if (!res) {
      return { dayOffset: 4, networkTimeOffset: 0 };
    }
    const parsed = await res.json();
    return {
      dayOffset: Number.isFinite(Number(parsed.dayOffset)) ? Number(parsed.dayOffset) : 4,
      networkTimeOffset: Number.isFinite(Number(parsed.networkTimeOffset))
        ? Number(parsed.networkTimeOffset)
        : 0
    };
  } catch {
    return { dayOffset: 4, networkTimeOffset: 0 };
  }
}

async function readLastPeriodicAuditState() {
  try {
    const cache = await caches.open(META_CACHE_NAME);
    const res = await cache.match(SW_AUDIT_STATE_REQUEST);
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}

async function writeLastPeriodicAuditState(state) {
  try {
    const cache = await caches.open(META_CACHE_NAME);
    await cache.put(
      SW_AUDIT_STATE_REQUEST,
      new Response(JSON.stringify(state), {
        headers: { 'Content-Type': 'application/json' }
      })
    );
  } catch {
    // Non-fatal
  }
}

async function probeHttpUtcOffset(fallbackOffsetMs) {
  try {
    const started = Date.now();
    const res = await fetch(resolveScopedUrl('./manifest.json'), {
      method: 'HEAD',
      cache: 'no-store'
    });
    const ended = Date.now();
    const dateHeader = res.headers.get('Date');
    if (dateHeader) {
      const serverUtcMs = Date.parse(dateHeader);
      if (Number.isFinite(serverUtcMs) && serverUtcMs > 1700000000000) {
        const midpoint = started + Math.round((ended - started) / 2);
        return Math.round(serverUtcMs - midpoint);
      }
    }
  } catch {
    // Offline or restricted; retain stored offset
  }
  return fallbackOffsetMs;
}

function normalizeDatePure(rawDate) {
  if (!rawDate) return '';
  const clean = String(rawDate).replace(/^'/, '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(clean)) {
    return clean.slice(0, 10);
  }
  if (clean.includes('.')) {
    const parts = clean.split('.');
    if (parts.length === 3 && parts[2].length >= 4) {
      const year = parts[2].slice(0, 4);
      return `${year}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
  }
  if (clean.includes('/')) {
    const parts = clean.split('/');
    if (parts.length === 3 && parts[2].length >= 4) {
      const year = parts[2].slice(0, 4);
      return `${year}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
    }
  }
  return clean.slice(0, 10);
}

function computeBusinessDateString(dayOffsetHours, ntpOffsetMs) {
  const adjustedNowMs = Date.now() + (Number(ntpOffsetMs) || 0);
  const offsetHours = Number.isFinite(Number(dayOffsetHours)) ? Number(dayOffsetHours) : 4;
  const shifted = new Date(adjustedNowMs - offsetHours * 3600000);
  const yyyy = shifted.getFullYear();
  const mm = String(shifted.getMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function shiftIsoDate(dateStr, deltaDays) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return dateStr;
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + deltaDays));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function resolveExistingAtlasDbVersion() {
  if (typeof indexedDB === 'undefined') return null;

  if (typeof indexedDB.databases === 'function') {
    try {
      const dbs = await indexedDB.databases();
      const match = Array.isArray(dbs)
        ? dbs.find((entry) => entry && entry.name === ATLAS_IDB_NAME)
        : null;
      if (!match || !match.version) {
        return false; // Database does not exist yet; do not create an empty placeholder
      }
      return Math.max(ATLAS_IDB_SCHEMA_VERSION * 10, Number(match.version) || 0);
    } catch {
      return undefined; // Fall through to safe open without explicit version
    }
  }

  return undefined;
}

async function inspectIndexedDbRollover(businessDate) {
  if (typeof indexedDB === 'undefined') {
    return { ...EMPTY_ROLLOVER_SUMMARY };
  }

  const resolvedVersion = await resolveExistingAtlasDbVersion();
  if (resolvedVersion === false) {
    return { ...EMPTY_ROLLOVER_SUMMARY };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let request;
    try {
      request =
        typeof resolvedVersion === 'number' && resolvedVersion > 0
          ? indexedDB.open(ATLAS_IDB_NAME, resolvedVersion)
          : indexedDB.open(ATLAS_IDB_NAME);
    } catch {
      finish({ ...EMPTY_ROLLOVER_SUMMARY });
      return;
    }

    // Never allow Service Worker to initialize or mutate an uncreated database schema
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0 && request.transaction) {
        try {
          request.transaction.abort();
        } catch {
          // Ignore abort failure
        }
      }
    };

    request.onerror = () => {
      finish({ ...EMPTY_ROLLOVER_SUMMARY });
    };

    request.onblocked = () => {
      finish({ ...EMPTY_ROLLOVER_SUMMARY });
    };

    request.onsuccess = () => {
      const db = request.result;
      try {
        // Dexie v4 (`AtlasOfflineDB`) uses `contracts` & `execution_logs`; keep alias fallback for safety
        const contractsStoreName = db.objectStoreNames.contains('contracts')
          ? 'contracts'
          : db.objectStoreNames.contains('agreements')
          ? 'agreements'
          : null;
        const logsStoreName = db.objectStoreNames.contains('execution_logs')
          ? 'execution_logs'
          : db.objectStoreNames.contains('logs')
          ? 'logs'
          : null;

        if (!contractsStoreName || !logsStoreName) {
          db.close();
          finish({ ...EMPTY_ROLLOVER_SUMMARY });
          return;
        }

        const tx = db.transaction([contractsStoreName, logsStoreName], 'readonly');
        const contractsReq = tx.objectStore(contractsStoreName).getAll();
        const logsReq = tx.objectStore(logsStoreName).getAll();

        tx.oncomplete = () => {
          const contracts = Array.isArray(contractsReq.result) ? contractsReq.result : [];
          const logs = Array.isArray(logsReq.result) ? logsReq.result : [];
          const yesterdayStr = shiftIsoDate(businessDate, -1);

          const activeContracts = contracts.filter(
            (c) => c && c.status === 'Active' && c.contract_id
          );
          const logsByContractDate = new Set(
            logs
              .filter((l) => l && l.contract_id && l.date && l.status !== 'Insight')
              .map((l) => `${l.contract_id}::${normalizeDatePure(l.date)}`)
          );

          let missedYesterdayCount = 0;
          let pendingTodayCount = 0;

          for (const contract of activeContracts) {
            const createdDate = normalizeDatePure(contract.created_at);
            if (!logsByContractDate.has(`${contract.contract_id}::${businessDate}`)) {
              pendingTodayCount += 1;
            }
            if (
              createdDate &&
              createdDate <= yesterdayStr &&
              !logsByContractDate.has(`${contract.contract_id}::${yesterdayStr}`)
            ) {
              missedYesterdayCount += 1;
            }
          }

          db.close();
          finish({
            activeCount: activeContracts.length,
            missedYesterdayCount,
            pendingTodayCount
          });
        };

        tx.onerror = () => {
          db.close();
          finish({ ...EMPTY_ROLLOVER_SUMMARY });
        };

        tx.onabort = () => {
          db.close();
          finish({ ...EMPTY_ROLLOVER_SUMMARY });
        };
      } catch {
        db.close();
        finish({ ...EMPTY_ROLLOVER_SUMMARY });
      }
    };
  });
}

async function runPeriodicBusinessDayAudit() {
  const cfg = await readSwConfig();
  const effectiveOffset = await probeHttpUtcOffset(cfg.networkTimeOffset);
  if (effectiveOffset !== cfg.networkTimeOffset) {
    await persistSwConfig({
      dayOffset: cfg.dayOffset,
      networkTimeOffset: effectiveOffset,
      updatedAt: new Date().toISOString()
    });
  }

  const businessDate = computeBusinessDateString(cfg.dayOffset, effectiveOffset);
  const auditSummary = await inspectIndexedDbRollover(businessDate);
  const prevAudit = await readLastPeriodicAuditState();

  const nextState = {
    businessDate,
    checkedAt: new Date().toISOString(),
    networkTimeOffset: effectiveOffset,
    ...auditSummary
  };
  await writeLastPeriodicAuditState(nextState);

  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });

  if (clients.length > 0) {
    for (const client of clients) {
      client.postMessage({
        type: 'PERIODIC_BUSINESS_DAY_AUDIT',
        payload: nextState
      });
    }
    return;
  }

  // Trigger at most one background reminder per business date if permission is already granted
  if (
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted' &&
    auditSummary.missedYesterdayCount > 0 &&
    prevAudit?.notifiedBusinessDate !== businessDate
  ) {
    await writeLastPeriodicAuditState({
      ...nextState,
      notifiedBusinessDate: businessDate
    });
    await self.registration.showNotification('Project Atlas', {
      body: `Бізнес-день ${businessDate}: не зафіксовано вчорашній звіт (${auditSummary.missedYesterdayCount}). Відкрийте додаток.`,
      icon: resolveScopedUrl('./apple-touch-icon.png'),
      badge: resolveScopedUrl('./icon.svg'),
      tag: 'atlas-business-day-audit'
    });
  }
}

// ----------------------------------------------------------------------------
// 3. Cache Pruning Helpers
// ----------------------------------------------------------------------------

async function trimCache(cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      const itemsToDelete = keys.length - maxItems;
      for (let i = 0; i < itemsToDelete; i++) {
        await cache.delete(keys[i]);
      }
    }
  } catch (err) {
    console.warn('[SW v6] trimCache warning:', err);
  }
}

// ----------------------------------------------------------------------------
// 4. Fetch Strategies
// ----------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Never intercept Firebase Auth or Google OAuth endpoints
  if (AUTH_BYPASS_HOSTS.some((host) => url.hostname.includes(host))) {
    return;
  }

  // A. SPA Navigation: Network-First with pre-cached scoped index.html fallback
  if (event.request.mode === 'navigate') {
    const indexShellUrl = resolveScopedUrl('./index.html');
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(STATIC_CACHE_NAME).then((cache) => {
              void cache.put(indexShellUrl, clone);
            });
          }
          return response;
        })
        .catch(() => caches.match(indexShellUrl))
    );
    return;
  }

  // B. Google Drive API READs: Network-First with bounded offline cache fallback
  if (url.hostname.includes('googleapis.com')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          const isValidStatus = networkResponse.status === 200 || networkResponse.status === 0;
          const isOpaque = networkResponse.type === 'opaque';
          if (isValidStatus) {
            const clone = networkResponse.clone();
            caches.open(API_CACHE_NAME).then(async (cache) => {
              await cache.put(event.request, clone);
              await trimCache(API_CACHE_NAME, isOpaque ? MAX_OPAQUE_ENTRIES : MAX_API_ENTRIES);
            });
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // C. Static Assets & App Shell: Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          const isValidStatus = networkResponse.status === 200 || networkResponse.status === 0;
          if (networkResponse && isValidStatus) {
            caches.open(STATIC_CACHE_NAME).then(async (cache) => {
              await cache.put(event.request, networkResponse.clone());
              await trimCache(STATIC_CACHE_NAME, MAX_STATIC_ENTRIES);
            });
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

// ----------------------------------------------------------------------------
// 5. Background Sync, Periodic Background Sync & Push Notifications
// ----------------------------------------------------------------------------

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-offline-mutations') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'SYNC_OFFLINE_MUTATIONS' });
        }
      })
    );
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'atlas-business-day-audit') {
    event.waitUntil(runPeriodicBusinessDayAudit());
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch (err) {
    console.error('[SW v6] Push payload parse error:', err);
  }

  const title = data.title || 'Project Atlas';
  const options = {
    body: data.body || 'Системне сповіщення.',
    icon: resolveScopedUrl('./apple-touch-icon.png'),
    badge: resolveScopedUrl('./icon.svg'),
    tag: data.tag || 'atlas-system-notification'
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scopeUrl = resolveScopedUrl('./');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.startsWith(scopeUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(scopeUrl);
      }
    })
  );
});
