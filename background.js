const STORAGE_KEY_RESULTS = 'avitoLabels:lastResults';
const STORAGE_KEY_JOB = 'avitoLabels:jobStatus';
const FETCH_CONCURRENCY = 2;
const FETCH_REQUEST_MIN_DELAY_MS = 250;
const FETCH_REQUEST_MAX_DELAY_MS = 650;
const TAB_OPEN_MIN_DELAY_MS = 350;
const TAB_OPEN_MAX_DELAY_MS = 900;
const RETRY_JITTER_MIN_MS = 60;
const RETRY_JITTER_MAX_MS = 220;
const BADGE_BG_COLOR = '#0f7a5a';
const BADGE_TEXT_COLOR = '#ffffff';

let jobRunning = false;
let throttleQueue = Promise.resolve();
let nextAllowedRequestAt = 0;
let activeJobContext = null;

registerBadgeListeners();
syncBadgeCountFromStorage();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startAvitoResolve') {
    startAvitoResolveJob()
      .then((status) => sendResponse(status))
      .catch(() => sendResponse({ status: 'error' }));
    return true;
  }

  if (request.action === 'cancelAvitoResolve') {
    cancelAvitoResolveJob()
      .then((status) => sendResponse(status))
      .catch(() => sendResponse({ status: 'error' }));
    return true;
  }

  if (request.action === 'fetchTrackingFromOrder') {
    const url = request.url || '';
    const service = request.service || '';

    (async () => {
      const trackingNumber = await fetchTrackingNumber(url, service);
      sendResponse({ trackingNumber });
    })();

    return true;
  }
});

function registerBadgeListeners() {
  if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!changes[STORAGE_KEY_RESULTS]) return;
      updateBadgeFromOrders(changes[STORAGE_KEY_RESULTS].newValue);
    });
  }

  if (chrome.runtime && chrome.runtime.onInstalled && chrome.runtime.onInstalled.addListener) {
    chrome.runtime.onInstalled.addListener(() => {
      syncBadgeCountFromStorage();
    });
  }

  if (chrome.runtime && chrome.runtime.onStartup && chrome.runtime.onStartup.addListener) {
    chrome.runtime.onStartup.addListener(() => {
      syncBadgeCountFromStorage();
    });
  }
}

async function syncBadgeCountFromStorage() {
  try {
    const orders = await getOrdersFromStorage();
    await updateBadgeFromOrders(orders);
  } catch (e) {
    // noop
  }
}

function formatBadgeCount(count) {
  if (!count || count < 1) return '';
  if (count > 999) return '999+';
  return String(count);
}

function setBadgeText(text) {
  return new Promise((resolve) => {
    if (!chrome.action || !chrome.action.setBadgeText) {
      resolve();
      return;
    }

    chrome.action.setBadgeText({ text }, () => {
      chrome.runtime.lastError;
      resolve();
    });
  });
}

function setBadgeStyle() {
  const tasks = [];

  if (chrome.action && chrome.action.setBadgeBackgroundColor) {
    tasks.push(
      new Promise((resolve) => {
        chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_COLOR }, () => {
          chrome.runtime.lastError;
          resolve();
        });
      })
    );
  }

  if (chrome.action && chrome.action.setBadgeTextColor) {
    tasks.push(
      new Promise((resolve) => {
        chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR }, () => {
          chrome.runtime.lastError;
          resolve();
        });
      })
    );
  }

  return Promise.all(tasks);
}

async function updateBadgeFromOrders(orders) {
  const count = Array.isArray(orders) ? orders.length : 0;
  await setBadgeStyle();
  await setBadgeText(formatBadgeCount(count));
}

