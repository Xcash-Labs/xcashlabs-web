// SPDX-License-Identifier: MIT
/**
 * xcash-rpc.js
 * XCash Klassic daemon RPC client
 */

const MoneroRPC = (function () {
  'use strict';

  const PROXY_URL = '/rpc';
  const CUSTOM_NODE_KEY = 'xcashklassic-node-url';

  let currentNode = null;
  let connectionListeners = [];

  function getCustomNode() {
    try { return localStorage.getItem(CUSTOM_NODE_KEY) || ''; } catch (e) { return ''; }
  }

  function setCustomNode(url) {
    try {
      if (url) localStorage.setItem(CUSTOM_NODE_KEY, url.replace(/\/$/, ''));
      else localStorage.removeItem(CUSTOM_NODE_KEY);
    } catch (e) {}
    currentNode = null;
  }

  function onConnectionChange(fn) {
    connectionListeners.push(fn);
  }

  function notifyListeners(state) {
    connectionListeners.forEach(fn => {
      try { fn(state); } catch (e) { console.error('[rpc] listener error:', e); }
    });
  }

  async function jsonRpc(method, params) {
    const custom = getCustomNode();
    const url = custom ? custom + '/json_rpc' : PROXY_URL + '/json_rpc';

    const body = {
      jsonrpc: '2.0',
      id: '0',
      method
    };

    if (params) body.params = params;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`RPC HTTP error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`RPC error: ${data.error.message || JSON.stringify(data.error)}`);
      }

      return data.result;
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') throw new Error('Request timed out');
      throw e;
    }
  }

  async function rpcOther(path, params) {
    const custom = getCustomNode();
    const url = custom ? custom + path : PROXY_URL + path;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`RPC HTTP error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') throw new Error('Request timed out');
      throw e;
    }
  }

  async function connect() {
    notifyListeners({ status: 'connecting', message: 'Connecting to XCash Klassic network...' });

    try {
      const start = Date.now();
      const info = await jsonRpc('get_info');
      const latency = Date.now() - start;

      currentNode = {
        name: 'XCash Klassic RPC',
        url: PROXY_URL,
        ok: true,
        latency,
        height: info.height,
        version: info.version,
        synced: !info.busy_syncing,
        txPoolSize: info.tx_pool_size,
        difficulty: info.difficulty,
        txCount: info.tx_count
      };

      notifyListeners({
        status: 'connected',
        node: currentNode.name,
        url: currentNode.url,
        height: currentNode.height,
        latency: currentNode.latency,
        version: currentNode.version
      });

      return currentNode;
    } catch (e) {
      currentNode = null;
      notifyListeners({ status: 'disconnected', message: 'No nodes reachable: ' + e.message });
      throw new Error('Could not connect to XCash Klassic network: ' + e.message);
    }
  }

  async function getInfo() {
    return jsonRpc('get_info');
  }

  async function getHeight() {
    const result = await jsonRpc('get_block_count');
    return result.count;
  }

  async function getFeeEstimate() {
    const result = await jsonRpc('get_fee_estimate');
    return {
      feePerByte: result.fee,
      quantizationMask: result.quantization_mask
    };
  }

  async function getOuts(outputs) {
    return rpcOther('/get_outs', {
      outputs,
      get_txid: true
    });
  }

  async function getTransactions(txHashes) {
    return rpcOther('/get_transactions', {
      txs_hashes: txHashes,
      decode_as_json: true
    });
  }

  async function sendRawTransaction(txHex) {
    const result = await rpcOther('/send_raw_transaction', {
      tx_as_hex: txHex,
      do_not_relay: false
    });

    if (result.status !== 'OK') {
      throw new Error(`Broadcast failed: ${result.reason || result.status}`);
    }

    return result;
  }

  function getConnectionState() {
    if (!currentNode) return { status: 'disconnected' };

    return {
      status: 'connected',
      node: currentNode.name,
      url: currentNode.url,
      height: currentNode.height
    };
  }

  function disconnect() {
    currentNode = null;
    notifyListeners({ status: 'disconnected', message: 'Disconnected' });
  }

  function formatXMR(atomicUnits) {
    if (typeof atomicUnits === 'string') atomicUnits = BigInt(atomicUnits);
    if (typeof atomicUnits === 'number') atomicUnits = BigInt(Math.round(atomicUnits));

    const whole = atomicUnits / 1000000n;
    const frac = atomicUnits % 1000000n;

    if (frac === 0n) return whole.toString();

    return whole.toString() + '.' + frac.toString().padStart(6, '0').replace(/0+$/, '');
  }

  function parseXMR(amountString) {
    const parts = amountString.split('.');
    const whole = BigInt(parts[0] || '0');
    const frac = (parts[1] || '').padEnd(6, '0').substring(0, 6);

    return whole * 1000000n + BigInt(frac);
  }

  return {
    getCustomNode,
    setCustomNode,
    connect,
    disconnect,
    getInfo,
    getHeight,
    getFeeEstimate,
    getOuts,
    getTransactions,
    sendRawTransaction,
    getConnectionState,
    onConnectionChange,
    formatXMR,
    parseXMR,
    jsonRpc,
    rpcOther
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MoneroRPC;