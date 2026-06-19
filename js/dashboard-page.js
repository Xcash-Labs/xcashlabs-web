// SPDX-License-Identifier: MIT
// dashboard-page.js — moved inline so the CSP can drop 'unsafe-inline' for scripts
document.addEventListener('DOMContentLoaded', async () => {

// ─── Wallet load (vault-aware) ───
// The currently selected wallet is identified by xck-active-wallet.
// Wallet data is stored encrypted in WalletVault and unlocked with the
// user's wallet password. The unlock overlay handles both initial
// unlock and re-unlock after idle auto-lock.
  let walletKeys = null;
  const IDLE_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours
  let idleTimer = null;
  let scanningActive = false; // true while LWS is still scanning the chain
  let xckUsdPrice = 0;       // cached XCK/USD rate

  const overlay     = document.getElementById('unlock-overlay');
  const overlayMsg  = document.getElementById('unlock-msg');
  const overlayPw   = document.getElementById('unlock-pw');
  const overlayErr  = document.getElementById('unlock-error');
  const overlayBtn  = document.getElementById('unlock-btn');
  const overlayForget = document.getElementById('unlock-forget');

  function showUnlock(message) {
    overlayMsg.textContent = message;
    overlayErr.style.display = 'none';
    overlayPw.value = '';
    overlay.style.display = 'flex';
    setTimeout(() => overlayPw.focus(), 50);
  }
  function hideUnlock() {
    overlay.style.display = 'none';
    overlayPw.value = '';
  }

  overlayForget.addEventListener('click', () => {
    sessionStorage.removeItem('xck-active-wallet');
    walletKeys = null;
    window.location.href = '/wallet-mgr.html';
  });

  overlayBtn.addEventListener('click', tryUnlock);
  overlayPw.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });

  async function tryUnlock() {
    overlayErr.style.display = 'none';
    overlayBtn.disabled = true;
    overlayBtn.textContent = 'Unlocking…';

    try {
      const activeAddress =
        sessionStorage.getItem('xck-active-wallet');

      if (!activeAddress) {
        throw new Error('No wallet selected');
      }

      walletKeys = await WalletVault.unlock(
        activeAddress,
        overlayPw.value
      );

      hideUnlock();
      initDashboard();

    } catch (e) {
      overlayErr.textContent =
        e.message || 'Unlock failed';
      overlayErr.style.display = 'block';
    } finally {
      overlayBtn.disabled = false;
      overlayBtn.textContent = 'Unlock';
    }
  }

  const activeAddress = sessionStorage.getItem('xck-active-wallet');

  if (!activeAddress || !WalletVault.getBlob(activeAddress)) {
    sessionStorage.removeItem('xck-active-wallet');
    window.location.href = '/wallet-mgr.html';
    return;
  }

  document.getElementById('loading-state').style.display = 'none';
  document.getElementById('dashboard').style.display = 'none';

  showUnlock('Enter your wallet password to unlock this wallet.');
  return;

  // ─── Auto-lock plumbing ─────────────────────────────────────────────
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(autoLock, IDLE_TIMEOUT_MS);
  }
  // Keep the session alive while the LWS is scanning the blockchain.
  // Without this, the 10-minute idle timeout kicks the user out during
  // multi-hour genesis scans even though the wallet is actively working.
  function resetIdleIfScanning() {
    if (scanningActive) resetIdleTimer();
  }

  function autoLock() {
    walletKeys = null;
    window.location.reload();
  }

  function installIdleListeners() {
    ['mousemove','keydown','click','touchstart','scroll'].forEach(ev => {
      document.addEventListener(ev, resetIdleTimer, { passive: true });
    });
    resetIdleTimer();
  }

  // ─── Dashboard initialiser ──────────────────────────────────────────
