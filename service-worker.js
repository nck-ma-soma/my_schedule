const CACHE_NAME = 'yokohama-travel-v1.0.0';

// キャッシュするリソース
const STATIC_RESOURCES = [
  '/',
  '/index.html',
  '/manifest.json',
  // 外部フォント（オプション）
  'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap'
];

// API設定（PWA用）
const API_CACHE_CONFIG = {
  weather: {
    ttl: 10 * 60 * 1000, // 10分
    strategy: 'cache-first-with-refresh'
  },
  events: {
    ttl: 30 * 60 * 1000, // 30分
    strategy: 'network-first'
  },
  traffic: {
    ttl: 5 * 60 * 1000, // 5分
    strategy: 'network-first'
  }
};

// Service Worker インストール
self.addEventListener('install', event => {
  console.log('[SW] インストール開始');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] 静的リソースをキャッシュ中');
        return cache.addAll(STATIC_RESOURCES);
      })
      .then(() => {
        console.log('[SW] インストール完了');
        self.skipWaiting(); // 新しいSWを即座にアクティブ化
      })
  );
});

// Service Worker アクティベーション
self.addEventListener('activate', event => {
  console.log('[SW] アクティベーション開始');
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== CACHE_NAME) {
              console.log('[SW] 古いキャッシュを削除:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('[SW] アクティベーション完了');
        return self.clients.claim(); // 既存のページにも新しいSWを適用
      })
  );
});

// フェッチイベント処理
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  
  // HTML、CSS、JS、画像の場合はキャッシュファーストで対応
  if (request.method === 'GET' && 
      (url.pathname.endsWith('.html') || 
       url.pathname.endsWith('.css') || 
       url.pathname.endsWith('.js') || 
       url.pathname.match(/\.(png|jpg|jpeg|gif|svg|ico)$/i) ||
       url.pathname === '/')) {
    
    event.respondWith(
      caches.match(request)
        .then(cachedResponse => {
          if (cachedResponse) {
            // キャッシュから返すが、バックグラウンドで更新もチェック
            fetch(request)
              .then(networkResponse => {
                if (networkResponse.ok) {
                  caches.open(CACHE_NAME)
                    .then(cache => cache.put(request, networkResponse.clone()));
                }
              })
              .catch(() => {
                // ネットワークエラーは無視（オフライン対応）
              });
            
            return cachedResponse;
          }
          
          // キャッシュにない場合はネットワークから取得
          return fetch(request)
            .then(networkResponse => {
              if (networkResponse.ok) {
                caches.open(CACHE_NAME)
                  .then(cache => cache.put(request, networkResponse.clone()));
              }
              return networkResponse;
            });
        })
        .catch(() => {
          // オフライン時のフォールバック
          return new Response(
            generateOfflinePage(),
            {
              headers: { 'Content-Type': 'text/html' }
            }
          );
        })
    );
  }
  
  // API リクエストの場合は特別な戦略を適用
  else if (isApiRequest(request)) {
    event.respondWith(handleApiRequest(request));
  }
  
  // その他のリクエストはネットワークファースト
  else {
    event.respondWith(
      fetch(request)
        .catch(() => {
          return caches.match(request);
        })
    );
  }
});

// API リクエストかどうかを判定
function isApiRequest(request) {
  const url = new URL(request.url);
  return url.hostname.includes('api.') || 
         url.hostname.includes('weather') ||
         url.pathname.includes('/api/');
}

