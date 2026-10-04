/* DRYHOLE — nft.js
 * Detects the NFTs held by a wallet (read-only, no transactions) for:
 *   v1 = DRY HOLE       https://opensea.io/collection/dry-hole-950530788
 *   v2 = DRYHOLE Genesis https://opensea.io/collection/dryhole-genesis
 *
 * API global:
 *   DrillNFT.getUserNFTs(address, 'v1' | 'v2') -> Promise<[{id, version}]>
 *   DrillNFT.getTokenInfo(id)                  -> Promise<{id, name, images[], uri, err}>
 *   DrillNFT.getContract('v1' | 'v2')          -> contract address
 *   DrillNFT.isConfigured('v1' | 'v2')         -> boolean
 */
(function (global) {
  'use strict';

  var CONTRACTS = {
    v1: '0xaE7655BcD2aeda4D9C45BB36A01cCB2d26240fF6', // DRY HOLE contract address (ERC-721) on Robinhood Chain
    v2: '0xeb182881Ade47070a94c1cd5Fdc837Ee92603770' // DRYHOLE Genesis contract address (ERC-721) on Robinhood Chain
  };

  var RPC_URLS = ['https://rpc.mainnet.chain.robinhood.com'];
  var BLOCKSCOUT = 'https://robinhoodchain.blockscout.com';
  var IPFS_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://nftstorage.link/ipfs/', 'https://dweb.link/ipfs/'];
  var MAX_SCAN = 5000; // safety limit for the on-chain (enumerable) path
  var RPC_CONCURRENCY = 6;  // parallel eth_call at once (avoids RPC rate limit)
  var INFO_CONCURRENCY = 4; // parallel metadata loads at once

  /* id -> last detected version, so getTokenInfo(id) knows which contract to read */
  var idVersion = {};
  var infoCache = {};

  function norm(a) { return String(a || '').toLowerCase(); }
  function isAddr(a) { return /^0x[0-9a-fA-F]{40}$/.test(a || ''); }
  function isConfigured(v) { return isAddr(CONTRACTS[v]); }
  function getContract(v) { return CONTRACTS[v] || ''; }

  function need(v) {
    if (!v) throw new Error('NO VERSION');
    if (v !== 'v1' && v !== 'v2') throw new Error('Unknown version: ' + v);
    if (!isConfigured(v)) throw new Error(v.toUpperCase() + ' contract address is not set in nft.js');
  }

  function fetchJson(url, opts, timeoutMs) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 8000) : null;
    var o = opts || {};
    if (ctl) o.signal = ctl.signal;
    function done() { if (t) clearTimeout(t); }
    return fetch(url, o).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json(); // timer stays active until the body is read
    }).then(function (j) { done(); return j; }, function (e) { done(); throw e; });
  }

  /* Run task functions with a max number in flight. Results keep their order. */
  function pool(tasks, limit) {
    var res = new Array(tasks.length), i = 0, workers = [];
    function worker() {
      if (i >= tasks.length) return Promise.resolve();
      var k = i++;
      return tasks[k]().then(function (v) { res[k] = v; }).then(worker);
    }
    for (var w = 0; w < Math.min(limit, tasks.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () { return res; });
  }

  /* ---------- JSON-RPC (no library) ---------- */
  var rpcId = 1;
  function rpc(method, params) {
    var i = 0;
    function attempt() {
      return fetchJson(RPC_URLS[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: method, params: params })
      }).then(function (j) {
        if (j.error) throw new Error(j.error.message || 'RPC error');
        return j.result;
      }).catch(function (e) {
        i++;
        if (i < RPC_URLS.length) return attempt();
        throw e;
      });
    }
    return attempt();
  }
  function pad32(hex) { hex = hex.replace(/^0x/, ''); return new Array(65 - hex.length).join('0') + hex; }
  function ethCall(to, data) { return rpc('eth_call', [{ to: to, data: data }, 'latest']); }
  function hexToNum(h) { return h && h !== '0x' ? parseInt(h, 16) : 0; }
  function decodeString(hex) {
    hex = (hex || '').replace(/^0x/, '');
    if (hex.length < 128) return '';
    var len = parseInt(hex.slice(64, 128), 16);
    var body = hex.slice(128, 128 + len * 2);
    var bytes = [];
    for (var k = 0; k < body.length; k += 2) bytes.push(parseInt(body.substr(k, 2), 16));
    try { return decodeURIComponent(escape(String.fromCharCode.apply(null, bytes))); }
    catch (e) { return String.fromCharCode.apply(null, bytes); }
  }

  var DEBUG = /[?&]debug=1/.test(global.location ? global.location.search : '');
  function log() { if (DEBUG && global.console) console.log.apply(console, ['[nft.js]'].concat([].slice.call(arguments))); }

  function withTimeout(p, ms, msg) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(msg)); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  /* Step 0: balanceOf(owner) - fast, works for any ERC-721 */
  function balanceOf(addr, contract) {
    return ethCall(contract, '0x70a08231' + pad32(addr)).then(hexToNum);
  }

  /* Path A: ERC721Enumerable (tokenOfOwnerByIndex) - throttled */
  function viaEnumerable(addr, contract, count) {
    var n = Math.min(count, MAX_SCAN), tasks = [];
    for (var i = 0; i < n; i++) (function (i) {
      tasks.push(function () { return ethCall(contract, '0x2f745c59' + pad32(addr) + pad32(i.toString(16))); });
    })(i);
    return pool(tasks, RPC_CONCURRENCY).then(function (rs) {
      return rs.map(function (h) { return { id: String(parseInt(h, 16)) }; });
    });
  }

  /* Path B: Blockscout API - stops as soon as the known balance has been found */
  function viaBlockscout(addr, contract, count) {
    var found = [], seen = {}, target = norm(contract);
    function page(params, n) {
      var url = BLOCKSCOUT + '/api/v2/addresses/' + addr + '/nft?type=ERC-721' + (params ? '&' + params : '');
      return fetchJson(url).then(function (j) {
        (j.items || []).forEach(function (it) {
          var tok = it.token || {};
          if (norm(tok.address_hash || tok.address) === target && it.id != null && !seen[it.id]) {
            seen[it.id] = 1;
            found.push({ id: String(it.id) });
          }
        });
        var np = j.next_page_params;
        if (np && found.length < count && n < 40) {
          var q = Object.keys(np).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(np[k]); }).join('&');
          return page(q, n + 1);
        }
      });
    }
    return page('', 0).then(function () { return found; });
  }

  /* Path C: Transfer logs to the owner, then verify with ownerOf - throttled */
  var TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  function viaLogs(addr, contract) {
    return rpc('eth_getLogs', [{
      address: contract, fromBlock: '0x0', toBlock: 'latest',
      topics: [TRANSFER_SIG, null, '0x' + pad32(addr)]
    }]).then(function (logs) {
      var ids = {}, list = [];
      (logs || []).forEach(function (l) {
        if (l.topics && l.topics.length === 4 && !ids[l.topics[3]]) { ids[l.topics[3]] = 1; list.push(l.topics[3]); }
      });
      list = list.slice(0, 500);
      return pool(list.map(function (t) {
        return function () {
          return ethCall(contract, '0x6352211e' + t.replace(/^0x/, '')).then(function (o) {
            return norm('0x' + o.slice(-40)) === norm(addr) ? { id: String(parseInt(t, 16)) } : null;
          }).catch(function () { return null; });
        };
      }), RPC_CONCURRENCY);
    }).then(function (r) { return r.filter(Boolean); });
  }

  function sortIds(list) {
    return list.sort(function (a, b) {
      var x = Number(a.id), y = Number(b.id);
      return (isNaN(x) || isNaN(y)) ? String(a.id).localeCompare(String(b.id)) : x - y;
    });
  }

  function detect(address, version) {
    need(version);
    if (!isAddr(address)) throw new Error('Invalid wallet address');
    var contract = CONTRACTS[version];
    return balanceOf(address, contract).catch(function () {
      throw new Error('Cannot read ' + version.toUpperCase() + ' contract (is it an ERC-721 on Robinhood Chain?)');
    }).then(function (bal) {
      log(version, 'balance', bal);
      if (!bal) return [];
      // Blockscout first: ~50 tokens per request, much faster than 1 eth_call per token
      var paths = [
        ['blockscout', function () { return viaBlockscout(address, contract, bal); }],
        ['enumerable', function () { return viaEnumerable(address, contract, bal); }],
        ['logs', function () { return viaLogs(address, contract); }]
      ];
      var i = 0;
      function next() {
        if (i >= paths.length) throw new Error('Found balance ' + bal + ' but could not list token IDs');
        var p = paths[i++];
        return p[1]().then(function (items) {
          log('path', p[0], 'returned', items.length);
          if (!items.length) return next();
          return items;
        }, function (e) {
          log('path', p[0], 'failed', e && e.message);
          return next();
        });
      }
      return next();
    });
  }

  function getUserNFTs(address, version) {
    return withTimeout(Promise.resolve().then(function () { return detect(address, version); }), 45000, 'Timed out reading NFTs')
      .then(function (items) {
        var seen = {}, out = [];
        items.forEach(function (it) {
          if (seen[it.id]) return;
          seen[it.id] = 1;
          idVersion[it.id] = version;
          out.push({ id: it.id, version: version });
        });
        return sortIds(out);
      });
  }

  /* ---------- Metadata ---------- */
  function resolveUri(u) {
    if (!u) return [];
    if (u.indexOf('ipfs://') === 0) {
      var path = u.replace('ipfs://', '').replace(/^ipfs\//, '');
      return IPFS_GATEWAYS.map(function (g) { return g + path; });
    }
    return [u];
  }
  function parseTokenUri(uri) {
    if (uri.indexOf('data:application/json;base64,') === 0) {
      try { return Promise.resolve(JSON.parse(decodeURIComponent(escape(atob(uri.split(',')[1]))))); }
      catch (e) { return Promise.reject(e); }
    }
    if (uri.indexOf('data:application/json,') === 0) {
      try { return Promise.resolve(JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(',') + 1)))); }
      catch (e2) { return Promise.reject(e2); }
    }
    var urls = resolveUri(uri), i = 0;
    function next() {
      return fetchJson(urls[i]).catch(function (e) { log('uri failed', urls[i], e && e.message); i++; if (i < urls.length) return next(); throw e; });
    }
    return next();
  }

  /* Fallback: Blockscout already indexes the metadata (CORS-friendly) */
  function viaBlockscoutMeta(contract, id) {
    return fetchJson(BLOCKSCOUT + '/api/v2/tokens/' + contract + '/instances/' + id).then(function (j) {
      var m = j.metadata || {};
      var img = j.image_url || m.image || m.image_url || m.imageUrl || '';
      if (!img && !m.name) throw new Error('NO META');
      return { name: m.name, images: resolveUri(img) };
    });
  }

  /* Limit how many metadata loads run at the same time */
  var active = 0, queue = [];
  function pump() {
    while (active < INFO_CONCURRENCY && queue.length) queue.shift()();
  }
  function gate(fn) {
    return new Promise(function (resolve, reject) {
      queue.push(function () {
        active++;
        fn().then(resolve, reject).then(function () { active--; pump(); });
      });
      pump();
    });
  }

  function getTokenInfo(id) {
    id = String(id);
    if (infoCache[id]) return infoCache[id];
    var version = idVersion[id] || global.DrillVersion;
    var p = gate(function () {
      return Promise.resolve().then(function () {
        need(version);
        var contract = CONTRACTS[version];
        return ethCall(contract, '0xc87b56dd' + pad32(BigInt(id).toString(16))).then(function (hex) {
          var uri = decodeString(hex);
          if (!uri) throw new Error('NO URI');
          log('tokenURI', id, uri);
          return parseTokenUri(uri).then(function (meta) {
            var img = meta.image || meta.image_url || meta.imageUrl || '';
            return {
              id: id, version: version, uri: uri,
              name: meta.name || ('#' + id),
              images: resolveUri(img)
            };
          }).catch(function (e) {
            return viaBlockscoutMeta(contract, id).then(function (m) {
              log('blockscout meta used for', id);
              return { id: id, version: version, uri: uri, name: m.name || ('#' + id), images: m.images };
            }, function () { throw e; });
          });
        });
      });
    }).catch(function (e) {
      delete infoCache[id]; // do not cache failures
      return { id: id, version: version, uri: '', name: '#' + id, images: [], err: String((e && e.message) || 'ERR').slice(0, 24).toUpperCase() };
    });
    infoCache[id] = p;
    return p;
  }

  global.DrillNFT = {
    getUserNFTs: getUserNFTs,
    getTokenInfo: getTokenInfo,
    getContract: getContract,
    isConfigured: isConfigured
  };
})(window);
