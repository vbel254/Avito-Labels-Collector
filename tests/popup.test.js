const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScript } = require('./helpers/load-script');

const POPUP_PATH = path.resolve(__dirname, '..', 'popup.js');

function createElementStub() {
  return {
    textContent: '',
    innerHTML: '',
    className: '',
    disabled: false,
    appendChild: () => {},
    addEventListener: () => {}
  };
}

function createPopupEnv(overrides = {}) {
  const elements = {
    collectBtn: createElementStub(),
    resetBtn: createElementStub(),
    printBtn: createElementStub(),
    status: createElementStub(),
    results: createElementStub(),
    lastRun: createElementStub()
  };

  let removedKeys = [];
  let sendMessageCall = 0;
  let executeScriptCall = 0;

  const chrome = {
    runtime: {
      lastError: null,
      getURL: (url) => `chrome-extension://test/${url}`,
      sendMessage: (_payload, callback) => {
        chrome.runtime.lastError = null;
        callback({});
      }
    },
    tabs: {
      query: (_query, callback) => callback([]),
      create: () => {},
      sendMessage: (_tabId, _message, callback) => {
        sendMessageCall += 1;
        if (overrides.onTabMessage) {
          overrides.onTabMessage({ chrome, sendMessageCall, callback });
          return;
        }
        chrome.runtime.lastError = null;
        callback({ ok: true });
      }
    },
    scripting: {
      executeScript: (_options, callback) => {
        executeScriptCall += 1;
        if (overrides.onExecuteScript) {
          overrides.onExecuteScript({ chrome, executeScriptCall, callback });
          return;
        }
        chrome.runtime.lastError = null;
        callback();
      }
    },
    storage: {
      local: {
        get: (_keys, callback) => callback({}),
        set: (_data, callback) => callback(),
        remove: (keys, callback) => {
          removedKeys = Array.isArray(keys) ? [...keys] : [keys];
          callback();
        }
      },
      onChanged: {
        addListener: () => {}
      }
    }
  };

  const document = {
    getElementById: (id) => elements[id],
    createElement: () => createElementStub(),
    createElementNS: () => createElementStub()
  };

  const loaded = loadScript(POPUP_PATH, {
    globals: {
      chrome,
      document,
      window: {},
      Intl,
      Date,
      Promise
    },
    exportNames: ['sendMessageToTab', 'clearLastResults', 'cancelAvitoResolveJob']
  });

  return {
    ...loaded,
    chrome,
    elements,
    getRemovedKeys: () => removedKeys,
    getSendMessageCallCount: () => sendMessageCall,
    getExecuteScriptCallCount: () => executeScriptCall
  };
}

test('sendMessageToTab делает реинжект content.js и ретрай при отсутствующем receiving end', async () => {
  const env = createPopupEnv({
    onTabMessage: ({ chrome, sendMessageCall, callback }) => {
      if (sendMessageCall === 1) {
        chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
        callback(undefined);
        return;
      }
      chrome.runtime.lastError = null;
      callback({ orders: [{ id: 1 }] });
    }
  });

  const response = await env.exports.sendMessageToTab(10, { action: 'collectOrders' });

  assert.deepEqual(response, { orders: [{ id: 1 }] });
  assert.equal(env.getSendMessageCallCount(), 2);
  assert.equal(env.getExecuteScriptCallCount(), 1);
});

test('sendMessageToTab возвращает ошибку, если это не receiving end', async () => {
  const env = createPopupEnv({
    onTabMessage: ({ chrome, callback }) => {
      chrome.runtime.lastError = { message: 'No tab with id: 123' };
      callback(undefined);
    }
  });

  await assert.rejects(
    () => env.exports.sendMessageToTab(123, { action: 'collectOrders' }),
    /No tab with id: 123/
  );
  assert.equal(env.getExecuteScriptCallCount(), 0);
});

test('clearLastResults очищает все ключи, включая статус фоновой задачи', async () => {
  const env = createPopupEnv();

  await env.exports.clearLastResults();

  const removed = env.getRemovedKeys();
  assert.equal(removed.includes('avitoLabels:lastResults'), true);
  assert.equal(removed.includes('avitoLabels:lastRun'), true);
  assert.equal(removed.includes('avitoLabels:jobStatus'), true);
});

test('cancelAvitoResolveJob не падает при runtime.lastError', async () => {
  const env = createPopupEnv();
  env.chrome.runtime.sendMessage = (_payload, callback) => {
    env.chrome.runtime.lastError = { message: 'Receiving end does not exist.' };
    callback(undefined);
  };

  await assert.doesNotReject(() => env.exports.cancelAvitoResolveJob());
});
