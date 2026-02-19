const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./helpers/load-script');

const CONTENT_PATH = path.resolve(__dirname, '..', 'content.js');

function textElement(text) {
  return {
    textContent: text
  };
}

function attrElement(attrs) {
  return {
    getAttribute: (name) => attrs[name] || null
  };
}

function createRow(data) {
  const pNodes = (data.pTexts || []).map((value) => textElement(value));
  const buttonNodes = (data.buttonTexts || []).map((value) => textElement(value));

  return {
    innerText: data.innerText || '',
    querySelector: (selector) => {
      if (selector === '[data-marker="order-status"]') {
        return textElement(data.status || '');
      }
      if (selector === 'img[alt]') {
        return attrElement({ alt: data.productName || '' });
      }
      if (selector === 'a[href*="/orders/"]') {
        return attrElement({ href: data.orderHref || '' });
      }
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector === 'div[role="button"] p') return buttonNodes;
      if (selector === 'p') return pNodes;
      return [];
    }
  };
}

function loadContent(rows = []) {
  const chrome = {
    runtime: {
      onMessage: {
        addListener: () => {}
      }
    }
  };

  const document = {
    querySelectorAll: (selector) => {
      if (selector === '[data-marker="order-row"]') return rows;
      return [];
    }
  };

  return loadScript(CONTENT_PATH, {
    globals: {
      chrome,
      document,
      window: {
        location: { origin: 'https://www.avito.ru' }
      },
      URL
    },
    exportNames: [
      'collectOrdersFromPage',
      'looksLikeTracking',
      'cleanTracking',
      'normalizeText'
    ]
  }).exports;
}

test('collectOrdersFromPage собирает только заказы со статусом "Отправьте заказ"', () => {
  const rows = [
    createRow({
      status: 'Отправьте заказ',
      productName: 'Товар 1',
      orderHref: '/orders/abc123',
      buttonTexts: ['123 456 789'],
      pTexts: ['Отправьте заказ', 'Авито', '123 456 789'],
      innerText: 'Авито Отправьте заказ'
    }),
    createRow({
      status: 'Получен',
      productName: 'Товар 2',
      orderHref: '/orders/ignore',
      buttonTexts: ['999 111'],
      pTexts: ['Получен'],
      innerText: 'Авито Получен'
    })
  ];

  const content = loadContent(rows);
  const orders = content.collectOrdersFromPage();
  const firstOrder = JSON.parse(JSON.stringify(orders[0]));

  assert.equal(orders.length, 1);
  assert.deepEqual(firstOrder, {
    service: 'Авито',
    productName: 'Товар 1',
    trackingNumber: '123456789',
    orderUrl: 'https://www.avito.ru/orders/abc123'
  });
});

test('для 5Post tracking из строки не сохраняется, чтобы добирать из карточки заказа', () => {
  const rows = [
    createRow({
      status: 'Отправьте заказ',
      productName: 'Товар 5Post',
      orderHref: '/orders/fivepost',
      buttonTexts: ['777 888 999'],
      pTexts: ['Отправьте заказ', '5Post', '777 888 999'],
      innerText: '5Post Отправьте заказ'
    })
  ];

  const content = loadContent(rows);
  const orders = content.collectOrdersFromPage();

  assert.equal(orders.length, 1);
  assert.equal(orders[0].service, '5Post');
  assert.equal(orders[0].trackingNumber, '');
});

test('looksLikeTracking отсекает цены и даты, но принимает похожий номер', () => {
  const content = loadContent([]);

  assert.equal(content.looksLikeTracking('1 990 ₽'), false);
  assert.equal(content.looksLikeTracking('12 февраля'), false);
  assert.equal(content.looksLikeTracking('A1B2C3D4'), true);
  assert.equal(content.cleanTracking(' ab-12 34 '), 'AB1234');
  assert.equal(content.normalizeText('  а\u00A0б   в  '), 'а б в');
});