// API リクエストの処理
async function handleApiRequest(request) {
  const url = new URL(request.url);
  const cacheKey = `api-${url.pathname}${url.search}`;
  
  try {
    // ネットワークファーストで試行
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // 成功時はキャッシュに保存
      const cache = await caches.open(CACHE_NAME);
      const responseToCache = networkResponse.clone();
      
      // TTL情報を追加
      const now = Date.now();
      const ttl = getApiTtl(url);
      responseToCache.headers.set('sw-cached-at', now.toString());
      responseToCache.headers.set('sw-ttl', ttl.toString());
      
      await cache.put(cacheKey, responseToCache);
      return networkResponse;
    }
  } catch (error) {
    console.log('[SW] API ネットワークエラー、キャッシュを確認:', error);
  }
  
  // ネットワーク失敗時はキャッシュから取得
  const cachedResponse = await caches.match(cacheKey);
  if (cachedResponse) {
    const cachedAt = parseInt(cachedResponse.headers.get('sw-cached-at') || '0');
    const ttl = parseInt(cachedResponse.headers.get('sw-ttl') || '0');
    
    if (Date.now() - cachedAt < ttl) {
      console.log('[SW] 有効なAPIキャッシュを返却');
      return cachedResponse;
    }
  }
  
  // フォールバック：エラーレスポンス
  return new Response(
    JSON.stringify({
      error: 'オフライン状態です',
      message: '接続が復旧次第、最新データを取得します',
      cached: false
    }),
    {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

// API TTL設定の取得
function getApiTtl(url) {
  if (url.hostname.includes('weather') || url.pathname.includes('weather')) {
    return API_CACHE_CONFIG.weather.ttl;
  }
  if (url.pathname.includes('event')) {
    return API_CACHE_CONFIG.events.ttl;
  }
  if (url.pathname.includes('traffic')) {
    return API_CACHE_CONFIG.traffic.ttl;
  }
  return 5 * 60 * 1000; // デフォルト5分
}

// オフライン時のページ生成
function generateOfflinePage() {
  return `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>オフライン - 横浜旅行スケジュール</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                margin: 0;
                padding: 20px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                text-align: center;
            }
            .offline-container {
                max-width: 400px;
                padding: 40px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 16px;
                backdrop-filter: blur(10px);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            }
            h1 {
                font-size: 2em;
                margin-bottom: 1rem;
            }
            p {
                font-size: 1.1em;
                line-height: 1.6;
                margin-bottom: 2rem;
                opacity: 0.9;
            }
            .retry-btn {
                padding: 12px 24px;
                background: rgba(255, 255, 255, 0.2);
                border: 2px solid rgba(255, 255, 255, 0.3);
                border-radius: 8px;
                color: white;
                font-size: 1em;
                cursor: pointer;
                transition: all 0.3s ease;
            }
            .retry-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: translateY(-2px);
            }
            .offline-icon {
                font-size: 4em;
                margin-bottom: 1rem;
                opacity: 0.8;
            }
        </style>
    </head>
    <body>
        <div class="offline-container">
            <div class="offline-icon">📱✈️</div>
            <h1>オフライン</h1>
            <p>
                現在オフライン状態です。<br>
                保存されたスケジュールは引き続き利用できます。<br>
                接続が復旧次第、最新情報を取得します。
            </p>
            <button class="retry-btn" onclick="window.location.reload()">
                再試行
            </button>
        </div>
    </body>
    </html>
  `;
}

// バックグラウンド同期（今後の拡張用）
self.addEventListener('sync', event => {
  if (event.tag === 'background-sync') {
    console.log('[SW] バックグラウンド同期実行');
    event.waitUntil(syncData());
  }
});

async function syncData() {
  try {
    // オフライン中に蓄積されたデータを送信
    const cache = await caches.open(CACHE_NAME);
    // 必要に応じて実装
  } catch (error) {
    console.error('[SW] 同期エラー:', error);
  }
}

// プッシュ通知（今後の拡張用）
self.addEventListener('push', event => {
  const options = {
    body: event.data ? event.data.text() : '新しい情報があります',
    icon: '/icon-192x192.png',
    badge: '/badge-72x72.png',
    vibrate: [200, 100, 200],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {
        action: 'explore',
        title: '確認',
        icon: '/images/checkmark.png'
      },
      {
        action: 'close',
        title: '閉じる',
        icon: '/images/xmark.png'
      }
    ]
  };

  event.waitUntil(
    self.registration.showNotification('横浜旅行スケジュール', options)
  );
});

// 通知クリック処理
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'explore') {
    event.waitUntil(
      clients.openWindow('/')
    );
  }
});

// メッセージ処理（アプリとの通信用）
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_NAME });
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.delete(CACHE_NAME).then(() => {
        event.ports[0].postMessage({ success: true });
      })
    );
  }
});

console.log('[SW] Service Worker 登録完了:', CACHE_NAME);
