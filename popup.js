const collectBtn = document.getElementById('collectBtn');
const resetBtn = document.getElementById('resetBtn');
const printBtn = document.getElementById('printBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const lastRunEl = document.getElementById('lastRun');

const STORAGE_KEY_RESULTS = 'avitoLabels:lastResults';
const STORAGE_KEY_RUN = 'avitoLabels:lastRun';
const STORAGE_KEY_JOB = 'avitoLabels:jobStatus';
const DELIVERY_SERVICE_ORDER = [
  'Авито',
  'Яндекс Доставка',
  'Почта России',
  'DPD',
  'СДЭК',
  '5Post'
];

loadLastResults();
listenStorageChanges();

collectBtn.addEventListener('click', async () => {
  setStatus('Собираю заказы...', 'loading');
  resultsEl.innerHTML = '';
  collectBtn.disabled = true;
  resetBtn.disabled = true;

  try {
    await cancelAvitoResolveJob();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url || !tab.url.includes('avito.ru/orders')) {
      throw new Error('Откройте страницу заказов Авито');
    }

    const response = await sendMessageToTab(tab.id, { action: 'collectOrders' });
    const orders = (response && response.orders) ? response.orders : [];

    if (!orders.length) {
      setStatus('Не найдено заказов со статусом «Отправьте заказ».', 'error');
      return;
    }

    renderOrders(orders);
    await saveLastResults(orders);

    const jobStatus = await startAvitoResolveJob();
    if (jobStatus.status === 'running') {
      setStatus(
        `Получаю номера отправлений: ${jobStatus.done}/${jobStatus.total}. Можно закрыть попап.`,
        'loading'
      );
    } else if (jobStatus.status === 'cancelled') {
      setStatus('Сбор был остановлен. Нажмите «Собрать этикетки» снова.', 'error');
    } else {
      setStatus(`Готово! Собрано заказов: ${orders.length}.`, 'success');
    }
  } catch (err) {
    setStatus(`Ошибка: ${err.message}`, 'error');
  } finally {
    collectBtn.disabled = false;
    resetBtn.disabled = false;
  }
});

resetBtn.addEventListener('click', async () => {
  collectBtn.disabled = true;
  resetBtn.disabled = true;
  try {
    await cancelAvitoResolveJob();
    await clearLastResults();
    resultsEl.innerHTML = '';
    setStatus('Результаты сброшены.', 'success');
  } finally {
    collectBtn.disabled = false;
    resetBtn.disabled = false;
  }
});

printBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('print.html') });
});

function renderOrders(orders) {
  resultsEl.innerHTML = '';
  const sortedOrders = sortOrdersByService(orders);

  sortedOrders.forEach((order, index) => {
    const card = document.createElement('div');
    card.className = 'order-card';

    const productName = order.productName || 'Без названия';
    const service = order.service || 'Не определено';
    const tracking = cleanTracking(order.trackingNumber || '');
    const isFivePost = service === '5Post';
    const isKnownService = isKnownDeliveryService(service);
    const unknownServiceNote = isKnownService
      ? ''
      : '<div class="order-info muted">Доставка пока не реализована в расширении.</div>';

    card.innerHTML = `
      <div class="order-title">${index + 1}. ${escapeHtml(productName)}</div>
      <div class="order-info"><strong>Доставка:</strong> ${escapeHtml(service)}</div>
      <div class="order-info"><strong>Номер отправления:</strong> ${tracking ? escapeHtml(tracking) : '<span class="muted">Не найден</span>'}</div>
      ${unknownServiceNote}
    `;

    const barcodeWrap = document.createElement('div');
    barcodeWrap.className = 'barcode-wrap';

    if (isFivePost) {
      if (tracking) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const ok = window.LocalQrCode && window.LocalQrCode.renderSvg
          ? window.LocalQrCode.renderSvg(svg, tracking, { moduleSize: 5, quiet: 4 })
          : false;

        if (ok) {
          barcodeWrap.appendChild(svg);
        } else {
          barcodeWrap.innerHTML = '<div class="muted">Не удалось построить QR-код</div>';
        }
      } else {
        barcodeWrap.innerHTML = '<div class="muted">Код 5Post не найден на странице заказа</div>';
      }
    } else if (!isKnownService) {
      const serviceLabel = escapeHtml(service || 'Неизвестная служба');
      barcodeWrap.innerHTML = `<div class="muted">Маркировка для «${serviceLabel}» пока не реализована</div>`;
    } else if (tracking) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const ok = window.Code128Barcode && window.Code128Barcode.renderSvg
        ? window.Code128Barcode.renderSvg(svg, tracking, { width: 2.6, height: 72, quiet: 14 })
        : false;

      if (ok) {
        barcodeWrap.appendChild(svg);
      } else {
        barcodeWrap.innerHTML = '<div class="muted">Не удалось построить штрих-код</div>';
      }
    } else {
      barcodeWrap.innerHTML = isKnownService
        ? '<div class="muted">Нет номера для кода</div>'
        : '<div class="muted">Доставка пока не реализована</div>';
    }

    card.appendChild(barcodeWrap);
    resultsEl.appendChild(card);
  });
}

