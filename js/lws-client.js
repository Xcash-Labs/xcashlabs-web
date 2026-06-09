// SPDX-License-Identifier: MIT
/**
 * lws-client.js — Browser client for XCash Klassic LWS
 *
 * Talks to the XCash Klassic light-wallet server used by the web wallet.
 *
 * Trust model:
 *   • Server sees: address, private view key, signed tx hex
 *   • Server never sees: spend key, seed phrase, mnemonic
 */

const LwsClient = (function () {
  'use strict';

  // Caddy should reverse proxy /lws/* to xcashklassic-lws.
  let BASE_URL = 'https://lws.xcashlabs.org';

  let MOCK = false;

  function detectMockDefault() {
    try {
      const flag = localStorage.getItem('lws-mock');
      if (flag === '1') return true;
      if (flag === '0') return false;
    } catch (e) {}

    if (typeof location === 'undefined') return false;

    return location.hostname === 'localhost' ||
           location.hostname === '127.0.0.1' ||
           location.hostname === '';
  }

  MOCK = detectMockDefault();

  function setBaseUrl(url) {
    BASE_URL = url.replace(/\/$/, '');
  }

  function setMockMode(on) {
    MOCK = !!on;
  }

  function isMock() {
    return MOCK;
  }

  async function post(path, body) {
    if (MOCK) return mockResponse(path, body);

    const url = BASE_URL + path;

    let response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new LwsError(
        'network',
        'Could not reach light-wallet server: ' + e.message,
        e
      );
    }

    let data;

    try {
      data = await response.json();
    } catch (e) {
      if (!response.ok) {
        throw new LwsError(
          'server',
          'Server error (HTTP ' + response.status + ')',
          e,
          response.status
        );
      }

      throw new LwsError(
        'decode',
        'Light-wallet server returned invalid JSON',
        e
      );
    }

    if (!response.ok) {
      throw new LwsError(
        'server',
        data && data.error ? data.error : 'HTTP ' + response.status,
        null,
        response.status
      );
    }

    return data;
  }

  async function login(address, viewKey, opts) {
    opts = opts || {};

    const body = {
      address,
      view_key: viewKey,
      create_account: true,
      generated_locally: !!opts.generatedLocally,
    };

    if (!opts.generatedLocally && typeof opts.createdAt === 'number' && opts.createdAt > 0) {
      body.start_height = opts.createdAt;
    } else if (!opts.generatedLocally) {
      body.start_height = 0;
    }

    return post('/login', body);
  }

  async function importWalletRequest(address, viewKey, fromHeight) {
    const body = {
      address,
      view_key: viewKey,
    };

    if (typeof fromHeight === 'number' && fromHeight > 0) {
      body.from_height = fromHeight;
    }

    return post('/import_wallet_request', body);
  }

  async function getAddressInfo(address, viewKey) {
    return post('/get_address_info', {
      address,
      view_key: viewKey,
    });
  }

  async function getAddressTxs(address, viewKey) {
    return post('/get_address_txs', {
      address,
      view_key: viewKey,
    });
  }

  async function getUnspentOuts(address, viewKey, amount, mixin, useDust) {
    return post('/get_unspent_outs', {
      address,
      view_key: viewKey,
      amount: String(amount || '0'),
      mixin: typeof mixin === 'number' ? mixin : 15,
      use_dust: !!useDust,
      dust_threshold: '2000',
    });
  }

  async function getRandomOuts(amounts, count) {
    return post('/get_random_outs', {
      amounts: amounts || ['0'],
      count: count || 16,
    });
  }

  async function submitRawTx(txHex) {
    return post('/submit_raw_tx', {
      tx: txHex,
    });
  }

  function availableBalance(info) {
    if (!info) return 0n;

    const total = BigInt(info.total_received || '0');
    const spent = BigInt(info.total_sent || '0');
    const locked = BigInt(info.locked_funds || '0');

    const avail = total - spent - locked;
    return avail < 0n ? 0n : avail;
  }

  function scanProgress(info) {
    if (!info) return 0;

    const start = info.start_height || 0;
    const cur = info.scanned_block_height || info.scanned_height || 0;
    const tip = info.blockchain_height || 0;

    if (tip <= start) return 1;
    if (cur >= tip) return 1;
    if (tip - cur <= 3) return 1;

    return Math.max(0, Math.min(1, (cur - start) / (tip - start)));
  }

  function formatXmr(atomic) {
    let n;

    if (typeof atomic === 'bigint') {
      n = atomic;
    } else if (typeof atomic === 'string') {
      n = BigInt(atomic);
    } else {
      n = BigInt(Math.round(Number(atomic) || 0));
    }

    const sign = n < 0n ? '-' : '';
    if (n < 0n) n = -n;

    const whole = n / 1000000n;
    const frac = n % 1000000n;

    if (frac === 0n) return sign + whole.toString();

    let fracStr = frac.toString().padStart(6, '0');
    fracStr = fracStr.replace(/0+$/, '');

    return sign + whole.toString() + '.' + fracStr;
  }

  async function pingLogin(address) {
    return true;
  }

  function LwsError(kind, message, cause, statusCode) {
    const err = new Error(message);
    err.name = 'LwsError';
    err.kind = kind;
    err.cause = cause || null;
    err.statusCode = statusCode || 0;
    return err;
  }

  const _mockBirthMs = Date.now();

  function mockResponse(path, body) {
    return new Promise(resolve => {
      setTimeout(() => {
        resolve(handleMock(path, body));
      }, 80 + Math.random() * 120);
    });
  }

  function handleMock(path, body) {
    const tip = 3650000;
    const elapsed = (Date.now() - _mockBirthMs) / 1000;
    const startHeight = tip - 1000;
    const scanned = Math.min(tip, Math.floor(startHeight + elapsed * 50));

    if (path === '/login') {
      return {
        new_address: true,
        generated_locally: !!body.generated_locally,
        start_height: startHeight,
      };
    }

    if (path === '/get_address_info') {
      return {
        locked_funds: '0',
        total_received: '1234567',
        total_sent: '0',
        scanned_height: scanned,
        scanned_block_height: scanned,
        start_height: startHeight,
        transaction_height: scanned,
        blockchain_height: tip,
        spent_outputs: [],
        rates: {},
      };
    }

    if (path === '/get_address_txs') {
      return {
        total_received: '1234567',
        scanned_height: scanned,
        blockchain_height: tip,
        transactions: [],
      };
    }

    if (path === '/get_unspent_outs') {
      return {
        per_kb_fee: '24658',
        fee_mask: '10000',
        amount: '1234567',
        outputs: [],
      };
    }

    if (path === '/get_random_outs') {
      return {
        amount_outs: [
          {
            amount: '0',
            outputs: [],
          },
        ],
      };
    }

    if (path === '/submit_raw_tx') {
      return {
        status: 'OK',
      };
    }

    return {
      error: 'mock: unknown path ' + path,
    };
  }

  return {
    login,
    importWalletRequest,
    getAddressInfo,
    getAddressTxs,
    getUnspentOuts,
    getRandomOuts,
    submitRawTx,
    availableBalance,
    scanProgress,
    formatXmr,
    pingLogin,
    setBaseUrl,
    setMockMode,
    isMock,
    LwsError,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LwsClient;
}
