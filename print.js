const STORAGE_KEY_RESULTS = 'avitoLabels:lastResults';
const STORAGE_KEY_RUN = 'avitoLabels:lastRun';
const DELIVERY_SERVICE_ORDER = [
  'Авито',
  'Яндекс Доставка',
  'Почта России',
  'DPD',
  'СДЭК',
  '5Post'
];

const resultsEl = document.getElementById('results');
const printBtn = document.getElementById('printBtn');
const refreshBtn = document.getElementById('refreshBtn');
const metaEl = document.getElementById('meta');

printBtn.addEventListener('click', () => {
  preparePrintLayout();
  window.print();
});

refreshBtn.addEventListener('click', () => {
  loadResults();
});

loadResults();

function loadResults() {
  chrome.storage.local.get([STORAGE_KEY_RESULTS, STORAGE_KEY_RUN], (data) => {
    const results = data[STORAGE_KEY_RESULTS];
    const lastRun = data[STORAGE_KEY_RUN];
    if (lastRun) {
      metaEl.textContent = `Последний сбор: ${formatDate(lastRun)}`;
    } else {
      metaEl.textContent = '';
    }

    if (!Array.isArray(results) || !results.length) {
      resultsEl.innerHTML = '<div class="muted">Нет данных для печати.</div>';
      return;
    }

    renderOrders(results);
  });
}

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
          ? window.LocalQrCode.renderSvg(svg, tracking, { moduleSize: 7, quiet: 4 })
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
        ? window.Code128Barcode.renderSvg(svg, tracking, { width: 3, height: 84, quiet: 16 })
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

function preparePrintLayout() {
  const container = document.querySelector('.container');
  if (!container) return;

  const width = Math.ceil(container.getBoundingClientRect().width);
  const height = Math.ceil(container.scrollHeight);

  let style = document.getElementById('dynamicPageSize');
  if (!style) {
    style = document.createElement('style');
    style.id = 'dynamicPageSize';
    document.head.appendChild(style);
  }

  style.textContent = `
    @page { size: ${width}px ${height}px; margin: 0; }
    @media print {
      html, body { width: ${width}px; }
    }
  `;
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
