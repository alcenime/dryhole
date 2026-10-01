// nft.js - deteksi NFT DRILL milik user (tanpa library, murni fetch ke RPC)
(function () {
  const CONTRACT = "0xae7655bcd2aeda4d9c45bb36a01ccb2d26240ff6";
  // chainId 4663 (0x1237). Urutan = prioritas, kalau gagal/rate-limit lanjut ke berikutnya
  const RPCS = [
    "https://rpc.mainnet.chain.robinhood.com",
    "https://rpc.nodeflare.app/robinhood/public",
  ];
  const BATCH = 50; // ukuran awal; otomatis diperkecil kalau RPC nolak
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const GATEWAYS = [
    "https://ipfs.io/ipfs/",
    "https://dweb.link/ipfs/",
    "https://w3s.link/ipfs/",
    "https://gateway.pinata.cloud/ipfs/",
  ];

  const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

  async function rpcBatch(calls) {
    const body = JSON.stringify(
      calls.map((c, i) => ({
        jsonrpc: "2.0",
        id: i,
        method: "eth_call",
        params: [{ to: CONTRACT, data: c }, "latest"],
      }))
    );
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const url of RPCS) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          if (!res.ok) throw new Error("RPC HTTP " + res.status);
          const json = await res.json();
          if (!Array.isArray(json)) {
            throw new Error("RPC: " + ((json && json.error && json.error.message) || "bad response"));
          }
          json.sort((a, b) => a.id - b.id);
          return json; // item .error di sini normal (mis. ownerOf token yg belum ada)
        } catch (e) {
          lastErr = e;
          console.warn("[DrillNFT] RPC gagal", url, e);
        }
      }
      await sleep(600 * (attempt + 1));
    }
    const m = (lastErr && lastErr.message) || "";
    throw new Error(/failed to fetch|networkerror|load failed/i.test(m) ? "RPC ditolak/rate-limit (" + m + ")" : m || "RPC gagal");
  }

  async function call1(data) {
    const [r] = await rpcBatch([data]);
    if (r.error) throw new Error(r.error.message);
    return r.result;
  }

  function decodeString(hex) {
    const h = hex.replace(/^0x/, "");
    const len = parseInt(h.slice(64, 128), 16);
    const bytes = h.slice(128, 128 + len * 2).match(/.{2}/g) || [];
    return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))));
  }

  // Ubah uri apa pun jadi daftar kandidat URL (fallback antar gateway IPFS)
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
      const [head, body] = [uri.slice(0, uri.indexOf(",")), uri.slice(uri.indexOf(",") + 1)];
      const txt = /;base64/i.test(head) ? atob(body) : decodeURIComponent(body);
      return JSON.parse(txt);
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
    throw lastErr || new Error("no url");
  }

  // Batasi jumlah request metadata yang jalan bareng
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
        uri = decodeString(await call1("0xc87b56dd" + pad(id.toString(16))));
      } catch (e) {
        return { id, name: "#" + id, images: [], err: "NO URI" };
      }
      if (!uri) return { id, name: "#" + id, images: [], err: "NO URI" };
      let meta;
      try {
        meta = await fetchJson(uri);
      } catch (e) {
        console.warn("[DrillNFT] metadata gagal", id, uri, e);
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
    // jangan simpan hasil gagal permanen, biar bisa dicoba lagi
    p.then((v) => v.err && v.err !== "NO IMAGE" && infoCache.delete(id));
    return p;
  }

  async function getBalance(addr) {
    return parseInt(await call1("0x70a08231" + pad(addr)), 16);
  }
  async function getTotalSupply() {
    return parseInt(await call1("0x18160ddd"), 16);
  }

  // Cari tokenId milik addr dengan scan ownerOf (kontrak ini bukan Enumerable)
  async function getUserTokenIds(addr) {
    const want = await getBalance(addr);
    if (!want) return [];
    const supply = await getTotalSupply();
    const me = addr.toLowerCase().replace(/^0x/, "");
    const found = [];
    let size = BATCH;
    let start = 0;
    while (start <= supply && found.length < want) {
      const ids = [];
      for (let id = start; id < start + size && id <= supply; id++) ids.push(id);
      let res;
      try {
        res = await rpcBatch(ids.map((id) => "0x6352211e" + pad(id.toString(16))));
      } catch (e) {
        // RPC nolak batch segini -> perkecil lalu ulangi bagian yang sama
        if (size > 10) {
          size = Math.max(10, size >> 1);
          await sleep(400);
          continue;
        }
        throw e;
      }
      res.forEach((r, i) => {
        if (r.result && r.result.slice(-40).toLowerCase() === me) found.push(ids[i]);
      });
      start += ids.length;
      await sleep(120); // jeda kecil biar gak kena rate-limit
    }
    return found;
  }

  // Cepat: cuma ID. Metadata/gambar diambil per token lewat getTokenInfo(id)
  async function getUserNFTs(addr) {
    return (await getUserTokenIds(addr)).map((id) => ({ id }));
  }

  window.DrillNFT = { CONTRACT, getBalance, getUserTokenIds, getUserNFTs, getTokenInfo };
})();
