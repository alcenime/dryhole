// nft.js - deteksi NFT DRILL milik user (tanpa library, murni fetch ke RPC)
(function () {
  const CONTRACT = "0xae7655bcd2aeda4d9c45bb36a01ccb2d26240ff6";
  const RPC = "https://rpc.mainnet.chain.robinhood.com"; // chainId 4663 (0x1237)
  const BATCH = 50;

  const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

  async function rpcBatch(calls) {
    const body = calls.map((c, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "eth_call",
      params: [{ to: CONTRACT, data: c }, "latest"],
    }));
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    const arr = Array.isArray(json) ? json : [json];
    arr.sort((a, b) => a.id - b.id);
    return arr; // item bisa berisi .error (mis. ownerOf token yg belum ada)
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

  const ipfs = (u) => (u && u.startsWith("ipfs://") ? "https://ipfs.io/ipfs/" + u.slice(7) : u);

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
    // mulai dari 0 dan sampai supply, biar aman kalau id mulai 0 atau 1
    for (let start = 0; start <= supply && found.length < want; start += BATCH) {
      const ids = [];
      for (let id = start; id < start + BATCH && id <= supply; id++) ids.push(id);
      const res = await rpcBatch(ids.map((id) => "0x6352211e" + pad(id.toString(16))));
      res.forEach((r, i) => {
        if (r.result && r.result.slice(-40).toLowerCase() === me) found.push(ids[i]);
      });
    }
    return found;
  }

  async function getTokenInfo(id) {
    try {
      const uri = decodeString(await call1("0xc87b56dd" + pad(id.toString(16))));
      const meta = await (await fetch(ipfs(uri))).json();
      return { id, name: meta.name, image: ipfs(meta.image), attributes: meta.attributes || [] };
    } catch (e) {
      return { id, name: "DRILL #" + id, image: null, attributes: [] };
    }
  }

  // Pakai: const nfts = await DrillNFT.getUserNFTs("0x...");
  async function getUserNFTs(addr) {
    const ids = await getUserTokenIds(addr);
    return Promise.all(ids.map(getTokenInfo));
  }

  window.DrillNFT = { CONTRACT, getBalance, getUserTokenIds, getUserNFTs };
})();
