/* DRYHOLE — nft.js
 * Deteksi NFT milik wallet (read-only, tanpa transaksi) untuk:
 *   v1 = DRY HOLE       https://opensea.io/collection/dry-hole-950530788
 *   v2 = DRYHOLE Genesis https://opensea.io/collection/dryhole-genesis
 *
 * Dipakai drill.html (classic script, sebelum wallet.js):
 *   <script src="nft.js"></script>
 *
 * API global:
 *   DrillNFT.getUserNFTs(address, 'v1' | 'v2') -> Promise<[{id, version}]>
 *   DrillNFT.getTokenInfo(id)                  -> Promise<{id, name, images[], uri, err}>
 *   DrillNFT.getContract('v1' | 'v2')          -> alamat kontrak
 *   DrillNFT.isConfigured('v1' | 'v2')         -> boolean
 *
 * WAJIB: isi alamat kontrak di CONTRACTS di bawah (lihat tab "Details" /
 * "About" koleksi di OpenSea atau Blockscout). Alamat TIDAK diisi otomatis.
 */
(function (global) {
  'use strict';

  var CONTRACTS = {
    v1: '', // alamat kontrak DRY HOLE (ERC-721) di Robinhood Chain
    v2: ''  // alamat kontrak DRYHOLE Genesis (ERC-721) di Robinhood Chain
  };

  var RPC_URLS = ['https://rpc.mainnet.chain.robinhood.com'];
  var BLOCKSCOUT = 'https://robinhoodchain.blockscout.com';
  var IPFS_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://cloudflare-ipfs.com/ipfs/', 'https://dweb.link/ipfs/'];
  var MAX_SCAN = 5000; // batas aman untuk jalur on-chain (enumerable)

  /* id -> versi terakhir yang terdeteksi, supaya getTokenInfo(id) tahu kontraknya */
  var idVersion = {};
  var infoCache = {};

  function norm(a) { return String(a || '').toLowerCase(); }
  function isAddr(a) { return /^0x[0-9a-fA-F]{40}$/.test(a || ''); }
  function isConfigured(v) { return isAddr(CONTRACTS[v]); }
  function getContract(v) { return CONTRACTS[v] || ''; }

  function need(v) {
    if (!v) throw new Error('NO VERSION');
    if (v !== 'v1' && v !== 'v2') throw new Error('Versi tidak dikenal: ' + v);
    if (!isConfigured(v)) throw new Error('Alamat kontrak ' + v.toUpperCase() + ' belum diisi di nft.js');
  }

  function fetchJson(url, opts, timeoutMs) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 12000) : null;
    var o = opts || {};
    if (ctl) o.signal = ctl.signal;
    return fetch(url, o).then(function (r) {
      if (t) clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) { if (t) clearTimeout(t); throw e; });
  }

  /* ---------- JSON-RPC (tanpa library) ---------- */
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

  /* ---------- Jalur 1: Blockscout API (mendukung non-enumerable) ---------- */
  function viaBlockscout(addr, contract) {
    var found = [];
    var target = norm(contract);
    function page(params, n) {
      var url = BLOCKSCOUT + '/api/v2/addresses/' + addr + '/nft?type=ERC-721' + (params ? '&' + params : '');
      return fetchJson(url).then(function (j) {
        (j.items || []).forEach(function (it) {
          var tok = it.token || {};
          if (norm(tok.address_hash || tok.address) === target && it.id != null) {
            found.push({ id: String(it.id), meta: it });
          }
        });
        var np = j.next_page_params;
        if (np && n < 40) {
          var q = Object.keys(np).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(np[k]); }).join('&');
          return page(q, n + 1);
        }
      });
    }
    return page('', 0).then(function () { return found; });
  }

  /* ---------- Jalur 2: on-chain ERC721Enumerable ---------- */
  function viaEnumerable(addr, contract) {
    return ethCall(contract, '0x70a08231' + pad32(addr)).then(function (bal) {
      var n = Math.min(hexToNum(bal), MAX_SCAN);
      var jobs = [];
      for (var i = 0; i < n; i++) {
        jobs.push(ethCall(contract, '0x2f745c59' + pad32(addr) + pad32(i.toString(16))));
      }
      return Promise.all(jobs).then(function (rs) {
        return rs.map(function (h) { return { id: String(parseInt(h, 16)) }; });
      });
    });
  }

  function sortIds(list) {
    return list.sort(function (a, b) {
      var x = Number(a.id), y = Number(b.id);
      return (isNaN(x) || isNaN(y)) ? String(a.id).localeCompare(String(b.id)) : x - y;
    });
  }

  function getUserNFTs(address, version) {
    return Promise.resolve().then(function () {
      need(version);
      if (!isAddr(address)) throw new Error('Alamat wallet tidak valid');
      var contract = CONTRACTS[version];
      return viaBlockscout(address, contract).catch(function () {
        return viaEnumerable(address, contract); // fallback bila Blockscout gagal / CORS
      }).then(function (items) {
        var seen = {}, out = [];
        items.forEach(function (it) {
          if (seen[it.id]) return;
          seen[it.id] = 1;
          idVersion[it.id] = version;
          out.push({ id: it.id, version: version });
        });
        return sortIds(out);
      });
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
      return fetchJson(urls[i]).catch(function (e) { i++; if (i < urls.length) return next(); throw e; });
    }
    return next();
  }

  function getTokenInfo(id) {
    id = String(id);
    if (infoCache[id]) return infoCache[id];
    var version = idVersion[id] || global.DrillVersion;
    var p = Promise.resolve().then(function () {
      need(version);
      var contract = CONTRACTS[version];
      return ethCall(contract, '0xc87b56dd' + pad32(BigInt(id).toString(16))).then(function (hex) {
        var uri = decodeString(hex);
        if (!uri) throw new Error('NO URI');
        return parseTokenUri(uri).then(function (meta) {
          var img = meta.image || meta.image_url || meta.imageUrl || '';
          return {
            id: id, version: version, uri: uri,
            name: meta.name || ('#' + id),
            images: resolveUri(img)
          };
        });
      });
    }).catch(function (e) {
      delete infoCache[id]; // jangan cache kegagalan
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
