const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./helpers/load-script');

const BACKGROUND_PATH = path.resolve(__dirname, '..', 'background.js');

function createChromeMock() {
  const storageState = {};
  const badgeState = {
    text: '',
    backgroundColor: null,
    textColor: null
  };

  return {
    runtime: {
      lastError: null,
      onMessage: {
        addListener: () => {}
      },
      onInstalled: {
        addListener: () => {}
      },
      onStartup: {
        addListener: () => {}
      }
    },
    storage: {
      local: {
        get: (keys, callback) => {
          if (Array.isArray(keys)) {
            const out = {};
            for (const key of keys) out[key] = storageState[key];
            callback(out);
            return;
          }

          callback({ ...storageState });
        },
        set: (data, callback) => {
          Object.assign(storageState, data);
          if (callback) callback();
        },
        remove: (keys, callback) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) delete storageState[key];
          if (callback) callback();
        }
      },
      onChanged: {
        addListener: () => {}
      }
    },
    windows: {
      create: (_options, callback) => callback({ id: 100 }),
      update: (_windowId, _options, callback) => callback(),
      remove: (_windowId, callback) => callback()
    },
    tabs: {
      create: (_options, callback) => callback({ id: 200 }),
      remove: (_tabId, callback) => callback()
    },
    action: {
      setBadgeText: ({ text }, callback) => {
        badgeState.text = text;
        if (callback) callback();
      },
      setBadgeBackgroundColor: ({ color }, callback) => {
        badgeState.backgroundColor = color;
        if (callback) callback();
      },
      setBadgeTextColor: ({ color }, callback) => {
        badgeState.textColor = color;
        if (callback) callback();
      }
    },
    scripting: {
      executeScript: (_options, callback) => callback([])
    },
    __badgeState: badgeState
  };
}

function loadBackground() {
  const chrome = createChromeMock();
  const loaded = loadScript(BACKGROUND_PATH, {
    globals: {
      chrome,
      fetch: async () => ({ ok: false, text: async () => '' }),
      Date,
      Math,
      Promise,
      setTimeout
    },
    exportNames: [
      'shouldResolveTracking',
      'extractTrackingFromText',
      'htmlToText',
      'cleanDigits',
      'isValidAvitoTracking',
      'isValidFivePostTracking',
      'formatBadgeCount',
      'updateBadgeFromOrders'
    ]
  });

  return {
    exports: loaded.exports,
    chrome
  };
}

test('shouldResolveTracking корректно решает, когда добирать номер', () => {
  const { exports: bg } = loadBackground();

  assert.equal(bg.shouldResolveTracking(null), false);
  assert.equal(bg.shouldResolveTracking({ orderUrl: '', service: '5Post' }), false);
  assert.equal(bg.shouldResolveTracking({ orderUrl: 'https://www.avito.ru/orders/1', service: '5Post' }), true);

  assert.equal(
    bg.shouldResolveTracking({
      orderUrl: 'https://www.avito.ru/orders/2',
      service: 'Авито',
      trackingNumber: '123 456 789'
    }),
    false
  );

  assert.equal(
    bg.shouldResolveTracking({
      orderUrl: 'https://www.avito.ru/orders/3',
      service: 'Авито',
      trackingNumber: '12'
    }),
    true
  );
});

test('extractTrackingFromText извлекает номер Авито и 5Post', () => {
  const { exports: bg } = loadBackground();

  const avitoText = 'Инструкция: Назовите этот номер 123 456 789 оператору';
  const fivePostText = 'Код получения 77 88 99 00 Посмотреть постамат рядом';

  assert.equal(bg.extractTrackingFromText(avitoText, 'Авито'), '123456789');
  assert.equal(bg.extractTrackingFromText(fivePostText, '5Post'), '77889900');
  assert.equal(bg.extractTrackingFromText(`${avitoText} ${fivePostText}`, ''), '123456789');
});

test('htmlToText вырезает script/style и схлопывает пробелы', () => {
  const { exports: bg } = loadBackground();
  const html = `
    <html>
      <head>
        <style>.a { color: red; }</style>
      </head>
      <body>
        Текст <script>alert(1)</script> номер&nbsp;123
      </body>
    </html>
  `;

  const result = bg.htmlToText(html);
  assert.equal(result.includes('alert(1)'), false);
  assert.equal(result.includes('color: red'), false);
  assert.equal(result, 'Текст номер 123');
});

test('валидация и очистка цифр работает ожидаемо', () => {
  const { exports: bg } = loadBackground();

  assert.equal(bg.cleanDigits(' 12 3-45 '), '12345');
  assert.equal(bg.isValidAvitoTracking('123456'), true);
  assert.equal(bg.isValidAvitoTracking('12345'), false);
  assert.equal(bg.isValidFivePostTracking('123456789012'), true);
  assert.equal(bg.isValidFivePostTracking('1234567890123'), false);
});

test('formatBadgeCount корректно форматирует счетчик для иконки', () => {
  const { exports: bg } = loadBackground();

  assert.equal(bg.formatBadgeCount(0), '');
  assert.equal(bg.formatBadgeCount(7), '7');
  assert.equal(bg.formatBadgeCount(999), '999');
  assert.equal(bg.formatBadgeCount(1000), '999+');
});

test('updateBadgeFromOrders выставляет badge по количеству заказов', async () => {
  const { exports: bg, chrome } = loadBackground();
  await new Promise((resolve) => setTimeout(resolve, 0));

  await bg.updateBadgeFromOrders([{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(chrome.__badgeState.text, '3');

  await bg.updateBadgeFromOrders([]);
  assert.equal(chrome.__badgeState.text, '');
});
