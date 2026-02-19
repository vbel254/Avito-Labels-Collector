const STATUS_TARGET = 'Отправьте заказ';
const KNOWN_SERVICES = [
  'Почта России',
  'Яндекс Доставка',
  'DPD',
  'СДЭК',
  '5Post',
  'Авито'
];

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'collectOrders') {
    const orders = collectOrdersFromPage();
    sendResponse({ orders });
  }
  return true;
});

function collectOrdersFromPage() {
  const rows = document.querySelectorAll('[data-marker="order-row"]');
  const orders = [];

  rows.forEach((row) => {
    const statusEl = row.querySelector('[data-marker="order-status"]');
    const statusText = normalizeText(statusEl ? statusEl.textContent : '');
    if (statusText !== STATUS_TARGET) return;

    const productName = normalizeText(
      row.querySelector('img[alt]')?.getAttribute('alt') || ''
    );

    const orderUrl = absoluteUrl(
      row.querySelector('a[href*="/orders/"]')?.getAttribute('href') || ''
    );

    const rowTracking = extractTrackingFromRow(row);
    const service = extractServiceFromRow(row, statusText, rowTracking);
    const trackingNumber = service === '5Post' ? '' : rowTracking;

    orders.push({
      service,
      productName,
      trackingNumber,
      orderUrl
    });
  });

  return orders;
}

function extractTrackingFromRow(row) {
  const buttonTexts = Array.from(row.querySelectorAll('div[role="button"] p'))
    .map((el) => normalizeText(el.textContent))
    .filter(Boolean);

  const buttonCandidate = buttonTexts.find(looksLikeTracking);
  if (buttonCandidate) return cleanTracking(buttonCandidate);

  const allPTexts = Array.from(row.querySelectorAll('p'))
    .map((el) => normalizeText(el.textContent))
    .filter(Boolean);

  const fallbackCandidate = allPTexts.find(looksLikeTracking);
  if (fallbackCandidate) return cleanTracking(fallbackCandidate);

  return '';
}

function extractServiceFromRow(row, statusText, trackingNumber) {
  const rowText = normalizeText(row.innerText);
  const matched = KNOWN_SERVICES.find((name) => rowText.includes(name));
  if (matched) return matched;

  const pTexts = Array.from(row.querySelectorAll('p'))
    .map((el) => normalizeText(el.textContent))
    .filter(Boolean);

  const candidate = pTexts.find((text) => {
    if (!text) return false;
    if (text === statusText) return false;
    if (trackingNumber && text.replace(/\s+/g, '') === trackingNumber) return false;
    if (isPrice(text)) return false;
    if (looksLikeDate(text)) return false;
    return true;
  });

  return candidate || '';
}

function looksLikeTracking(text) {
  const clean = normalizeText(text);
  if (!clean) return false;
  if (clean.includes('₽')) return false;
  if (looksLikeDate(clean)) return false;

  const compact = clean.replace(/\s+/g, '').replace(/[^0-9A-Za-z]/g, '');
  if (compact.length < 6) return false;
  return /[0-9]/.test(compact);
}

function isPrice(text) {
  return text.includes('₽') || /^\d+\s*₽/.test(text);
}

function looksLikeDate(text) {
  const lowered = text.toLowerCase();
  const months = [
    'январ',
    'феврал',
    'март',
    'апрел',
    'мая',
    'июн',
    'июл',
    'август',
    'сентябр',
    'октябр',
    'ноябр',
    'декабр'
  ];
  return months.some((m) => lowered.includes(m));
}

function normalizeText(text) {
  return text
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTracking(text) {
  return normalizeText(text)
    .replace(/\s+/g, '')
    .replace(/[^0-9A-Za-z]/g, '')
    .toUpperCase();
}

function absoluteUrl(href) {
  if (!href) return '';
  try {
    return new URL(href, window.location.origin).toString();
  } catch (e) {
    return href;
  }
}
