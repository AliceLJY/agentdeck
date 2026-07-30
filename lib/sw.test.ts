import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'node:vm';

/**
 * Runs public/sw.js in a minimal fake service-worker global and returns a way to
 * drive its fetch handler. The file ships to browsers verbatim and had no test
 * at all, which is how a cache-first strategy pinned devices to a stale bundle
 * for weeks without anyone noticing.
 */
function loadServiceWorker(networkImpl: (req: FakeRequest) => Promise<FakeResponse>) {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const cachePuts: string[] = [];
  const deletedCaches: string[] = [];
  let cacheContents: Record<string, FakeResponse> = {};

  const cacheApi = {
    open: async () => ({
      addAll: async () => {},
      put: async (req: FakeRequest, res: FakeResponse) => {
        cachePuts.push(typeof req === 'string' ? req : req.url);
        void res;
      },
    }),
    match: async (req: FakeRequest) => cacheContents[typeof req === 'string' ? req : req.url],
    keys: async () => ['cc-terminal-v1', 'agentdeck-v2'],
    delete: async (key: string) => {
      deletedCaches.push(key);
      return true;
    },
  };

  const sandbox = {
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        (listeners[type] ??= []).push(fn);
      },
      skipWaiting: () => {},
      clients: { claim: () => {} },
    },
    caches: cacheApi,
    fetch: (req: FakeRequest) => networkImpl(req),
    URL,
    Promise,
    Error,
    console,
  };

  const code = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');
  vm.runInNewContext(code, sandbox);

  return {
    listeners,
    cachePuts,
    deletedCaches,
    setCache: (contents: Record<string, FakeResponse>) => {
      cacheContents = contents;
    },
    /** Returns the response the worker served, or null when it did not intercept. */
    async dispatchFetch(url: string, method = 'GET'): Promise<FakeResponse | null> {
      let responded: Promise<FakeResponse> | null = null;
      const event = {
        request: { url, method } as FakeRequest,
        respondWith: (p: Promise<FakeResponse>) => {
          responded = p;
        },
        waitUntil: () => {},
      };
      for (const fn of listeners.fetch ?? []) fn(event);
      return responded ? await responded : null;
    },
    async dispatchActivate(): Promise<void> {
      const waits: Promise<unknown>[] = [];
      const event = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
      for (const fn of listeners.activate ?? []) fn(event);
      await Promise.all(waits);
    },
  };
}

interface FakeRequest {
  url: string;
  method: string;
}
interface FakeResponse {
  ok: boolean;
  body: string;
  clone(): FakeResponse;
}

const res = (body: string, ok = true): FakeResponse => ({
  ok,
  body,
  clone() {
    return res(body, ok);
  },
});

test('API traffic is never intercepted', async () => {
  // Caching an API response would be actively harmful: a cached `pending` from
  // /api/devices/self would survive the owner approving the device.
  const sw = loadServiceWorker(async () => res('from-network'));
  assert.equal(await sw.dispatchFetch('https://x.test/api/devices/self'), null);
  assert.equal(await sw.dispatchFetch('https://x.test/api/history'), null);
});

test('WebSocket upgrades are never intercepted', async () => {
  const sw = loadServiceWorker(async () => res('from-network'));
  assert.equal(await sw.dispatchFetch('https://x.test/ws/terminal'), null);
});

test('a page request prefers the network over a stale cache', async () => {
  // The regression: `cached || networkFetch` returned the cached bundle without
  // waiting for the network, so a device could keep running an old build after
  // every deploy.
  const sw = loadServiceWorker(async () => res('fresh-build'));
  sw.setCache({ 'https://x.test/': res('stale-build') });

  const served = await sw.dispatchFetch('https://x.test/');
  assert.equal(served?.body, 'fresh-build', 'a reachable server must win over the cache');
});

test('the cache is used when the network fails', async () => {
  const sw = loadServiceWorker(async () => {
    throw new Error('offline');
  });
  sw.setCache({ 'https://x.test/': res('stale-build') });

  const served = await sw.dispatchFetch('https://x.test/');
  assert.equal(served?.body, 'stale-build', 'offline must still render something');
});

test('an offline miss fails instead of resolving empty', async () => {
  const sw = loadServiceWorker(async () => {
    throw new Error('offline');
  });
  await assert.rejects(() => sw.dispatchFetch('https://x.test/never-seen'));
});

test('successful GETs are written to the cache', async () => {
  const sw = loadServiceWorker(async () => res('fresh-build'));
  await sw.dispatchFetch('https://x.test/');
  assert.deepEqual(sw.cachePuts, ['https://x.test/']);
});

test('a failed response is not cached', async () => {
  const sw = loadServiceWorker(async () => res('error-page', false));
  await sw.dispatchFetch('https://x.test/');
  assert.deepEqual(sw.cachePuts, [], 'a 500 must not become the cached copy');
});

test('activate drops caches under other names', async () => {
  // This is what makes a bumped CACHE_NAME actually evict the old bundle.
  const sw = loadServiceWorker(async () => res('fresh'));
  await sw.dispatchActivate();
  assert.deepEqual(sw.deletedCaches, ['cc-terminal-v1']);
});