async function startAvitoResolveJob() {
  if (jobRunning) {
    if (activeJobContext && activeJobContext.cancelled) {
      await waitForJobStop(5000);
      if (jobRunning) {
        const currentStatus = await getJobStatus();
        return currentStatus || { status: 'running' };
      }
    }

    if (jobRunning) {
      const currentStatus = await getJobStatus();
      return currentStatus || { status: 'running' };
    }
  }

  const jobContext = {
    id: Date.now(),
    cancelled: false,
    workerWindowId: null
  };
  activeJobContext = jobContext;

  jobRunning = true;
  try {
    const orders = await getOrdersFromStorage();
    if (!orders.length) {
      await setJobStatus({ status: 'done', total: 0, done: 0 });
      return { status: 'done', total: 0, done: 0 };
    }

    if (isJobCancelled(jobContext)) {
      await setJobStatus({ status: 'cancelled', total: 0, done: 0 });
      return { status: 'cancelled', total: 0, done: 0 };
    }

    const tasks = orders
      .map((order, index) => ({ order, index }))
      .filter((item) => shouldResolveTracking(item.order))
      .map((item) => ({
        index: item.index,
        url: item.order.orderUrl,
        service: item.order.service || ''
      }));

    if (!tasks.length) {
      await setJobStatus({ status: 'done', total: 0, done: 0 });
      return { status: 'done', total: 0, done: 0 };
    }

    const total = tasks.length;
    let done = 0;

    await setJobStatus({ status: 'running', total, done });

    const unresolved = await resolveByFetch(tasks, orders, (increment) => {
      if (isJobCancelled(jobContext)) return;
      done += increment;
      setJobStatus({ status: 'running', total, done });
    }, jobContext);

    if (isJobCancelled(jobContext)) {
      await setJobStatus({ status: 'cancelled', total, done });
      return { status: 'cancelled', total, done };
    }

    if (unresolved.length) {
      const worker = await createWorkerWindow();
      jobContext.workerWindowId = worker && worker.windowId ? worker.windowId : null;
      try {
        for (const task of unresolved) {
          if (isJobCancelled(jobContext)) break;
          await setJobStatus({ status: 'running', total, done, current: task.index });
          const tracking = await fetchTrackingByTab(task.url, worker, task.service, jobContext);
          if (isJobCancelled(jobContext)) break;
          if (tracking) {
            orders[task.index].trackingNumber = tracking;
            await saveOrdersToStorage(orders);
          }
          done += 1;
          await setJobStatus({ status: 'running', total, done, current: task.index });
        }
      } finally {
        jobContext.workerWindowId = null;
        if (worker && worker.windowId) {
          await safeRemoveWindow(worker.windowId);
        }
      }
    }

    if (isJobCancelled(jobContext)) {
      await setJobStatus({ status: 'cancelled', total, done });
      return { status: 'cancelled', total, done };
    }

    await setJobStatus({ status: 'done', total, done });
    return { status: 'done', total, done };
  } finally {
    if (activeJobContext === jobContext) {
      activeJobContext = null;
    }
    jobRunning = false;
  }
}

async function cancelAvitoResolveJob() {
  const status = await getJobStatus();

  if (!jobRunning || !activeJobContext) {
    return status || { status: 'idle' };
  }

  activeJobContext.cancelled = true;
  const workerWindowId = activeJobContext.workerWindowId;
  activeJobContext.workerWindowId = null;

  if (workerWindowId) {
    await safeRemoveWindow(workerWindowId);
  }

  await setJobStatus({
    status: 'cancelled',
    total: status && typeof status.total === 'number' ? status.total : 0,
    done: status && typeof status.done === 'number' ? status.done : 0
  });

  await waitForJobStop(7000);
  return { status: jobRunning ? 'cancelling' : 'cancelled' };
}

async function resolveByFetch(tasks, orders, onResolved, jobContext) {
  const concurrency = FETCH_CONCURRENCY;
  const queue = tasks.slice();
  const unresolved = [];

  async function worker() {
    while (queue.length && !isJobCancelled(jobContext)) {
      const task = queue.shift();
      if (!task) return;

      const tracking = await fetchTrackingByRequest(task.url, task.service, jobContext);
      if (isJobCancelled(jobContext)) return;
      if (tracking) {
        orders[task.index].trackingNumber = tracking;
        await saveOrdersToStorage(orders);
        onResolved(1);
      } else {
        unresolved.push(task);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return unresolved;
}

function createWorkerWindow() {
  return new Promise((resolve) => {
    chrome.windows.create(
      { focused: true, state: 'normal', type: 'normal', url: 'about:blank' },
      (win) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ windowId: null });
          return;
        }
        const windowId = win && win.id ? win.id : null;
        resolve({ windowId });
      }
    );
  });
}

