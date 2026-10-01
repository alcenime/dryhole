// nft.js - detects the connected user's DRILL NFTs (no libraries, plain fetch to the chain RPC)
(function () {
  const CONTRACT = "0xae7655bcd2aeda4d9c45bb36a01ccb2d26240ff6";
  // Robinhood Chain mainnet, chainId 4663 (0x1237).
  // Order = priority. If one fails or rate-limits, the next one is used.
  // For production, put a dedicated provider RPC (Alchemy, QuickNode, dRPC...) first.
  const RPCS = [
    "https://rpc.mainnet.chain.robinhood.com",
    "https://rpc.nodeflare.app/robinhood/public",
  ];
  const BATCH = 50; // initial batch size, shrinks automatically if the RPC rejects it
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const GATEWAYS = [
    "https://ipfs.io/ipfs/",
    "https://dweb.link/ipfs/",
    "https://w3s.link/ipfs/",
    "https://gateway.pinata.cloud/ipfs/",
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

  // ---------- RPC ----------
  // Sends one JSON-RPC payload (object or array) with retry + fallback endpoints.
  async function rpc(payload) {
    const body = JSON.stringify(payload);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const url of RPCS) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          if (!res.ok) throw new Error("RPC HTTP " + res.status);
          return await res.json();
        } catch (e) {
          lastErr = e;
          console.warn("[DrillNFT] RPC request failed:", url, e);
        }
      }
      await sleep(700 * (attempt + 1));
    }
    const m = (lastErr && lastErr.message) || "";
    throw new Error(
      /failed to fetch|networkerror|load failed/i.test(m)
        ? "RPC request blocked or rate-limited. Please try again in a moment."
        : m || "RPC request failed"
    );
  }

  async function ethCallBatch(datas) {
    const json = await rpc(
      datas.map((d, i) => ({
        jsonrpc: "2.0",
        id: i,
        method: "eth_call",
        params: [{ to: CONTRACT, data: d }, "latest"],
      }))
    );
    if (!Array.isArray(json)) {
      throw new Error("RPC error: " + ((json && json.error && json.error.message) || "bad response"));
    }
    json.sort((a, b) => a.id - b.id);
    return json; // per-item .error is normal here (e.g. ownerOf on a token that does not exist)
  }

  async function ethCall(data) {
    const [r] = await ethCallBatch([data]);
    if (r.error) throw new Error(r.error.message);
    return r.result;
  }

  function decodeString(hex) {
    const h = hex.replace(/^0x/, "");
    const len = parseInt(h.slice(64, 128), 16);
    const bytes = h.slice(128, 128 + len * 2).match(/.{2}/g) || [];
    return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))));
  }

  // ---------- Metadata ----------
  // Turns any token/image URI into a list of candidate URLs (IPFS gateway fallback).
  function candidates(u) {
    if (!u || typeof u !== "string") return [];
    u = u.trim();
    if (u.startsWith("data:")) return [u];
    if (u.startsWith("ar://")) return ["https://arweave.net/" + u.slice(5)];
    let path = null;
    if (u.startsWith("ipfs://")) path = u.slice(7).replace(/^ipfs\//, "");
    else {
      const m = u.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/i);
      if (m) path = m[1];
    }
    if (path) {
      const list = GATEWAYS.map((g) => g + path);
      if (/^https?:/i.test(u)) list.unshift(u);
      return list;
    }
    return /^https?:\/\//i.test(u) ? [u] : [];
  }

  async function fetchTimeout(url, ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      return await fetch(url, { signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchJson(uri) {
    if (uri.startsWith("data:")) {
      const head = uri.slice(0, uri.indexOf(","));
      const body = uri.slice(uri.indexOf(",") + 1);
      return JSON.parse(/;base64/i.test(head) ? atob(body) : decodeURIComponent(body));
    }
    let lastErr;
    for (const url of candidates(uri)) {
      try {
        const r = await fetchTimeout(url, 8000);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return await r.json();
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("no usable URL");
  }

  // Limit how many metadata requests run at once
  let running = 0;
  const queue = [];
  function limit(fn) {
    return new Promise((res, rej) => {
      queue.push({ fn, res, rej });
      pump();
    });
  }
  function pump() {
    while (running < 6 && queue.length) {
      const j = queue.shift();
      running++;
      j.fn().then(j.res, j.rej).finally(() => {
        running--;
        pump();
      });
    }
  }

  const infoCache = new Map();
  function getTokenInfo(id) {
    if (infoCache.has(id)) return infoCache.get(id);
    const p = limit(async () => {
      let uri;
      try {
        uri = decodeString(await ethCall("0xc87b56dd" + pad(id.toString(16))));
      } catch (e) {
        return { id, name: "#" + id, images: [], err: "NO URI" };
      }
      if (!uri) return { id, name: "#" + id, images: [], err: "NO URI" };
      let meta;
      try {
        meta = await fetchJson(uri);
      } catch (e) {
        console.warn("[DrillNFT] metadata failed", id, uri, e);
        return { id, name: "#" + id, images: [], err: "META FAIL", uri };
      }
      const imgs = candidates(meta.image || meta.image_url || "").filter(
        (x) => /^https?:\/\//i.test(x) || /^data:image\//i.test(x)
      );
      return {
        id,
        name: meta.name || "#" + id,
        images: imgs,
        attributes: meta.attributes || [],
        err: imgs.length ? null : "NO IMAGE",
        uri,
      };
    });
    infoCache.set(id, p);
    // do not keep failures forever, so they can be retried
    p.then((v) => v.err && v.err !== "NO IMAGE" && infoCache.delete(id));
    return p;
  }

  // ---------- Ownership ----------
  async function getBalance(addr) {
    return parseInt(await ethCall("0x70a08231" + pad(addr)), 16);
  }
  async function getTotalSupply() {
    return parseInt(await ethCall("0x18160ddd"), 16);
  }

  // Returns the subset of `ids` currently owned by `me` (lowercase address, no 0x)
  async function filterOwned(ids, me, want) {
    const found = [];
    let size = BATCH;
    let i = 0;
    while (i < ids.length && (!want || found.length < want)) {
      const chunk = ids.slice(i, i + size);
      let res;
      try {
        res = await ethCallBatch(chunk.map((id) => "0x6352211e" + pad(id.toString(16))));
      } catch (e) {
        if (size > 10) {
          size = Math.max(10, size >> 1);
          await sleep(400);
          continue;
        }
        throw e;
      }
      res.forEach((r, k) => {
        if (r.result && r.result.slice(-40).toLowerCase() === me) found.push(chunk[k]);
      });
      i += chunk.length;
      await sleep(120);
    }
    return found;
  }

  // Fast path: one eth_getLogs call for every Transfer sent to this wallet.
  async function idsFromLogs(addr) {
    const json = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [
        {
          address: CONTRACT,
          fromBlock: "0x0",
          toBlock: "latest",
          topics: [TRANSFER_TOPIC, null, "0x" + pad(addr)],
        },
      ],
    });
    if (!json || json.error || !Array.isArray(json.result)) {
      throw new Error("getLogs not available");
    }
    const set = new Set(json.result.map((l) => parseInt(l.topics[3], 16)));
    return Array.from(set).sort((a, b) => a - b);
  }

  // Slow path: this contract is not ERC721Enumerable, so scan ownerOf over all token ids.
  async function scanAll(addr, want) {
    const supply = await getTotalSupply();
    const all = [];
    for (let id = 0; id <= supply; id++) all.push(id); // covers ids starting at 0 or 1
    return filterOwned(all, addr.toLowerCase().replace(/^0x/, ""), want);
  }

  async function getUserTokenIds(addr) {
    const want = await getBalance(addr);
    if (!want) return [];
    const me = addr.toLowerCase().replace(/^0x/, "");
    try {
      const cand = await idsFromLogs(addr);
      const owned = await filterOwned(cand, me, want);
      if (owned.length >= want) return owned;
    } catch (e) {
      console.warn("[DrillNFT] log lookup failed, falling back to full scan", e);
    }
    return scanAll(addr, want);
  }

  // Fast: returns ids only. Fetch metadata/images per token with getTokenInfo(id).
  async function getUserNFTs(addr) {
    return (await getUserTokenIds(addr)).map((id) => ({ id }));
  }

  window.DrillNFT = { CONTRACT, getBalance, getUserTokenIds, getUserNFTs, getTokenInfo };
})();