// ─── Dashboard initialiser ──────────────────────────────────────────
function initDashboard() {
  console.log("[Dashboard] initDashboard()");

  document.getElementById('loading-state').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';

  if (typeof MoneroCore !== 'undefined') {
    console.log("[WASM] MoneroCore object found");

    const start = performance.now();

    MoneroCore.load()
      .then(function () {
        console.log(
          "[WASM] MoneroCore loaded successfully in",
          Math.round(performance.now() - start),
          "ms"
        );
      })
      .catch(function (err) {
        console.error("[WASM] MoneroCore.load() failed:", err);
      });
  } else {
    console.error("[WASM] MoneroCore is undefined");
  }

  console.log("[Dashboard] populateWallet()");
  populateWallet();

  console.log("[Dashboard] installIdleListeners()");
  installIdleListeners();
}

  async function populateWallet() {

  // ─── Populate wallet info ───
  document.getElementById('wallet-address').insertAdjacentText('afterbegin', walletKeys.address);
  document.getElementById('receive-addr').textContent = walletKeys.address;
  document.getElementById('key-spend').textContent = walletKeys.privateSpendKeyHex || '—';
  document.getElementById('key-view').textContent = walletKeys.privateViewKeyHex;
  document.getElementById('key-pub-spend').textContent = walletKeys.publicSpendKeyHex || '—';
  document.getElementById('key-pub-view').textContent = walletKeys.publicViewKeyHex;

  // ─── Seed phrase recovery ───
  // For 25-word standard seeds, the mnemonic is a reversible encoding of
  // the spend key. Reconstruct it so users can see/backup their seed.
  // For BIP-39, polyseed, and XCash Klassic seeds this isn't possible (one-way KDFs).
  (function showMnemonic () {
    // Only show for 25-word standard seeds. BIP-39, polyseed, and XCash Klassic
    // seeds use one-way KDFs — reconstructing a mnemonic from the spend key
    // would produce a DIFFERENT (wrong) 25-word seed.
    var fmt = walletKeys.seedFormat;
    if (fmt && fmt !== 'standard') return;
    var mnemonic = walletKeys.mnemonic || null;
    if (!mnemonic && typeof MoneroWordList !== 'undefined' && MoneroWordList.isLoaded('english')) {
      try {
        var spendBytes = MoneroKeys.hexToBytes(walletKeys.privateSpendKeyHex);
        var reduced = MoneroEd25519.sc_reduce32(spendBytes);
        var dataWords = MoneroWordList.encodeBytes('english', reduced);
        var fullWords = MoneroWordList.appendChecksum('english', dataWords);
        mnemonic = fullWords.join(' ');
      } catch (e) { /* wordlist missing or encode failed */ }
    }
    if (mnemonic) {
      document.getElementById('key-mnemonic').textContent = mnemonic;
      document.getElementById('mnemonic-section').style.display = '';
      document.getElementById('toggle-mnemonic').addEventListener('click', function () {
        var el = document.getElementById('key-mnemonic');
        var isHidden = el.classList.contains('hidden');
        el.classList.toggle('hidden');
        this.textContent = isHidden ? 'Hide' : 'Show';
      });
    }
  })();

  // ─── Wallet info badge (seed format + polyseed birthday) ───
  // Polyseed encodes a wallet creation timestamp ("birthday") in 10 bits as
  // 2-week buckets since 2021-11-01 UTC. Once balance scanning lands this is
  // what we'll use as the restore-from height. For now we just surface it
  // for the user.
  (function showWalletInfo () {
    const parts = [];
    if (walletKeys.seedFormat === 'polyseed' && typeof walletKeys.birthday === 'number') {
      const POLYSEED_EPOCH = Date.UTC(2021, 10, 1) / 1000; // 2021-11-01 UTC
      const TIME_STEP = 14 * 24 * 3600;                    // 2 weeks
      const ts = (POLYSEED_EPOCH + walletKeys.birthday * TIME_STEP) * 1000;
      const d = new Date(ts);
      const dateStr = d.toISOString().slice(0, 10);
      parts.push('Polyseed · birthday ~' + dateStr);
    } else if (walletKeys.seedFormat === 'bip39') {
      parts.push('BIP-39');
    }
    if (parts.length === 0) return;
    const info = document.createElement('div');
    info.style.cssText = 'display:inline-block;margin:6px 0;padding:4px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:100px;font-size:.68rem;color:var(--text-mid);font-family:"JetBrains Mono",monospace';
    info.textContent = parts.join(' · ');
    document.querySelector('.wallet-header').appendChild(info);
  })();

  function copyToClipboard (text, el) {
    navigator.clipboard.writeText(text).then(() => {
      if (el) {
        const old = el.textContent;
        el.textContent = 'Copied!';
        setTimeout(() => { el.textContent = old; }, 1200);
      }
    });
  }

  function escapeHtml (s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ─── Copy address on click ───
  document.getElementById('wallet-address').addEventListener('click', () => {
    navigator.clipboard.writeText(walletKeys.address).then(() => {
      const toast = document.getElementById('addr-toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 1500);
    });
  });

  // ─── Key visibility toggles ───
  ['spend', 'view'].forEach(type => {
    const toggle = document.getElementById('toggle-' + type);
    const value = document.getElementById('key-' + type);
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const hidden = value.classList.toggle('hidden');
      toggle.textContent = hidden ? 'Show' : 'Hide';
    });
  });

  // ─── LWS connection status ───
  const connDot = document.getElementById('conn-dot');
  const connInfo = document.getElementById('conn-info');

  function setLwsStatus(status, message) {
    if (connDot) connDot.className = 'conn-dot ' + status;
    if (connInfo) connInfo.textContent = message;
  }

  // ─── XCK/USD price ───
  // TODO: Add XCash Klassic price source.
  // Currently disabled because CoinGecko does not provide XCK pricing.
  async function  fetchXckPrice () {
    return;
  //  try {
  //    var resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd');
  //    var data = await resp.json();
  //    if (data && data.monero && data.monero.usd) {
  //      xckUsdPrice = data.monero.usd;
  //    }
  //  } catch (e) {
  //    // Non-critical — fiat display just stays empty
  //  }
  }

  function updateFiatDisplay (xckText) {
// Pricing currently disabled
//    var el = document.getElementById('balance-fiat');
//    if (!el || !xckUsdPrice) { if (el) el.textContent = ''; return; }
//    var xmr = parseFloat(xckText);
//    if (isNaN(xmr)) { el.textContent = ''; return; }
//    var usd = (xmr * xckUsdPrice).toFixed(2);
//    el.textContent = '\u2248 $' + usd.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' USD';
  }

  //TODO fix
  // Fetch price now, then refresh every 5 minutes
  // fetchXckPrice();
  //setInterval( fetchXckPrice, 300000);

  // ─── Light-wallet balance polling ───
  // Polls monero-lws via js/lws-client.js for the wallet's balance, scan
  // progress, and recent transactions. Gracefully handles the LWS being
  // offline (still common: monerod still syncing, lws not yet started)
  // by showing a "scanning unavailable" message instead of breaking the
  // dashboard.
  let balancePollTimer = null;
  let lwsRegistered = false;
  var _keyImageCache = {}; // tx_pub_key:out_index → real key_image

  async function startBalancePolling () {
    const balEl  = document.getElementById('balance-xmr');
    const noteEl = document.getElementById('balance-note');

    // Mark as scanning while we wait for the first response
    balEl.textContent = '—';
    noteEl.textContent = 'Connecting to light-wallet server…';

    // First call: register the wallet with the LWS, then decide whether
    // to trigger a historical rescan via /import_wallet_request.
    //
    // KEY FACT: monero-lws 1.0-alpha ignores start_height in /login.
    // The /login endpoint ALWAYS registers wallets at the current chain
    // tip. The ONLY way to trigger a historical scan is to call
    // /import_wallet_request, which resets the scan to genesis (block 0).
    // We still send start_height for forward-compatibility with newer
    // monero-lws builds that may support it.
    try {
      const opts = {};

      // Compute the best restore height from available sources.
      // Currently informational only (LWS ignores it), but sent in
      // /login for forward-compatibility with future LWS versions.
      let restoreHeight = 0;
      if (typeof walletKeys.restoreHeight === 'number' && walletKeys.restoreHeight > 0) {
        restoreHeight = walletKeys.restoreHeight;
      } else if (walletKeys.seedFormat === 'polyseed' && typeof walletKeys.birthday === 'number') {
        const POLYSEED_EPOCH_HEIGHT = 2477560;
        restoreHeight = POLYSEED_EPOCH_HEIGHT + walletKeys.birthday * 5040 * 2;
      }
      opts.createdAt = restoreHeight;

      // Detect freshly-created wallets via two redundant signals:
      // 1. sessionStorage flag written by verify-page.js Create flow
      // 2. Vault flag createdAtCurrentTip (survives page refresh)
      var freshFlag = false;
      try { freshFlag = sessionStorage.getItem('xck-fresh-wallet') === '1'; } catch (e) {}
      if (!freshFlag && walletKeys.createdAtCurrentTip === true) {
        freshFlag = true;
      }
      if (freshFlag) {
        opts.generatedLocally = true;
        try { sessionStorage.removeItem('xck-fresh-wallet'); } catch (e) {}
      }

      var loginRes;
      try {
        loginRes = await LwsClient.login(walletKeys.address, walletKeys.privateViewKeyHex, opts);
      } catch (loginErr) {
        if (loginErr.statusCode === 429 && loginErr.message === 'bot_detected') {
          showRateLimitModal();
          return;
        }
        throw loginErr;
      }
      lwsRegistered = true;
      setLwsStatus('connected', 'Connected to XCash Klassic LWS');

      // Record this login for the inactive-account tracker (fire-and-forget)
      LwsClient.pingLogin(walletKeys.address);

      // Decide whether to trigger a historical rescan:
      //
      // - new_address=true + freshFlag  → freshly created wallet. LWS
      //   registered it at the tip. No historical scan needed.
      //
      // - new_address=true + !freshFlag → imported wallet, first time
      //   on this LWS. MUST call /import_wallet_request to trigger a
      //   full chain scan, otherwise the wallet appears "synced" with
      //   zero balance (the LWS only registered it at the current tip).
      //
      // - new_address=false → account already exists on the LWS from
      //   a previous session. Don't re-import; scan is already running
      //   or complete.
      var isNewAccount = loginRes && loginRes.new_address === true;

      if (freshFlag) {
        // Fresh wallet — no history to find, LWS starts from tip.
        // If this is an existing account that somehow got an import
        // (race condition, stale cache), don't make it worse.
        console.log('[lws] fresh wallet — no historical scan needed');
      } else if (isNewAccount) {
        // Imported wallet — trigger historical scan. Pass restoreHeight
        // so the LWS starts scanning from that block instead of genesis.
        // If restoreHeight is 0, the LWS scans the entire chain.
        console.log('[lws] imported wallet — requesting historical scan from ' +
          (restoreHeight > 0 ? 'block ' + restoreHeight : 'genesis'));
        try {
          await LwsClient.importWalletRequest(walletKeys.address, walletKeys.privateViewKeyHex, restoreHeight);
        } catch (e) {
          console.warn('[lws] import request failed (non-fatal):', e);
        }
      } else {
        // Existing account — scan already in progress or done
        console.log('[lws] existing account — not re-importing');
      }
    } catch (e) {
      // Server unreachable or refused. Show the note but don't break.
      console.warn('[lws] register failed:', e);
      balEl.textContent = '—';
      noteEl.innerHTML = 'Balance scanning unavailable — ' +
        '<a href="#" id="bal-retry" style="color:var(--accent);text-decoration:underline">retry</a>';
      const r = document.getElementById('bal-retry');
      if (r) r.addEventListener('click', (ev) => { ev.preventDefault(); startBalancePolling(); });
      return;
    }

    // Tight first poll to surface initial state quickly, then 60s cadence.
    if (balancePollTimer) clearInterval(balancePollTimer);
    pollBalanceOnce();
    balancePollTimer = setInterval(pollBalanceOnce, 60000);
  }

  async function pollBalanceOnce () {
    if (!lwsRegistered) return;
    const balEl  = document.getElementById('balance-xmr');
    const noteEl = document.getElementById('balance-note');
    try {
      const info = await LwsClient.getAddressInfo(walletKeys.address, walletKeys.privateViewKeyHex);

      // ── Client-side key_image verification ──
      // The LWS flags outputs as "spent" whenever their global index
      // appears in ANY transaction's ring signature — including as a
      // decoy in other people's transactions. We compute the REAL
      // key_image for each output using the spend key (via WASM) and
      // only count spends where the key_image matches. Mismatches are
      // false positives from ring-decoy appearances.
      if (info && Array.isArray(info.spent_outputs) && info.spent_outputs.length > 0
          && walletKeys.privateSpendKeyHex) {
        var falseSpendTotal = 0n;
        try {
          if (!MoneroCore.isLoaded()) await MoneroCore.load();
          for (var so of info.spent_outputs) {
            var cacheKey = so.tx_pub_key + ':' + so.out_index;
            if (!_keyImageCache[cacheKey]) {
              try {
                _keyImageCache[cacheKey] = MoneroCore.generateKeyImage(
                  so.tx_pub_key,
                  walletKeys.privateViewKeyHex,
                  walletKeys.publicSpendKeyHex,
                  walletKeys.privateSpendKeyHex,
                  so.out_index
                );
              } catch (kiErr) {
                // If key_image computation fails for this output, skip it
                console.warn('[lws] key_image compute failed for ' + cacheKey + ':', kiErr);
                continue;
              }
            }
            if (_keyImageCache[cacheKey] !== so.key_image) {
              falseSpendTotal += BigInt(so.amount || '0');
            }
          }
          if (falseSpendTotal > 0n) {
            var correctedSent = BigInt(info.total_sent || '0') - falseSpendTotal;
            if (correctedSent < 0n) correctedSent = 0n;
            info.total_sent = correctedSent.toString();
            console.log('[lws] filtered ' + falseSpendTotal.toString() + ' xcash klassic of false spends');
          }
        } catch (e) {
          // WASM failed to load — use heuristic fallbacks
          console.warn('[lws] key_image verification unavailable:', e.message);
          var totalRecv = BigInt(info.total_received || '0');
          var totalSent = BigInt(info.total_sent || '0');

          // Heuristic 1: dedup by (tx_pub_key, out_index) — same output
          // can't be spent more than once
          if (info.spent_outputs.length > 1) {
            var seen = {};
            var dedupTotal = 0n;
            for (var so of info.spent_outputs) {
              var key = so.tx_pub_key + ':' + so.out_index;
              if (seen[key]) {
                dedupTotal += BigInt(so.amount || '0');
              } else {
                seen[key] = true;
              }
            }
            if (dedupTotal > 0n) {
              totalSent -= dedupTotal;
              if (totalSent < 0n) totalSent = 0n;
            }
          }

          // Heuristic 2: total_sent can never exceed total_received
          // (you can't spend more than you received). Clamp it.
          if (totalSent > totalRecv) {
            totalSent = totalRecv;
          }

          info.total_sent = totalSent.toString();
        }
      }

      var avail;
      avail = LwsClient.availableBalance(info);
      const progress = LwsClient.scanProgress(info);
      balEl.textContent = LwsClient.formatXck(avail);
      updateFiatDisplay(balEl.textContent);

      // Show locked (pending) balance if there is one
      var locked = BigInt(info.locked_funds || '0');
      var lockedEl = document.getElementById('balance-locked');
      if (locked > 0n) {
        if (!lockedEl) {
          lockedEl = document.createElement('div');
          lockedEl.id = 'balance-locked';
          lockedEl.style.cssText = 'font-size:.72rem;color:var(--warning);margin-top:2px;font-family:"JetBrains Mono",monospace';
          balEl.parentNode.insertBefore(lockedEl, balEl.nextSibling);
        }
        lockedEl.textContent = '+ ' + LwsClient.formatXck(locked) + ' XCK locked (confirming)';
        lockedEl.style.display = 'block';
      } else if (lockedEl) {
        lockedEl.style.display = 'none';
      }

      // Refresh tx history in parallel on the same cadence
      pollTxHistoryOnce();
      // Drive the scanning progress bar
      var scanWrap = document.getElementById('scan-bar-wrap');
      var scanFill = document.getElementById('scan-bar-fill');
      var scanPct  = document.getElementById('scan-bar-pct');
      var scanHt   = document.getElementById('scan-bar-height');

      if (progress < 1) {
        scanningActive = true;
        resetIdleIfScanning();
        var pct = (progress * 100).toFixed(1);
        noteEl.textContent = 'Scanning blockchain…';
        if (scanWrap) scanWrap.style.display = 'block';
        if (scanFill) scanFill.style.width = pct + '%';
        if (scanPct)  scanPct.textContent = pct + '%';
        if (scanHt) {
          var cur   = info.scanned_block_height || info.scanned_height || 0;
          var tip   = info.blockchain_height || 0;
          var start = info.start_height || 0;
          // Show blocks scanned relative to the start point, not absolute
          // heights. "12,300 / 639,227 blocks" is clearer than
          // "3,024,100 / 3,651,027" when scanning from a restore height.
          var done  = Math.max(0, cur - start);
          var total = Math.max(1, tip - start);
          scanHt.textContent = done.toLocaleString() + ' / ' + total.toLocaleString() + ' blocks';
        }
      } else {
        scanningActive = false;
        noteEl.textContent = 'Up to date · last checked ' + new Date().toLocaleTimeString();
        if (scanWrap) scanWrap.style.display = 'none';
      }
    } catch (e) {
      console.warn('[lws] poll failed:', e);
      // If the LWS client already handled re-registration internally,
      // the retry inside getAddressInfo would have succeeded. If we still
      // land here it's a genuine connectivity issue.
      noteEl.textContent = 'Light-wallet server temporarily unavailable';
    }
  }

  // ─── Transaction history polling ───
  // Runs alongside the balance poll — same 30-second cadence. Fetches
  // the wallet's full tx list from the LWS and renders it into #tx-list.
  // Safe to call before the LWS is up (it just shows a loading state).
  async function pollTxHistoryOnce () {
    if (!lwsRegistered) return;
    const listEl = document.getElementById('tx-list');
    if (!listEl) return;
    try {
      const resp = await LwsClient.getAddressTxs(walletKeys.address, walletKeys.privateViewKeyHex);
      var txs = (resp && Array.isArray(resp.transactions)) ? resp.transactions : [];
      const chainTip = (resp && resp.blockchain_height) || 0;

      // Filter out false-spend transactions using the key_image cache
      // built by pollBalanceOnce(). If every spent_output in a tx has a
      // key_image that doesn't match the computed real key_image, the
      // tx is a false positive from ring-decoy detection — hide it.
      if (Object.keys(_keyImageCache).length > 0) {
        txs = txs.filter(function (tx) {
          if (!tx.spent_outputs || tx.spent_outputs.length === 0) return true;
          for (var so of tx.spent_outputs) {
            var cacheKey = so.tx_pub_key + ':' + so.out_index;
            var real = _keyImageCache[cacheKey];
            if (!real || real === so.key_image) return true; // real or unknown
          }
          return false; // all spent_outputs are false positives
        });
      }

      if (txs.length === 0) {
        listEl.innerHTML = '<div class="key-card" style="text-align:center;color:var(--text-dim);font-size:.75rem;padding:18px">No transactions yet. Receive some XCK and it\'ll show up here.</div>';
        return;
      }

      // Sort newest first by height (mempool txs at top)
      txs.sort((a, b) => {
        if (a.mempool && !b.mempool) return -1;
        if (b.mempool && !a.mempool) return 1;
        return (b.height || 0) - (a.height || 0);
      });

      const rows = txs.map(tx => {
        const received = BigInt(tx.total_received || '0');
        const sent = BigInt(tx.total_sent || '0');
        const net      = received - sent;
        const isIn     = net >= 0n;
        const display  = LwsClient.formatXck(net < 0n ? -net : net);
        const confirms = tx.mempool ? 0 : Math.max(0, chainTip - (tx.height || 0));
        const when     = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : '—';
        const status   = tx.mempool
          ? '<span style="color:var(--warning)">pending</span>'
          : (confirms < 10
            ? '<span style="color:var(--warning)">' + confirms + ' / 10 confs</span>'
            : '<span style="color:var(--success)">confirmed</span>');
        const arrow    = isIn ? '↓' : '↑';
        const arrowCol = isIn ? 'var(--success)' : 'var(--accent)';
        const hash     = (tx.hash || '').slice(0, 16) + '…';
        const fullHash = tx.hash || '';
        const feeDisplay = tx.fee && tx.fee !== '0' ? LwsClient.formatXck(tx.fee) : '—';
        const paymentId  = tx.payment_id && tx.payment_id !== '0000000000000000' ? tx.payment_id : '';
        const explorerUrl = 'https://explorer.xcashlabs.org/tx/' + encodeURIComponent(fullHash);

        // Detail panel (hidden by default, toggled on click)
        var detailRows = '';
        detailRows += '<tr><td style="color:var(--text-dim);padding:4px 12px 4px 0;white-space:nowrap">Transaction ID</td><td style="padding:4px 0;word-break:break-all"><span class="tx-detail-copy" data-copy="' + escapeHtml(fullHash) + '" style="cursor:pointer" title="Click to copy">' + escapeHtml(fullHash) + '</span></td></tr>';
        detailRows += '<tr><td style="color:var(--text-dim);padding:4px 12px 4px 0">Date</td><td style="padding:4px 0">' + escapeHtml(when) + '</td></tr>';
        detailRows += '<tr><td style="color:var(--text-dim);padding:4px 12px 4px 0">Height</td><td style="padding:4px 0">' + (tx.height ? tx.height.toLocaleString() : 'mempool') + '</td></tr>';
        detailRows += '<tr><td style="color:var(--text-dim);padding:4px 12px 4px 0">Amount</td><td style="padding:4px 0;font-weight:600;color:' + arrowCol + '">' + (isIn ? '+' : '−') + display + ' XCK</td></tr>';
        detailRows += '<tr><td style="color:var(--text-dim);padding:4px 12px 4px 0">Fee</td><td style="padding:4px 0">' + feeDisplay + (feeDisplay !== '—' ? ' XCK' : '') + '</td></tr>';
        detailRows += '<tr><td style="color:var(--text-dim);padding:4px 12px 4px 0">Confirmations</td><td style="padding:4px 0">' + (tx.mempool ? 'unconfirmed' : confirms.toLocaleString()) + '</td></tr>';
        if (paymentId) {
          detailRows += '<tr><td style="color:var(--text-dim);padding:4px 12px 4px 0">Payment ID</td><td style="padding:4px 0;word-break:break-all">' + escapeHtml(paymentId) + '</td></tr>';
        }
        detailRows += '<tr><td style="color:var(--text-dim);padding:4px 12px 4px 0">Direction</td><td style="padding:4px 0">' + (isIn ? 'Received' : 'Sent') + '</td></tr>';
        detailRows += '<tr><td colspan="2" style="padding:8px 0 0 0"><a href="' + escapeHtml(explorerUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:.72rem;text-decoration:none">View on block explorer ↗</a></td></tr>';

        return '<div class="key-card" style="margin-bottom:6px;padding:0;overflow:hidden">' +
          '<div class="tx-row" style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;cursor:pointer">' +
            '<div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">' +
              '<span style="font-size:1.1rem;color:' + arrowCol + ';font-weight:700;flex-shrink:0">' + arrow + '</span>' +
              '<div style="min-width:0">' +
                '<div style="font-size:.82rem;font-weight:600;color:var(--text);font-family:\'JetBrains Mono\',monospace">' + (isIn ? '+' : '−') + display + ' <span style="color:var(--text-dim);font-size:.7rem;font-weight:400">XCK</span></div>' +
                '<div style="font-size:.65rem;color:var(--text-dim);margin-top:2px">' + escapeHtml(when) + ' · ' + status + '</div>' +
              '</div>' +
            '</div>' +
            '<div style="font-family:\'JetBrains Mono\',monospace;font-size:.62rem;color:var(--text-dim)">' + escapeHtml(hash) + '</div>' +
          '</div>' +
          '<div class="tx-detail" style="display:none;padding:0 14px 14px;border-top:1px solid var(--border)">' +
            '<table style="width:100%;font-size:.72rem;font-family:\'JetBrains Mono\',monospace;border-collapse:collapse;margin-top:10px">' + detailRows + '</table>' +
          '</div>' +
        '</div>';
      }).join('');

      listEl.innerHTML = rows;

      // Toggle detail panel on row click
      listEl.querySelectorAll('.tx-row').forEach(row => {
        row.addEventListener('click', () => {
          const detail = row.nextElementSibling;
          if (detail && detail.classList.contains('tx-detail')) {
            detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
          }
        });
      });

      // Click-to-copy on detail fields
      listEl.querySelectorAll('.tx-detail-copy').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = el.getAttribute('data-copy');
          if (val) navigator.clipboard.writeText(val).then(() => {
            const old = el.textContent;
            el.textContent = 'Copied!';
            setTimeout(() => { el.textContent = old; }, 1200);
          });
        });
      });
    } catch (e) {
      console.warn('[lws] tx history fetch failed:', e);
      listEl.innerHTML = '<div class="key-card" style="text-align:center;color:var(--text-dim);font-size:.75rem;padding:18px">Could not load transactions — will retry on next poll</div>';
    }
  }

  // ─── Start dashboard LWS polling ───
  document.getElementById('loading-state').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  setLwsStatus('connecting', 'Connecting to XCash Klassic LWS');
  startBalancePolling();

  // ─── RATE LIMIT MODAL ───
  function showRateLimitModal () {
    document.getElementById('ratelimit-modal').classList.add('show');
  }
  document.getElementById('ratelimit-close').addEventListener('click', () => {
    document.getElementById('ratelimit-modal').classList.remove('show');
  });
  document.getElementById('ratelimit-ok').addEventListener('click', () => {
    document.getElementById('ratelimit-modal').classList.remove('show');
  });
  document.getElementById('ratelimit-modal').addEventListener('click', (e) => {
    if (e.target.id === 'ratelimit-modal') e.target.classList.remove('show');
  });

  // ─── RECEIVE MODAL ───
  document.getElementById('btn-receive').addEventListener('click', () => {
    document.getElementById('receive-modal').classList.add('show');
    // Generate QR code as SVG using a simple QR library inline
    generateQR(walletKeys.address);
  });

  document.getElementById('receive-close').addEventListener('click', () => {
    document.getElementById('receive-modal').classList.remove('show');
  });

  document.getElementById('receive-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(walletKeys.address).then(() => {
      const btn = document.getElementById('receive-copy');
      btn.textContent = 'Copied!';
      btn.style.borderColor = 'rgba(34,197,94,0.3)';
      btn.style.color = '#4ade80';
      setTimeout(() => { btn.textContent = 'Copy Address'; btn.style.borderColor = ''; btn.style.color = ''; }, 2000);
    });
  });

  // Close modal on backdrop click
  document.getElementById('receive-modal').addEventListener('click', (e) => {
    if (e.target.id === 'receive-modal') e.target.classList.remove('show');
  });

  // ─── BRIDGE MODAL ───
  document.getElementById('btn-bridge').addEventListener('click', () => {
    document.getElementById('bridge-modal').classList.add('show');
  });

  document.getElementById('bridge-close').addEventListener('click', () => {
    document.getElementById('bridge-modal').classList.remove('show');
  });

  document.getElementById('bridge-start').addEventListener('click', () => {
    window.open('https://bridge.xcashlabs.org', '_blank');
  });

  // ─── SEND MODAL ───
  // Multi-step: form → confirm → result. All three steps live inside
  // #send-modal; we toggle their visibility on transition.
  let sendPreview = null;      // cached fee estimate from Review step
  let sendPrivacy = 'private';
  let sendPriority = 2;

  function sendShowStep (step) {
    ['form', 'confirm', 'result'].forEach(s => {
      const el = document.getElementById('send-step-' + s);
      if (el) el.style.display = (s === step) ? '' : 'none';
    });
  }
  function sendShowResultState (state) {
    ['pending', 'success', 'error'].forEach(s => {
      const el = document.getElementById('send-result-' + s);
      if (el) el.style.display = (s === state) ? '' : 'none';
    });
  }
  function sendResetForm () {
    sendPreview = null;
    const errEl = document.getElementById('send-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    sendShowStep('form');
  }

  document.getElementById('btn-send').addEventListener('click', () => {
    sendResetForm();
    document.getElementById('send-modal').classList.add('show');
    // Update "Available" from the latest LWS poll
    const balText = document.getElementById('balance-xmr').textContent;
    const availEl = document.getElementById('send-available');
    if (availEl) availEl.textContent = balText;
  });

  document.getElementById('send-close').addEventListener('click', () => {
    document.getElementById('send-modal').classList.remove('show');
  });

  document.getElementById('send-modal').addEventListener('click', (e) => {
    if (e.target.id === 'send-modal') e.target.classList.remove('show');
  });

  document.querySelectorAll('.send-priv-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.send-priv-btn')
        .forEach(b => b.classList.remove('active'));

      btn.classList.add('active');
      sendPrivacy = btn.dataset.privacy || 'private';
    });
  });