async function fetchTrackingNumber(url, service) {
  if (!url) return '';

  const fromFetch = await fetchTrackingByRequest(url, service, null);
  if (fromFetch) return fromFetch;

  const worker = await createWorkerWindow();
  try {
    const fromTab = await fetchTrackingByTab(url, worker, service, null);
    return fromTab || '';
  } finally {
    if (worker && worker.windowId) {
      await safeRemoveWindow(worker.windowId);
    }
  }
}

async function fetchTrackingByRequest(url, service, jobContext) {
  try {
    if (isJobCancelled(jobContext)) return '';
    await waitForThrottleSlot(FETCH_REQUEST_MIN_DELAY_MS, FETCH_REQUEST_MAX_DELAY_MS);
    if (isJobCancelled(jobContext)) return '';
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) return '';

    const html = await response.text();
    const text = htmlToText(html);
    return extractTrackingFromText(text, service);
  } catch (e) {
    return '';
  }
}

async function fetchTrackingByTab(url, worker, service, jobContext) {
  if (!worker || !worker.windowId) {
    return '';
  }

  if (isJobCancelled(jobContext)) return '';
  await waitForThrottleSlot(TAB_OPEN_MIN_DELAY_MS, TAB_OPEN_MAX_DELAY_MS);
  if (isJobCancelled(jobContext)) return '';

  return new Promise((resolve) => {
    chrome.windows.update(worker.windowId, { focused: true }, () => {
      chrome.runtime.lastError;
    });

    chrome.tabs.create(
      { windowId: worker.windowId, url, active: true },
      (tab) => {
        const createErr = chrome.runtime.lastError;
        if (createErr) {
          resolve('');
          return;
        }
        if (!tab || !tab.id) {
          resolve('');
          return;
        }

        const tabId = tab.id;
        let resolved = false;

        function cleanup(result) {
          if (resolved) return;
          resolved = true;
          safeRemoveTab(tabId).then(() => resolve(result));
        }

        tryGetTrackingWithRetries(tabId, 25000, 800, service, jobContext).then((tracking) => {
          cleanup(tracking || '');
        });
      }
    );
  });
}

async function tryGetTrackingWithRetries(tabId, timeoutMs, intervalMs, service, jobContext) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs && !isJobCancelled(jobContext)) {
    const tracking = await executeTrackingScript(tabId, service);
    if (tracking) return tracking;
    await delay(intervalMs + randomInt(RETRY_JITTER_MIN_MS, RETRY_JITTER_MAX_MS));
  }
  return '';
}

function waitForThrottleSlot(minDelay, maxDelay) {
  throttleQueue = throttleQueue.then(async () => {
    const waitMs = Math.max(0, nextAllowedRequestAt - Date.now());
    if (waitMs > 0) {
      await delay(waitMs);
    }
    nextAllowedRequestAt = Date.now() + randomInt(minDelay, maxDelay);
  });
  return throttleQueue;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isJobCancelled(jobContext) {
  return !!(jobContext && jobContext.cancelled);
}

function waitForJobStop(timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    function poll() {
      if (!jobRunning || Date.now() - started >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(poll, 80);
    }
    poll();
  });
}

function safeRemoveWindow(windowId) {
  return new Promise((resolve) => {
    chrome.windows.remove(windowId, () => {
      chrome.runtime.lastError;
      resolve();
    });
  });
}

function safeRemoveTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      chrome.runtime.lastError;
      resolve();
    });
  });
}

function executeTrackingScript(tabId, service) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        func: extractTrackingFromPageOnce,
        args: [service]
      },
      (results) => {
        if (chrome.runtime.lastError) {
          resolve('');
          return;
        }
        const tracking =
          (results || [])
            .map((item) => (item ? item.result : ''))
            .find((value) => value && value.length) || '';
        resolve(tracking);
      }
    );
  });
}

