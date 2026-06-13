// SPDX-License-Identifier: MIT
/**
 * wallet-vault.js — encrypted localStorage wallet vault for XCK wallets
 *
 * Stores multiple encrypted wallets under one localStorage key.
 * Passwords are never stored.
 */

const WalletVault = (function () {
  'use strict';

  const STORAGE_KEY = 'xck-wallets';
  const FRESH_WALLET_KEY = 'xck-fresh-wallet';
  const PBKDF2_ITERATIONS = 250000;

  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function unb64(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function deriveKey(password, salt, iterations) {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function readAll() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};

    try {
      return JSON.parse(raw) || {};
    } catch (e) {
      return {};
    }
  }

  function writeAll(wallets) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets || {}));
  }

  async function store(keys, password) {
    if (!keys || !keys.address) {
      throw new Error('Wallet address is required');
    }

    if (!password || password.trim().length < 8) {
      throw new Error('Wallet password is required');
    }

    if (keys.createdAtCurrentTip) {
      try {
        sessionStorage.setItem(FRESH_WALLET_KEY, '1');
      } catch (e) {}
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);

    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(keys))
    ));

    const wallets = readAll();

    wallets[keys.address] = {
      address: keys.address,
      network: keys.network || 'mainnet',
      label: keys.label || keys.address.slice(0, 10) + '...',
      encrypted: true,
      version: 1,
      iterations: PBKDF2_ITERATIONS,
      salt: b64(salt),
      iv: b64(iv),
      ciphertext: b64(ciphertext),
      updatedAt: new Date().toISOString()
    };

    writeAll(wallets);
  }

  function list() {
    return Object.values(readAll()).map(wallet => ({
      address: wallet.address,
      network: wallet.network,
      label: wallet.label,
      updatedAt: wallet.updatedAt,
      encrypted: !!wallet.encrypted
    }));
  }

  function hasWallets() {
    return list().length > 0;
  }

  function getBlob(address) {
    if (!address) return null;
    return readAll()[address] || null;
  }

  async function unlock(address, password) {
    if (!address) {
      throw new Error('Wallet address is required');
    }

    if (!password) {
      throw new Error('Wallet password is required');
    }

    const blob = getBlob(address);

    if (!blob || !blob.encrypted) {
      throw new Error('No encrypted wallet found');
    }

    const salt = unb64(blob.salt);
    const iv = unb64(blob.iv);
    const ciphertext = unb64(blob.ciphertext);
    const iterations =
      typeof blob.iterations === 'number'
        ? blob.iterations
        : PBKDF2_ITERATIONS;

    const key = await deriveKey(password, salt, iterations);

    let plain;

    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
    } catch (e) {
      throw new Error('Wrong password');
    }

    return JSON.parse(new TextDecoder().decode(plain));
  }

  function remove(address) {
    if (!address) return;

    const wallets = readAll();
    delete wallets[address];
    writeAll(wallets);
  }

  function clear() {
    localStorage.removeItem(STORAGE_KEY);
  }

  return {
    store,
    list,
    hasWallets,
    getBlob,
    unlock,
    remove,
    clear
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WalletVault;
}