// Priority buttons
  document.querySelectorAll('.send-prio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.send-prio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sendPriority = parseInt(btn.dataset.priority, 10) || 2;
    });
  });

  // Recipient address live validation + hint
  const sendToEl = document.getElementById('send-to');
  const sendToHintEl = document.getElementById('send-to-hint');
  const sendAmountEl = document.getElementById('send-amount');
  const sendReviewBtn = document.getElementById('send-review');

  function refreshSendReviewState() {
    const addr = (sendToEl.value || '').trim();
    const amt = (sendAmountEl.value || '').trim();

    const v = MoneroSend.validateAddress(addr);

    if (addr.length === 0) {
      sendToHintEl.textContent = '';
      sendToHintEl.style.color = '';
    } else if (!v.valid) {
      sendToHintEl.textContent = 'Address does not look valid (' + v.reason + ')';
      sendToHintEl.style.color = '#f87171';
    } else if (v.integrated) {
      sendToHintEl.textContent = '✓ Integrated address';
      sendToHintEl.style.color = '#22c55e';
    } else {
      sendToHintEl.textContent = '✓ Valid XCK address';
      sendToHintEl.style.color = '#22c55e';
    }

    const amtNorm = amt.replace(',', '.');
    const amtOk =
      amtNorm.length > 0 &&
      /^\d+(\.\d+)?$/.test(amtNorm) &&
      Number(amtNorm) > 0;

    sendReviewBtn.disabled = !(v.valid && amtOk);

    const pidGroup = document.getElementById('send-pid-group');

    // Payment ID only applies to normal primary addresses.
    // Integrated addresses already include one.
    if (pidGroup) {
      pidGroup.style.display =
        v.valid && !v.integrated ? '' : 'none';
    }
  }

  sendToEl.addEventListener('input', refreshSendReviewState);
  sendAmountEl.addEventListener('input', refreshSendReviewState);

  // Send max — fills amount with the current balance
  document.getElementById('send-max').addEventListener('click', () => {
    const bal = document.getElementById('balance-xmr').textContent;
    if (bal && bal !== '—') {
      sendAmountEl.value = bal;
      refreshSendReviewState();
    }
  });

  // Cancel
  document.getElementById('send-cancel').addEventListener('click', () => {
    document.getElementById('send-modal').classList.remove('show');
  });

  // Review → fetch fee estimate
  sendReviewBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('send-error');
    errEl.style.display = 'none';
    sendReviewBtn.disabled = true;
    sendReviewBtn.textContent = 'Estimating…';
    try {
      const toAddress = (sendToEl.value || '').trim();
      const xckAmount = (sendAmountEl.value || '').trim();
      sendPreview = await MoneroSend.estimateFee(walletKeys, toAddress, xckAmount, sendPriority);

      document.getElementById('confirm-to').textContent = toAddress;
      document.getElementById('confirm-amount').textContent = xckAmount + ' XCK';
      document.getElementById('confirm-fee').textContent = sendPreview.fee_xmr + ' XCK';
      const total = (Number(xckAmount) + Number(sendPreview.fee_xmr)).toString();
      document.getElementById('confirm-total').textContent = total + ' XCK';

      sendShowStep('confirm');
    } catch (e) {
      errEl.textContent = e.message || 'Estimate failed';
      errEl.style.display = 'block';
    }
    sendReviewBtn.disabled = false;
    sendReviewBtn.textContent = 'Review →';
  });

  // Back from confirm → form
  document.getElementById('send-back').addEventListener('click', () => {
    sendShowStep('form');
  });

  // Confirm → actually send
  document.getElementById('send-confirm').addEventListener('click', async () => {
    sendShowStep('result');
    sendShowResultState('pending');
    try {
      const toAddress = (sendToEl.value || '').trim();
      const xckAmount = (sendAmountEl.value || '').trim();
      const paymentId = (document.getElementById('send-pid').value || '').trim();
      const result = await MoneroSend.send(walletKeys, toAddress, xckAmount, sendPriority, paymentId, sendPreview, sendPrivacy);
      document.getElementById('send-result-hash').textContent = result.tx_hash;
      sendShowResultState('success');
      // Trigger a balance refresh so the new pending tx shows up
      if (typeof pollBalanceOnce === 'function') setTimeout(pollBalanceOnce, 2000);
    } catch (e) {
      console.error('[dashboard] send failed:', e);
      document.getElementById('send-result-error-msg').textContent = e.message || 'Unknown error';
      sendShowResultState('error');
    }
  });

  // Result: Done → close modal
  document.getElementById('send-done').addEventListener('click', () => {
    document.getElementById('send-modal').classList.remove('show');
    sendResetForm();
    sendToEl.value = '';
    sendAmountEl.value = '';
  });

  // Result: Retry → back to form with values intact
  document.getElementById('send-retry').addEventListener('click', () => {
    sendShowStep('form');
  });

  // ─── QR CODE GENERATOR (simple version using canvas→dataURL) ───
  function generateQR(text) {
    // Render the QR code locally with the vendored qrcodegen.js encoder.
    // Nothing about the user's address ever leaves the browser — no third
    // party (qrserver, googleapis, etc.) is contacted.
    const qrContainer = document.getElementById('qr-code');
    try {
      // typeNumber=0 → auto-pick the smallest version that fits, EC level "M"
      const qr = qrcode(0, 'M');
      qr.addData('xcashklassic:' + text);
      qr.make();
      const count = qr.getModuleCount();
      const size  = 220;       // pixel size of the rendered SVG
      const quiet = 2;         // quiet-zone modules around the code
      const total = count + quiet * 2;
      const cell  = size / total;

      let rects = '';
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) {
            rects += '<rect x="' + ((c + quiet) * cell).toFixed(2) +
                     '" y="' + ((r + quiet) * cell).toFixed(2) +
                     '" width="' + cell.toFixed(2) +
                     '" height="' + cell.toFixed(2) + '" fill="#eae8e4"/>';
          }
        }
      }
      qrContainer.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
        '" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" ' +
        'style="background:#111113;border-radius:12px">' + rects + '</svg>';
    } catch (e) {
      qrContainer.innerHTML = '<div style="color:#f87171;font-size:.75rem;padding:20px">QR error: ' + e.message + '</div>';
    }
  }

  // ─── Disconnect ───
  document.getElementById('btn-disconnect').addEventListener('click', () => {
    sessionStorage.removeItem('xck-active-wallet');
    window.location.href = '/wallet-mgr.html';
  });

  // ─── Export wallet (JSON) ───
  document.getElementById('btn-export').addEventListener('click', () => {
    const dump = {
      format: 'xcash-klassic-web-wallet-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      network: walletKeys.network || 'mainnet',
      address: walletKeys.address,
      privateSpendKeyHex: walletKeys.privateSpendKeyHex || null,
      privateViewKeyHex:  walletKeys.privateViewKeyHex,
      publicSpendKeyHex:  walletKeys.publicSpendKeyHex || null,
      publicViewKeyHex:   walletKeys.publicViewKeyHex,
    };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'xcash-klassic-wallet-' + walletKeys.address.slice(0, 8) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  } // end populateWallet
});