function extractTrackingFromPageOnce(service) {
  function normalizeText(value) {
    return (value || '')
      .replace(/[\u00A0\u202F\u2007]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanDigits(value) {
    return normalizeText(value)
      .replace(/\s+/g, '')
      .replace(/[^0-9]/g, '');
  }

  function isValidAvitoNumber(value) {
    if (!value) return false;
    if (!/^[0-9]+$/.test(value)) return false;
    if (value.length < 6 || value.length > 12) return false;
    return true;
  }

  function isValidFivePostCode(value) {
    if (!value) return false;
    if (!/^[0-9]+$/.test(value)) return false;
    if (value.length < 6 || value.length > 12) return false;
    return true;
  }

  function extractAvitoTrackingFromText(sourceText) {
    const pattern = /Назовите\s+этот\s+номер[^0-9]*([0-9][0-9\s]{5,})/i;
    const match = sourceText.match(pattern);
    if (match) {
      const digits = cleanDigits(match[1]);
      if (isValidAvitoNumber(digits)) return digits;
    }

    return '';
  }

  function extractFivePostTrackingFromText(sourceText) {
    const anchored = sourceText.match(/([0-9][0-9\s]{5,20})\s+Посмотреть\s+постамат/i);
    if (anchored) {
      const digits = cleanDigits(anchored[1]);
      if (isValidFivePostCode(digits)) return digits;
    }

    const matches = sourceText.matchAll(/[0-9][0-9\s]{5,20}/g);
    for (const match of matches) {
      const raw = match[0] || '';
      const digits = cleanDigits(raw);
      if (!isValidFivePostCode(digits)) continue;

      const index = match.index || 0;
      const from = Math.max(0, index - 120);
      const to = Math.min(sourceText.length, index + raw.length + 120);
      const context = sourceText.slice(from, to).toLowerCase();

      if (
        context.includes('постамат') ||
        context.includes('касс') ||
        context.includes('введите код') ||
        context.includes('сообщите код') ||
        context.includes('покажите qr')
      ) {
        return digits;
      }
    }

    return '';
  }

  function findTracking() {
    const text = (document.body && document.body.textContent) ? document.body.textContent : '';
    const normalized = normalizeText(text);

    if (service === '5Post') {
      const fromCopyIcon = findFivePostByCopyIcon();
      if (fromCopyIcon) return fromCopyIcon;

      const fromText = extractFivePostTrackingFromText(normalized);
      if (fromText) return fromText;

      const fromBlocks = findFivePostByDigitBlock();
      if (fromBlocks) return fromBlocks;
      return '';
    }

    const fromText = extractAvitoTrackingFromText(normalized);
    if (fromText) return fromText;

    const labeled = findAvitoByLabel();
    if (labeled) return labeled;

    if (!service) {
      const autoFivePost = findFivePostByCopyIcon() || extractFivePostTrackingFromText(normalized);
      if (autoFivePost) return autoFivePost;
    }

    return '';
  }

  function findAvitoByLabel() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue) continue;
      if (!node.nodeValue.includes('Назовите этот номер')) continue;

      const parent = node.parentElement;
      if (!parent) continue;

      const directStrong = parent.querySelector('strong, b');
      if (directStrong) {
        const digits = cleanDigits(directStrong.textContent || '');
        if (isValidAvitoNumber(digits)) return digits;
      }

      const sibling = parent.nextElementSibling;
      if (sibling) {
        const siblingStrong = sibling.querySelector('strong, b');
        if (siblingStrong) {
          const digits = cleanDigits(siblingStrong.textContent || '');
          if (isValidAvitoNumber(digits)) return digits;
        }
      }

      let container = parent.parentElement;
      for (let depth = 0; depth < 3 && container; depth++) {
        const strong = container.querySelector('strong, b');
        if (strong) {
          const digits = cleanDigits(strong.textContent || '');
          if (isValidAvitoNumber(digits)) return digits;
        }
        container = container.parentElement;
      }
    }

    return '';
  }

  function findFivePostByCopyIcon() {
    const icons = document.querySelectorAll('svg[data-icon="copy"], svg[name="copy"]');
    for (const icon of icons) {
      const container = icon.closest('span, div, p');
      if (!container) continue;
      const digits = cleanDigits(container.textContent || '');
      if (isValidFivePostCode(digits)) return digits;
    }
    return '';
  }

  function findFivePostByDigitBlock() {
    const nodes = document.querySelectorAll('span, div, p, strong, b');
    for (const node of nodes) {
      const value = normalizeText(node.textContent || '');
      if (!/^[0-9][0-9\s]{5,20}$/.test(value)) continue;

      const digits = cleanDigits(value);
      if (!isValidFivePostCode(digits)) continue;

      const context = normalizeText((node.parentElement && node.parentElement.textContent) || '').toLowerCase();
      if (
        context.includes('постамат') ||
        context.includes('касс') ||
        context.includes('код') ||
        context.includes('qr')
      ) {
        return digits;
      }
    }
    return '';
  }

  return findTracking();
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTrackingFromText(text, service) {
  const normalized = normalizeText(text);
  if (!normalized) return '';

  if (service === '5Post') {
    return extractFivePostTrackingFromText(normalized);
  }

  if (service === 'Авито') {
    return extractAvitoTrackingFromText(normalized);
  }

  return extractAvitoTrackingFromText(normalized) || extractFivePostTrackingFromText(normalized);
}

