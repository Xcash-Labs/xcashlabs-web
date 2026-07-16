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

  const overlay = document.getElementById('unlock-overlay');
  const overlayMsg = document.getElementById('unlock-msg');
  const overlayPw = document.getElementById('unlock-pw');
  const overlayErr = document.getElementById('unlock-error');
  const overlayBtn = document.getElementById('unlock-btn');
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
  const activeAddress = sessionStorage.getItem('xck-active-wallet');

  async function tryUnlock() {
    overlayErr.style.display = 'none';
    overlayBtn.disabled = true;
    overlayBtn.textContent = 'Unlocking…';

    try {
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

  const wallet = WalletVault.list().find(
    w => w.address === activeAddress
  );

  const walletNameElement = document.getElementById('wallet-name');

  if (wallet && walletNameElement) {
    walletNameElement.textContent = wallet.label || 'My Wallet';
  }

  document.getElementById('loading-state').style.display = 'none';
  document.getElementById('dashboard').style.display = 'none';
  showUnlock('Enter your wallet password to unlock this wallet.');

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
    ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(ev => {
      document.addEventListener(ev, resetIdleTimer, { passive: true });
    });
    resetIdleTimer();
  }

  // ─── Dashboard initialiser ──────────────────────────────────────────
  function initDashboard() {
    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    // Preload WASM in background so it's ready for key_image verification
    // and send. Don't await — let it load while the dashboard connects.
    if (typeof MoneroCore !== 'undefined') {
      MoneroCore.load().catch(function () { }); // fire-and-forget
    }
    populateWallet();
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
    (function showMnemonic() {
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
    (function showWalletInfo() {
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

    function copyToClipboard(text, el) {
      navigator.clipboard.writeText(text).then(() => {
        if (el) {
          const old = el.textContent;
          el.textContent = 'Copied!';
          setTimeout(() => { el.textContent = old; }, 1200);
        }
      });
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    async function fetchXckPrice() {
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

    function updateFiatDisplay(xckText) {
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

    async function startBalancePolling() {
      const balEl = document.getElementById('balance-xck');
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
        try { freshFlag = sessionStorage.getItem('xck-fresh-wallet') === '1'; } catch (e) { }
        if (!freshFlag && walletKeys.createdAtCurrentTip === true) {
          freshFlag = true;
        }
        if (freshFlag) {
          opts.generatedLocally = true;
          try { sessionStorage.removeItem('xck-fresh-wallet'); } catch (e) { }
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

    async function pollBalanceOnce() {
      if (!lwsRegistered) return;
      const balEl = document.getElementById('balance-xck');
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
        var scanPct = document.getElementById('scan-bar-pct');
        var scanHt = document.getElementById('scan-bar-height');

        if (progress < 1) {
          scanningActive = true;
          resetIdleIfScanning();
          var pct = (progress * 100).toFixed(1);
          noteEl.textContent = 'Scanning blockchain…';
          if (scanWrap) scanWrap.style.display = 'block';
          if (scanFill) scanFill.style.width = pct + '%';
          if (scanPct) scanPct.textContent = pct + '%';
          if (scanHt) {
            var cur = info.scanned_block_height || info.scanned_height || 0;
            var tip = info.blockchain_height || 0;
            var start = info.start_height || 0;
            // Show blocks scanned relative to the start point, not absolute
            // heights. "12,300 / 639,227 blocks" is clearer than
            // "3,024,100 / 3,651,027" when scanning from a restore height.
            var done = Math.max(0, cur - start);
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
    async function pollTxHistoryOnce() {
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
          const net = received - sent;
          const isIn = net >= 0n;
          const display = LwsClient.formatXck(net < 0n ? -net : net);
          const confirms = tx.mempool ? 0 : Math.max(0, chainTip - (tx.height || 0));
          const when = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : '—';
          const status = tx.mempool
            ? '<span style="color:var(--warning)">pending</span>'
            : (confirms < 10
              ? '<span style="color:var(--warning)">' + confirms + ' / 10 confs</span>'
              : '<span style="color:var(--success)">confirmed</span>');
          const arrow = isIn ? '↓' : '↑';
          const arrowCol = isIn ? 'var(--success)' : 'var(--accent)';
          const hash = (tx.hash || '').slice(0, 16) + '…';
          const fullHash = tx.hash || '';
          const feeDisplay = tx.fee && tx.fee !== '0' ? LwsClient.formatXck(tx.fee) : '—';
          const paymentId = tx.payment_id && tx.payment_id !== '0000000000000000' ? tx.payment_id : '';
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
    function showRateLimitModal() {
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


    // ─── BRIDGE HISTORY MODAL ───

    document.getElementById('btn-bridge-history').addEventListener('click', async () => {
      await loadBridgeHistory();
    });

    async function loadBridgeHistory(days = 30) {
      const xckAddress = walletKeys.address;

      try {
        const response = await fetch(
          `https://bridge.xcashlabs.org/api/bridge/requests?xck_address=${encodeURIComponent(xckAddress)}&days=${days}`
        );

        const data = await response.json();

        if (!data.ok) {
          alert(data.error || 'Unable to load bridge history.');
          return;
        }

        showBridgeHistory(data.requests || []);
      } catch (err) {
        alert(err.message || 'Unable to load bridge history.');
      }
    }

    function showBridgeHistory(requests) {
      const list = document.getElementById('bridge-history-list');

      list.innerHTML = '';

      if (!requests.length) {
        list.innerHTML = `
        <div class="bridge-history-empty">
          No bridge requests found.
        </div>
      `;
      } else {
        requests.forEach((request) => {
          const amount = (Number(request.amount_atomic) / 1_000_000)
            .toFixed(6)
            .replace(/\.?0+$/, '');

          const date = request.created_at
            ? new Date(request.created_at).toLocaleString()
            : '';

          const xckExplorerTxUrl = request.tx_hash
            ? `https://explorer.xcashlabs.org/search?value=${encodeURIComponent(request.tx_hash)}`
            : '';

          const statusLabel = formatBridgeStatus(request.status);
          const directionLabel = formatBridgeDirection(request.direction);
          const networkLabel = formatBridgeNetwork(request.network);

          const explorerBase =
            BRIDGE_CHAINS[request.network]?.blockExplorerUrls?.[0] || '';

          const explorerTxUrl =
            request.evm_tx_hash && explorerBase
              ? `${explorerBase}/tx/${request.evm_tx_hash}`
              : '';

          const explorerLabel = explorerBase
            ? new URL(explorerBase).hostname
              .split('.')[0]
              .replace(/^./, c => c.toUpperCase())
            : 'Explorer';

          const item = document.createElement('div');
          item.className = 'bridge-history-card';

          item.innerHTML = `
          <div class="bridge-history-card-top">
            <div class="bridge-history-amount">${amount} XCK</div>
            <div class="bridge-status bridge-status-${request.status}">
              ${statusLabel}
            </div>
          </div>

          <div class="bridge-history-subtitle">
            ${networkLabel} • ${directionLabel}
          </div>

          <div class="bridge-history-row">
            <span>Created</span>
            <strong>${date}</strong>
          </div>

          ${request.tx_hash
              ? `
                <div class="bridge-history-row">
                  <span>XCK TX</span>
                  <button
                    class="bridge-copy-hash"
                    data-copy="${request.tx_hash}"
                  >
                    ${shortHash(request.tx_hash)}
                  </button>
                </div>

                <div class="bridge-history-row">
                  <span></span>
                  <a
                    href="${xckExplorerTxUrl}"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="bridge-history-link"
                  >
                    View on XCK Explorer ↗
                  </a>
                </div>
                `
              : ''
            }

          ${request.evm_tx_hash
              ? `
                <div class="bridge-history-row">
                    <span>EVM TX</span>
                    <button class="bridge-copy-hash" data-copy="${request.evm_tx_hash}">
                      ${shortHash(request.evm_tx_hash)}
                    </button>
                  </div>

                  <div class="bridge-history-row">
                    <span></span>
                    <a
                      href="${explorerTxUrl}"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="bridge-history-link"
                    >
                      View on ${explorerLabel} ↗
                    </a>
                  </div>
                `
              : ''
            }

            ${request.status === 'complete' &&
              request.direction === 'XCK_TO_WXCK'
              ? `
                  <div class="bridge-history-row">
                    <span>wXCK Token</span>
                    <button
                      class="bridge-add-token"
                      data-network="${request.network}"
                    >
                      Add to MetaMask
                    </button>
                  </div>
                `
              : ''
            }

          ${request.error
              ? `
                <div class="bridge-history-error">
                  Bridge could not be completed.
                </div>
              `
              : ''
            }
        `;

          list.appendChild(item);
        });
      }

      document.querySelectorAll('.bridge-copy-hash').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await navigator.clipboard.writeText(btn.dataset.copy);
          btn.textContent = 'Copied';
          setTimeout(() => {
            btn.textContent = shortHash(btn.dataset.copy);
          }, 1200);
        });
      });

      document.querySelectorAll('.bridge-add-token').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const originalText = btn.textContent;

          try {
            btn.disabled = true;
            btn.textContent = 'Opening MetaMask...';

            const added = await addWxckToMetaMaskHistory(
              btn.dataset.network
            );

            btn.textContent = added
              ? 'Added'
              : originalText;

          } catch (err) {
            console.error('Add wXCK token error:', err);

            alert(
              err.message ||
              'Unable to add wXCK to MetaMask.'
            );

            btn.textContent = originalText;
          } finally {
            btn.disabled = false;
          }
        });
      });

      document.getElementById('bridge-history-modal').classList.add('show');
    }

    function formatBridgeStatus(status) {
      const labels = {
        request: 'Request',
        waiting: 'Waiting',
        ready_to_claim: 'Ready to Claim',
        confirmed: 'Confirmed',
        complete: 'Complete',
        failed: 'Failed',
        cancelled: 'Cancelled'
      };

      return labels[status] || status || 'Unknown';
    }

    function formatBridgeDirection(direction) {
      if (direction === 'XCK_TO_WXCK') return 'XCK → wXCK';
      if (direction === 'WXCK_TO_XCK') return 'wXCK → XCK';
      return direction || '';
    }

    function formatBridgeNetwork(network) {
      if (!network) return '';
      return network.charAt(0).toUpperCase() + network.slice(1);
    }

    function shortHash(value) {
      if (!value || value.length <= 16) return value;
      return `${value.slice(0, 8)}...${value.slice(-8)}`;
    }

    async function addWxckToMetaMaskHistory(network) {
      if (!window.ethereum) {
        throw new Error('MetaMask is not installed.');
      }

      const normalizedNetwork = String(network || '')
        .trim()
        .toLowerCase();

      const chain = BRIDGE_CHAINS[normalizedNetwork];

      if (!chain) {
        throw new Error(
          `Unsupported bridge network: ${normalizedNetwork}`
        );
      }

      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{
            chainId: chain.chainId
          }]
        });
      } catch (err) {
        if (err.code !== 4902) {
          throw err;
        }

        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [chain]
        });

        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{
            chainId: chain.chainId
          }]
        });
      }

      return await window.ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: chain.contractAddress,
            symbol: 'wXCK',
            decimals: 6
          }
        }
      });
    }

    document.getElementById('bridge-history-close').addEventListener('click', () => {
      document.getElementById('bridge-history-modal').classList.remove('show');
    });

    // ─── BRIDGE MODAL ───

    function updateBridgeProgressLabels() {
      document.getElementById('step-claim').textContent =
        bridgeDirection === 'XCK_TO_WXCK'
          ? 'Claim wXCK'
          : 'Send XCK';

      const isXckToWxck = bridgeDirection === 'XCK_TO_WXCK';
      document.getElementById('step-claim').textContent =
        isXckToWxck ? 'Claim wXCK' : 'Send XCK';
      const displayXck = document.getElementById('display-xck');
      if (displayXck) {
        displayXck.style.visibility = isXckToWxck ? 'visible' : 'hidden';
      }
    }

    document.getElementById('bridge-refresh').addEventListener('click', async () => {
      const btn = document.getElementById('bridge-refresh');

      document.getElementById('bridge-status-text').textContent = statusText.idle;
      btn.disabled = true;
      btn.textContent = 'Refreshing...';
      try {
        await checkActiveBridgeRequest(false);
      } finally {
        btn.disabled = false;
        btn.textContent = '↻ Refresh';
      }
    });

    function setBridgeProgress(step, direction = bridgeDirection) {
      const claimStepEl = document.getElementById('step-claim');

      if (claimStepEl) {
        claimStepEl.textContent =
          direction === 'WXCK_TO_XCK'
            ? 'Send XCK'
            : 'Claim wXCK';
      }

      const steps = [
        'step-request',
        'step-waiting',
        'step-confirmed',
        'step-claim',
        'step-complete'
      ];

      const fill = document.getElementById('bridge-progress-fill');

      const progressMap = {
        idle: 0,
        request: 10,
        waiting: 35,
        confirmed: 60,
        ready_to_claim: 80,
        sending: 80,
        complete: 100,
        failed: 100,
        cancelled: 0
      };

      const stepMap = {
        idle: -1,
        request: 0,
        waiting: 1,
        confirmed: 2,
        ready_to_claim: 3,
        sending: 3,
        complete: 4,
        failed: -1,
        cancelled: -1
      };

      const safeStep = Object.prototype.hasOwnProperty.call(stepMap, step)
        ? step
        : 'idle';

      const currentIndex = stepMap[safeStep];
      fill.style.width = progressMap[safeStep] + '%';

      steps.forEach((id, index) => {
        const el = document.getElementById(id);
        if (!el) return;

        el.classList.remove('active', 'done');

        if (index < currentIndex) {
          el.classList.add('done');
        }

        if (index === currentIndex) {
          el.classList.add('active');
        }
      });
    }

    const statusText = {
      idle: 'Ready to create a new bridge request.',
      request: 'Bridge request created.',
      waiting: 'Waiting for your XCK deposit.',
      confirmed: 'Deposit confirmed.',
      ready_to_claim: 'Deposit confirmed. Claim your wXCK to complete the bridge.',
      complete: 'Bridge completed successfully.',
      failed: 'Bridge failed.',
      cancelled: 'Bridge request was cancelled.'
    };

    function formatElapsed(createdAt) {
      const seconds = Math.floor(
        (Date.now() - new Date(createdAt).getTime()) / 1000
      );
      if (seconds < 60) {
        return `Active for ${seconds}s`;
      }
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) {
        return `Active for ${minutes}m`;
      }
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        return `Active for ${hours}h`;
      }
      const days = Math.floor(hours / 24);
      return `Active for ${days}d`;
    }

    function updateBridgeClaimSection(request) {
      const claimSection = document.getElementById('bridge-claim-section');
      const claimButton = document.getElementById('bridge-claim');

      if (!claimSection || !claimButton) {
        return;
      }

      const showClaim = request?.status === 'ready_to_claim' && request?.direction === 'XCK_TO_WXCK';

      claimSection.style.display = showClaim ? 'block' : 'none';
      claimButton.style.display = showClaim ? '' : 'none';
      claimButton.disabled = !showClaim;
      claimButton.textContent = 'Claim wXCK';
    }


    function updateBridgeFromRequest(request) {
      // Progress bar
      setBridgeProgress(request.status || 'idle', request.direction);
      document.getElementById('bridge-status-text').textContent = statusText[request.status] || statusText.idle;

      const startEl = document.getElementById('bridge-start-time');

      if (startEl) {
        if (request.created_at) {
          startEl.textContent = ` • ${formatElapsed(request.created_at)}`;
        } else {
          startEl.textContent = '';
        }
      }

      // Restore amount (convert from atomic)
      document.getElementById('send-bridge-amount').value =
        (Number(request.amount_atomic) / 1_000_000).toFixed(6).replace(/\.?0+$/, '');

      // Restore selected network
      bridgeNetwork = request.network;

      document.getElementById('bridge-polygon')
        .classList.toggle(
          'bridge-network-selected',
          request.network.toLowerCase() === 'polygon'
        );

      document.getElementById('bridge-base')
        .classList.toggle(
          'bridge-network-selected',
          request.network.toLowerCase() === 'base'
        );

      // Restore direction
      bridgeDirection = request.direction;

      const arrow = document.getElementById('bridge-arrow');
      arrow.textContent =
        bridgeDirection === 'XCK_TO_WXCK' ? '⟶' : '⟵';

      updateBridgeDescription();
      updateBridgeProgressLabels();
      updateBridgeClaimSection(request);
    }

    let bridgeNetwork = 'none';
    let bridgeDirection = 'XCK_TO_WXCK';

    function resetBridgeNetworkSelection() {
      bridgeNetwork = 'none';
      bridgeDirection = 'XCK_TO_WXCK';
      document.getElementById('bridge-polygon').classList.remove('bridge-network-selected');
      document.getElementById('bridge-base').classList.remove('bridge-network-selected');
      document.getElementById('bridge-arrow').textContent = '⟶';
      document.getElementById('send-bridge-amount').value = '';
      document.getElementById('bridge-status-text').textContent = statusText.idle;
      const startEl = document.getElementById('bridge-start-time');
      if (startEl) {
        startEl.textContent = '';
      }
      document.getElementById('bridge-start').disabled = false;
      setBridgeProgress('idle');
      updateBridgeClaimSection(null);
      updateBridgeDescription();
      updateBridgeProgressLabels();
    }

    async function checkActiveBridgeRequest(showAlert = true, resetIfNone = true) {
      const xckAddress = walletKeys.address;

      const response = await fetch(
        `https://bridge.xcashlabs.org/api/bridge/active?xck_address=${encodeURIComponent(xckAddress)}`
      );

      const data = await response.json();

      if (!data.ok) {
        alert(data.error || 'Unable to check bridge status.');
        return false;
      }

      if (data.has_active_request) {

        if (showAlert) {
          alert('You already have a bridge request in progress. Click OK to view its status.');
        }

        updateBridgeFromRequest(data.request);
        document.getElementById('bridge-start').disabled = true;

        return true;
      }

      if (resetIfNone) {
        resetBridgeNetworkSelection();
      }

      document.getElementById('bridge-start').disabled = false;

      return false;
    }

    document.getElementById('btn-bridge').addEventListener('click', async () => {
      resetBridgeNetworkSelection();
      document.getElementById('bridge-modal').classList.add('show');
      const balTextBr = document.getElementById('balance-xck').textContent;
      const availElBr = document.getElementById('send-bridge-available');
      if (availElBr) {
        availElBr.textContent = balTextBr;
      }
      await checkActiveBridgeRequest();
    });

    const sendBridgeAmountEl = document.getElementById('send-bridge-amount');

    document.getElementById('bridge-close').addEventListener('click', () => {
      document.getElementById('bridge-modal').classList.remove('show');
      sendBridgeAmountEl.value = "";
    });

    // Send max — fills amount with the current balance
    document.getElementById('send-bridge-max').addEventListener('click', () => {
      const bal = document.getElementById('balance-xck').textContent;
      if (bal && bal !== '—') {
        sendBridgeAmountEl.value = bal;
      }
    });

    function updateBridgeDescription() {
      const desc = document.getElementById('bridge-description');

      if (bridgeNetwork === 'none') {
        desc.textContent = 'Select Polygon or Base to continue';
        return;
      }

      if (bridgeDirection === 'XCK_TO_WXCK') {
        desc.textContent = `Wrap XCK to ${bridgeNetwork}`;
      } else {
        desc.textContent = `Unwrap wXCK from ${bridgeNetwork}`;
      }
    }

    document.getElementById('bridge-polygon').addEventListener('click', () => {
      bridgeNetwork = 'polygon';
      document.getElementById('bridge-polygon')
        .classList.add('bridge-network-selected');
      document.getElementById('bridge-base')
        .classList.remove('bridge-network-selected');
      updateBridgeDescription();
      updateBridgeProgressLabels();
    });

    document.getElementById('bridge-base').addEventListener('click', () => {
      bridgeNetwork = 'base';
      document.getElementById('bridge-base')
        .classList.add('bridge-network-selected');
      document.getElementById('bridge-polygon')
        .classList.remove('bridge-network-selected');
      updateBridgeDescription();
      updateBridgeProgressLabels();
    });

    document.getElementById('bridge-direction-toggle').addEventListener('click', () => {
      const arrow = document.getElementById('bridge-arrow');

      if (bridgeDirection === 'XCK_TO_WXCK') {
        bridgeDirection = 'WXCK_TO_XCK';
        arrow.textContent = '⟵';
      } else {
        bridgeDirection = 'XCK_TO_WXCK';
        arrow.textContent = '⟶';
      }

      updateBridgeDescription();
      updateBridgeProgressLabels();
    });

    updateBridgeDescription();
    updateBridgeProgressLabels();

    const BRIDGE_CHAINS = {
      polygon: {
        chainId: '0x89', // 137
        chainName: 'Polygon',
        nativeCurrency: {
          name: 'POL',
          symbol: 'POL',
          decimals: 18
        },
        rpcUrls: ['https://polygon.drpc.org'],
        blockExplorerUrls: ['https://polygonscan.com'],
        contractAddress: '0x26194f4cC88FfcfbABfa22e1fAF7fE5Eb0eE802b'
      },

      base: {
        chainId: '0x2105', // 8453
        chainName: 'Base',
        nativeCurrency: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18
        },
        rpcUrls: ['https://api.developer.coinbase.com/rpc/v1/base/ncLgNbA03I6GFLCEs5VRbpQphhA954Cl'],
        blockExplorerUrls: ['https://basescan.org'],
        contractAddress: '0x26194f4cC88FfcfbABfa22e1fAF7fE5Eb0eE802b'
      }
    };

    async function connectMetaMaskForBridge() {

      if (bridgeNetwork === 'none') {
        alert('Please select Polygon or Base first.');
        return;
      }

      const amount = parseFloat(
        document.getElementById('send-bridge-amount').value.trim()
      );

      if (!Number.isFinite(amount) || amount <= 0) {
        alert('Please enter an amount greater than 0 XCK.');
        document.getElementById('send-bridge-amount').focus();
        return;
      }

      if (bridgeDirection === 'XCK_TO_WXCK') {

        const available = parseFloat(
          document.getElementById('send-bridge-available').textContent.replace(/,/g, '')
        );

        if (Number.isFinite(available) && amount > available) {
          alert('The amount exceeds your available XCK balance.');
          document.getElementById('send-bridge-amount').focus();
          return;
        }
      }

      const atomicAmount = BigInt(Math.round(amount * 1_000_000));

      if (!window.ethereum) {
        alert('MetaMask is not installed. Please install MetaMask to use the bridge.');
        return;
      }

      const chain = BRIDGE_CHAINS[bridgeNetwork];

      if (!chain) {
        alert(`Unsupported bridge network: ${bridgeNetwork}`);
        return;
      }

      try {
        const accounts = await window.ethereum.request({
          method: 'eth_requestAccounts'
        });

        const evmAddress = accounts?.[0];

        if (!evmAddress) {
          throw new Error('No MetaMask account connected.');
        }

        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: chain.chainId }]
        });

        const actualChainId = await window.ethereum.request({
          method: 'eth_chainId'
        });

        if (actualChainId.toLowerCase() !== chain.chainId.toLowerCase()) {
          throw new Error(
            `MetaMask did not switch networks. Expected ${chain.chainId}, got ${actualChainId}`
          );
        }

        const hasActiveRequest = await checkActiveBridgeRequest(false, false);

        if (hasActiveRequest) {
          return;
        }

        const response = await fetch('https://bridge.xcashlabs.org/api/bridge/request', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            xck_address: walletKeys.address,
            evm_address: evmAddress,
            network: bridgeNetwork,
            direction: bridgeDirection,
            amount_atomic: atomicAmount.toString()
          })
        });

        const text = await response.text();

        let result;
        try {
          result = JSON.parse(text);
        } catch {
          throw new Error('Bridge server did not return valid JSON.');
        }

        if (!response.ok) {
          throw new Error(result.error || 'Bridge request failed.');
        }

        setBridgeProgress('request');
        document.getElementById('bridge-status-text').textContent = statusText.request;

        if (bridgeDirection === 'XCK_TO_WXCK') {
          openSendModalForBridge({
            bridgeId: result.bridge_id,
            amountXck: amount.toString(),
            network: bridgeNetwork
          });
        } else {
          try {
            await burnWxckForBridge({
              bridgeId: result.bridge_id,
              amountAtomic: atomicAmount.toString(),
              xckAddress: walletKeys.address
            });
          } catch (burnErr) {

            const endpoint =
              burnErr.code === 4001
                ? 'cancel'
                : 'failed';

            await fetch(
              `https://bridge.xcashlabs.org/api/bridge/request/${result.bridge_id}/${endpoint}`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  error: burnErr.message || 'wXCK burn failed'
                })
              }
            );

            throw burnErr;
          }
        }
      } catch (err) {
        if (err.code === 4902) {
          try {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [chain]
            });

            return await connectMetaMaskForBridge();
          } catch (addErr) {
            console.error('Failed to add network:', addErr);

            alert(
              addErr?.message ||
              `Could not add ${bridgeNetwork} to MetaMask.`
            );
          }

          return;
        }

        console.error('Bridge start error:', err);

        alert(
          err?.shortMessage ||
          err?.reason ||
          err?.message ||
          'MetaMask connection or network switch was cancelled.'
        );
      }
    }

    async function addWxckToMetaMask(contractAddress) {
      if (!window.ethereum) {
        return;
      }

      try {
        await window.ethereum.request({
          method: 'wallet_watchAsset',
          params: {
            type: 'ERC20',
            options: {
              address: contractAddress,
              symbol: 'wXCK',
              decimals: 6
            }
          }
        });
      } catch (err) {
        // Adding the token is optional and must not affect the completed claim.
        console.warn('Unable to add wXCK to MetaMask:', err);
      }
    }

    document.getElementById('bridge-start').addEventListener('click', connectMetaMaskForBridge);

    async function ensureBridgeNetwork(network) {
      if (!window.ethereum) {
        throw new Error('MetaMask is not installed.');
      }

      const normalizedNetwork = String(network || '')
        .trim()
        .toLowerCase();

      const chain = BRIDGE_CHAINS[normalizedNetwork];

      if (!chain) {
        throw new Error(
          `Unsupported bridge network: ${normalizedNetwork}`
        );
      }

      const expectedChainId = chain.chainId.toLowerCase();

      let currentChainId = await window.ethereum.request({
        method: 'eth_chainId'
      });

      if (currentChainId.toLowerCase() === expectedChainId) {
        return chain;
      }

      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{
            chainId: chain.chainId
          }]
        });
      } catch (err) {
        if (err.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [chain]
          });

          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{
              chainId: chain.chainId
            }]
          });
        } else if (err.code === 4001) {
          throw new Error(
            `Please approve the switch to ${chain.chainName} in MetaMask.`
          );
        } else {
          throw err;
        }
      }

      // MetaMask may resolve wallet_switchEthereumChain before every provider
      // and extension view has fully updated. Poll until the requested chain is
      // actually reported, or fail rather than continuing on the wrong chain.
      let switched = false;

      for (let attempt = 0; attempt < 15; attempt++) {
        currentChainId = await window.ethereum.request({
          method: 'eth_chainId'
        });

        if (currentChainId.toLowerCase() === expectedChainId) {
          switched = true;
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      if (!switched) {
        throw new Error(
          `MetaMask did not finish switching to ${chain.chainName}. ` +
          `Please select ${chain.chainName} manually and try again.`
        );
      }

      return chain;
    }

    document.getElementById('bridge-claim').addEventListener('click', async () => {
      const claimButton = document.getElementById('bridge-claim');

      try {
        claimButton.disabled = true;
        claimButton.textContent = 'Claiming...';

        const active = await fetch(
          `https://bridge.xcashlabs.org/api/bridge/active?xck_address=${encodeURIComponent(walletKeys.address)}`
        ).then(r => r.json());

        if (!active.ok || !active.has_active_request) {
          throw new Error(active.error || 'No active bridge request found.');
        }

        const request = active.request;

        if (request.status !== 'ready_to_claim') {
          throw new Error('Bridge request is not ready to claim.');
        }

        const claimResponse = await fetch(
          `https://bridge.xcashlabs.org/api/bridge/request/${request._id}/claim`,
          { method: 'POST' }
        );

        const claimData = await claimResponse.json();

        if (!claimResponse.ok || !claimData.ok) {
          throw new Error(claimData.error || 'Unable to create claim.');
        }

        const claim = claimData.claim;

        if (!window.ethereum) {
          throw new Error('MetaMask is not installed.');
        }

        await window.ethereum.request({
          method: 'eth_requestAccounts'
        });

        const claimChain = await ensureBridgeNetwork(request.network);

        // Give MetaMask a moment to finish updating its provider state.
        await new Promise(resolve => setTimeout(resolve, 500));

        // Create a completely fresh provider after the network switch.
        // "any" allows ethers to handle an EIP-1193 chain change cleanly.
        const provider = new ethers.BrowserProvider(
          window.ethereum,
          'any'
        );

        const providerNetwork = await provider.getNetwork();
        const expectedChainId = BigInt(claimChain.chainId);

        if (providerNetwork.chainId !== expectedChainId) {
          throw new Error(
            `Wallet provider is still connected to chain ` +
            `${providerNetwork.chainId.toString()}. ` +
            `Please switch MetaMask to ${claimChain.chainName} and try again.`
          );
        }

        const signer = await provider.getSigner();

        const connectedAddress = ethers.getAddress(await signer.getAddress());
        const expectedAddress = ethers.getAddress(claim.recipient);

        if (connectedAddress !== expectedAddress) {
          throw new Error(
            `Wrong MetaMask account. Please switch MetaMask to ${claim.recipient} and try again.`
          );
        }

        const abi = [
          'function claim(bytes32 bridgeId, uint256 amount, uint256 deadline, bytes signature)'
        ];

        const contract = new ethers.Contract(
          claim.contractAddress,
          abi,
          signer
        );

        const tx = await contract.claim(
          claim.bridgeId,
          BigInt(claim.amount),
          BigInt(claim.deadline),
          claim.signature
        );

        const receipt = await tx.wait();

        const completeResponse = await fetch(
          `https://bridge.xcashlabs.org/api/bridge/request/${request._id}/complete`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              evm_tx_hash: receipt.hash
            })
          }
        );

        const completeData = await completeResponse.json();

        if (!completeResponse.ok || !completeData.ok) {
          throw new Error(completeData.error || 'Claim succeeded, but bridge status was not updated.');
        }

        await checkActiveBridgeRequest(false);
        const addToken = confirm(
          'wXCK claimed successfully.\n\n' +
          'Add wXCK to MetaMask?\n\n' +
          '(OK = Add Token, Cancel = Continue. This only needs to be done once per wallet.)'
        );

        if (addToken) {
          await addWxckToMetaMask(claim.contractAddress);
        }

        document.getElementById('send-bridge-amount').value = '';
        document.getElementById('bridge-status-text').textContent = '';
        setBridgeProgress('idle');
        updateBridgeClaimSection(null);
        await checkActiveBridgeRequest(false);

        if (typeof pollBalanceOnce === 'function') {
          await pollBalanceOnce();
        }

      } catch (err) {
        console.error('Claim error:', err);

        let message =
          err?.shortMessage ||
          err?.reason ||
          err?.message ||
          'Claim failed.';

        if (
          message.includes('unknown custom error') ||
          message.includes('execution reverted')
        ) {
          message =
            'The claim was rejected by the smart contract.\n\n' +
            'Possible reasons include:\n' +
            '• This bridge request has already been claimed.\n' +
            '• The claim has expired.\n' +
            '• The claim signature is invalid.\n' +
            '• The claim amount is invalid.\n' +
            '• The wXCK contract is currently paused.'
        }

        alert(message);

      } finally {
        claimButton.disabled = false;
        claimButton.textContent = 'Claim wXCK';
      }
    });

    async function burnWxckForBridge({ bridgeId, amountAtomic, xckAddress }) {
      const chain = BRIDGE_CHAINS[bridgeNetwork];

      if (!chain || !chain.contractAddress) {
        throw new Error(`Bridge contract is not configured for ${bridgeNetwork}.`);
      }

      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const abi = [
        "function bridgeBurn(bytes32 bridgeId, uint256 amount, string calldata xckAddress)"
      ];

      const contract = new ethers.Contract(
        chain.contractAddress,
        abi,
        signer
      );

      const bridgeIdBytes32 = ethers.keccak256(
        ethers.toUtf8Bytes(String(bridgeId))
      );

      const tx = await contract.bridgeBurn(
        bridgeIdBytes32,
        amountAtomic,
        xckAddress
      );

      const receipt = await tx.wait();

      const response = await fetch(
        `https://bridge.xcashlabs.org/api/bridge/request/${bridgeId}/tx`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tx_hash: receipt.hash,
            xck_address: xckAddress
          })
        }
      );

      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Unable to submit burn transaction.");
      }

      return result;
    }

    // ─── SEND MODAL ───
    // Multi-step: form → confirm → result. All three steps live inside
    // #send-modal; we toggle their visibility on transition.
    let sendPreview = null;      // cached fee estimate from Review step
    let sendPrivacy = 'private';
    let sendPriority = 2;

    // Bridge send state
    let bridgeSendContext = null;
    let bridgeSendSubmitted = false;
    const BRIDGE_XCK_DEPOSIT_ADDRESSES = {
      polygon:
        'XCK1QnoyBeAVBuXHYJB1rcYj8EPjadaB45iTPP6ypK6r1VHjXjrnt4zRCcDf6X1PwD4EBz9b9PzJq3dKJfLiHJBD6aNNzaMCQQ',
      base:
        'XCK1fL5wznJNTPQm9VYfQ1MyM6woYuw39Ce7WScmLddaHLPfxGwjBNiBTELmFA4GzbYFrZQoRtaXLa21gjmq1ANH53kr7Nf5wC'
    };

    function sendShowStep(step) {
      ['form', 'confirm', 'result'].forEach(s => {
        const el = document.getElementById('send-step-' + s);
        if (el) el.style.display = (s === step) ? '' : 'none';
      });
    }
    function sendShowResultState(state) {
      ['pending', 'success', 'error'].forEach(s => {
        const el = document.getElementById('send-result-' + s);
        if (el) el.style.display = (s === state) ? '' : 'none';
      });
    }
    function sendResetForm() {
      sendPreview = null;
      const errEl = document.getElementById('send-error');
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
      sendShowStep('form');
    }

    async function cancelPendingBridgeSend(reason) {
      if (
        !bridgeSendContext?.bridgeId ||
        bridgeSendSubmitted
      ) {
        return;
      }

      const bridgeId = bridgeSendContext.bridgeId;

      try {
        const response = await fetch(
          `https://bridge.xcashlabs.org/api/bridge/request/${bridgeId}/cancel`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              error: reason || 'Bridge request cancelled by user'
            })
          }
        );

        const result = await response.json().catch(() => ({}));

        if (!response.ok || result.ok === false) {
          throw new Error(
            result.error || 'Unable to cancel bridge request'
          );
        }
      } catch (err) {
        console.error(
          'Failed to cancel bridge request:',
          err
        );
      } finally {
        bridgeSendContext = null;
        bridgeSendSubmitted = false;
      }
    }

    function openSendModalForBridge({
      bridgeId,
      amountXck,
      network
    }) {
      const depositAddress =
        BRIDGE_XCK_DEPOSIT_ADDRESSES[network];

      if (!depositAddress) {
        throw new Error(
          `No XCK bridge deposit address configured for ${network}.`
        );
      }

      bridgeSendContext = {
        bridgeId,
        network
      };

      bridgeSendSubmitted = false;
      sendResetForm();

      sendToEl.value = depositAddress;
      sendAmountEl.value = amountXck;

      sendPrivacy = 'private';

      document.querySelectorAll('.send-priv-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.privacy === 'public');
      });

      refreshSendReviewState();
      document.getElementById('bridge-modal').classList.remove('show');
      document.getElementById('send-modal').classList.add('show');

      sendReviewBtn.click();
    }

    document.getElementById('btn-send').addEventListener('click', () => {
      sendResetForm();
      document.getElementById('send-modal').classList.add('show');
      // Update "Available" from the latest LWS poll
      const balText = document.getElementById('balance-xck').textContent;
      const availEl = document.getElementById('send-available');
      if (availEl) availEl.textContent = balText;
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

    document.getElementById('send-close').addEventListener('click', async () => {
      await cancelPendingBridgeSend('Bridge request cancelled before XCK was sent');
      document.getElementById('send-modal').classList.remove('show');
      sendAmountEl.value = "";
    });

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
      const bal = document.getElementById('balance-xck').textContent;
      if (bal && bal !== '—') {
        sendAmountEl.value = bal;
        refreshSendReviewState();
      }
    });

    // Cancel
    document.getElementById('send-cancel').addEventListener('click', async () => {
      await cancelPendingBridgeSend('Bridge request cancelled before XCK was sent');
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

        if (bridgeSendContext) {
          bridgeSendSubmitted = true;
        }

        document.getElementById('send-result-hash').textContent = result.tx_hash;

        if (bridgeSendContext) {
          try {
            const res = await fetch(
              `https://bridge.xcashlabs.org/api/bridge/request/${bridgeSendContext.bridgeId}/tx`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  tx_hash: result.tx_hash,
                  xck_address: walletKeys.address
                })
              }
            );

            const data = await res.json().catch(() => ({}));

            if (!res.ok || data.ok === false) {
              throw new Error(data.error || `Bridge tx attach failed: ${res.status}`);
            }

          } catch (err) {
            console.error('Bridge tx failed, manual intervention will be needed:', err);
            // Do NOT cancel here. The XCK transaction was already sent.
          }
        }

        sendShowResultState('success');
        // Trigger a balance refresh so the new pending tx shows up
        if (typeof pollBalanceOnce === 'function') setTimeout(pollBalanceOnce, 2000);
      } catch (e) {
        console.error('[dashboard] send failed:', e);
        if (bridgeSendContext?.bridgeId) {
          try {
            await fetch(
              `https://bridge.xcashlabs.org/api/bridge/request/${bridgeSendContext.bridgeId}/cancel`,
              { method: 'POST' }
            );
          } catch (cancelErr) {
            console.error('Failed to cancel bridge request:', cancelErr);
          }
          bridgeSendContext = null;
        }
        document.getElementById('send-result-error-msg').textContent =
          e.message || 'Unknown error';
        sendShowResultState('error');
      }
    });

    // Result: Done → close modal
    document.getElementById('send-done').addEventListener('click', () => {
      document.getElementById('send-modal').classList.remove('show');
      sendResetForm();
      sendToEl.value = '';
      sendAmountEl.value = '';

      if (bridgeSendContext) {
        document.getElementById('bridge-modal').classList.add('show');
      }

      bridgeSendContext = null;
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
        const size = 220;       // pixel size of the rendered SVG
        const quiet = 2;         // quiet-zone modules around the code
        const total = count + quiet * 2;
        const cell = size / total;

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
        privateViewKeyHex: walletKeys.privateViewKeyHex,
        publicSpendKeyHex: walletKeys.publicSpendKeyHex || null,
        publicViewKeyHex: walletKeys.publicViewKeyHex,
      };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
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