function sortOrdersByService(orders) {
  const rank = new Map(DELIVERY_SERVICE_ORDER.map((name, index) => [name, index]));

  return orders
    .map((order, index) => ({ order, index }))
    .sort((a, b) => {
      const serviceA = normalizeServiceName(a.order.service);
      const serviceB = normalizeServiceName(b.order.service);
      const rankA = rank.has(serviceA) ? rank.get(serviceA) : Number.MAX_SAFE_INTEGER;
      const rankB = rank.has(serviceB) ? rank.get(serviceB) : Number.MAX_SAFE_INTEGER;

      if (rankA !== rankB) return rankA - rankB;

      if (rankA === Number.MAX_SAFE_INTEGER) {
        const compareService = serviceA.localeCompare(serviceB, 'ru');
        if (compareService !== 0) return compareService;
      }

      return a.index - b.index;
    })
    .map((item) => item.order);
}

function normalizeServiceName(value) {
  return (value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isKnownDeliveryService(service) {
  return DELIVERY_SERVICE_ORDER.includes(normalizeServiceName(service));
}

async function loadLastResults() {
  chrome.storage.local.get([STORAGE_KEY_RESULTS, STORAGE_KEY_RUN, STORAGE_KEY_JOB], (data) => {
    const results = data[STORAGE_KEY_RESULTS];
    const lastRun = data[STORAGE_KEY_RUN];
    const jobStatus = data[STORAGE_KEY_JOB];
    if (Array.isArray(results) && results.length) {
      renderOrders(results);
      if (lastRun) {
        lastRunEl.textContent = `Последний сбор: ${formatDate(lastRun)}`;
      }
    } else {
      lastRunEl.textContent = '';
    }

    if (jobStatus && jobStatus.status === 'running') {
      setStatus(
        `Получаю номера отправлений: ${jobStatus.done}/${jobStatus.total}. Можно закрыть попап.`,
        'loading'
      );
    }
  });
}

async function saveLastResults(orders) {
  const now = new Date().toISOString();
  return new Promise((resolve) => {
    chrome.storage.local.set(
      {
        [STORAGE_KEY_RESULTS]: orders,
        [STORAGE_KEY_RUN]: now
      },
      () => {
        lastRunEl.textContent = `Последний сбор: ${formatDate(now)}`;
        resolve();
      }
    );
  });
}

async function clearLastResults() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([STORAGE_KEY_RESULTS, STORAGE_KEY_RUN, STORAGE_KEY_JOB], () => {
      lastRunEl.textContent = '';
      resolve();
    });
  });
}

function cancelAvitoResolveJob() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'cancelAvitoResolve' }, () => {
      chrome.runtime.lastError;
      resolve();
    });
  });
}

function startAvitoResolveJob() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'startAvitoResolve' },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(response || { status: 'error' });
      }
    );
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, async (response) => {
      const err = chrome.runtime.lastError;
      if (!err) {
        resolve(response);
        return;
      }

      const errorText = err.message || '';
      if (!errorText.includes('Receiving end does not exist')) {
        reject(new Error(errorText));
        return;
      }

      try {
        await ensureContentScriptInjected(tabId);
        chrome.tabs.sendMessage(tabId, message, (retryResponse) => {
          const retryErr = chrome.runtime.lastError;
          if (retryErr) {
            reject(new Error(retryErr.message));
            return;
          }
          resolve(retryResponse);
        });
      } catch (injectErr) {
        reject(injectErr);
      }
    });
  });
}

function ensureContentScriptInjected(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ['content.js']
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve();
      }
    );
  });
}

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = type ? type : '';
}

function cleanTracking(text) {
  return text
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, '')
    .replace(/[^0-9A-Za-z]/g, '')
    .toUpperCase();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function formatDate(value) {
  try {
    const date = new Date(value);
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  } catch (e) {
    return value;
  }
}

function listenStorageChanges() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes[STORAGE_KEY_RESULTS]) {
      const updated = changes[STORAGE_KEY_RESULTS].newValue;
      if (Array.isArray(updated)) {
        renderOrders(updated);
      }
    }

    if (changes[STORAGE_KEY_RUN]) {
      const lastRun = changes[STORAGE_KEY_RUN].newValue;
      if (lastRun) {
        lastRunEl.textContent = `Последний сбор: ${formatDate(lastRun)}`;
      }
    }

    if (changes[STORAGE_KEY_JOB]) {
      const job = changes[STORAGE_KEY_JOB].newValue;
      if (job && job.status === 'running') {
        setStatus(
          `Получаю номера отправлений: ${job.done}/${job.total}. Можно закрыть попап.`,
          'loading'
        );
      } else if (job && job.status === 'cancelled') {
        setStatus('Сбор остановлен. Можно запустить заново.', 'success');
      } else if (job && job.status === 'done') {
        setStatus('Готово! Номера отправлений обработаны.', 'success');
      }
    }
  });
}