function extractAvitoTrackingFromText(text) {
  const match = text.match(/Назовите\s+этот\s+номер[^0-9]*([0-9][0-9\s]{5,})/i);
  if (!match) return '';

  const digits = cleanDigits(match[1]);
  if (!isValidAvitoTracking(digits)) return '';
  return digits;
}

function extractFivePostTrackingFromText(text) {
  const anchored = text.match(/([0-9][0-9\s]{5,20})\s+Посмотреть\s+постамат/i);
  if (anchored) {
    const digits = cleanDigits(anchored[1]);
    if (isValidFivePostTracking(digits)) return digits;
  }

  const matches = text.matchAll(/[0-9][0-9\s]{5,20}/g);
  for (const match of matches) {
    const raw = match[0] || '';
    const digits = cleanDigits(raw);
    if (!isValidFivePostTracking(digits)) continue;

    const index = match.index || 0;
    const from = Math.max(0, index - 120);
    const to = Math.min(text.length, index + raw.length + 120);
    const context = text.slice(from, to).toLowerCase();
    if (
      context.includes('постамат') ||
      context.includes('касс') ||
      context.includes('введите код') ||
      context.includes('сообщите код') ||
      context.includes('покажите qr')
    ) {
      return digits;
    }
  }

  return '';
}

function shouldResolveTracking(order) {
  if (!order || !order.orderUrl) return false;
  if (order.service === '5Post') return true;
  if (order.service === 'Авито') return !isValidAvitoTracking(cleanDigits(order.trackingNumber || ''));
  return false;
}

function normalizeText(value) {
  return (value || '')
    .replace(/[\u00A0\u202F\u2007]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanDigits(value) {
  return normalizeText(value)
    .replace(/\s+/g, '')
    .replace(/[^0-9]/g, '');
}

function isValidAvitoTracking(value) {
  if (!value) return false;
  if (!/^[0-9]+$/.test(value)) return false;
  if (value.length < 6 || value.length > 12) return false;
  return true;
}

function isValidFivePostTracking(value) {
  if (!value) return false;
  if (!/^[0-9]+$/.test(value)) return false;
  if (value.length < 6 || value.length > 12) return false;
  return true;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOrdersFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_RESULTS], (data) => {
      const orders = data[STORAGE_KEY_RESULTS];
      resolve(Array.isArray(orders) ? orders : []);
    });
  });
}

function saveOrdersToStorage(orders) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_RESULTS]: orders }, () => resolve());
  });
}

function setJobStatus(status) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_JOB]: status }, () => resolve());
  });
}

function getJobStatus() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_JOB], (data) => {
      resolve(data[STORAGE_KEY_JOB] || null);
    });
  });
}
