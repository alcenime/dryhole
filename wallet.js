/* DRYHOLE — wallet.js
 * Wallet connect via Reown AppKit (ethers adapter), Robinhood Chain mainnet.
 * Isi PROJECT_ID di bawah, lalu allowlist domain situs di cloud.reown.com.
 * Dipakai di SEMUA halaman (index, genesis, drill, swap, market, leaderboard, docs, profile):
 * <script type="module" src="wallet.js"></script>
 */

const PROJECT_ID = '2ee5bb382849649365d9a79c10cbddb3';

import { createAppKit } from 'https://esm.sh/@reown/appkit';
import { EthersAdapter } from 'https://esm.sh/@reown/appkit-adapter-ethers';
import { defineChain } from 'https://esm.sh/@reown/appkit/networks';

const robinhood = defineChain({
  id: 4663,
  caipNetworkId: 'eip155:4663',
  chainNamespace: 'eip155',
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } }
});

const BTN_SELECTOR = '.wallet';
const DEFAULT_LABEL = 'Connect Wallet';

let appkit = null;
try {
  if (!PROJECT_ID || PROJECT_ID.startsWith('YOUR_')) throw new Error('PROJECT_ID belum diisi di wallet.js');
  appkit = createAppKit({
    adapters: [new EthersAdapter()],
    networks: [robinhood],
    defaultNetwork: robinhood,
    projectId: PROJECT_ID,
    metadata: {
      name: 'DRYHOLE',
      description: 'DRYHOLE — on-chain drilling protocol',
      url: window.location.origin,
      icons: []
    },
    features: { analytics: false, email: false, socials: false, onramp: false, swaps: false },
    themeMode: 'dark',
    themeVariables: {
      '--w3m-accent': '#B8FF00',
      '--w3m-color-mix': '#0D1110',
      '--w3m-color-mix-strength': 20,
      '--w3m-border-radius-master': '1px'
    }
  });
} catch (err) {
  console.error('[wallet.js]', err);
}

const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

function setLabel(text) {
  document.querySelectorAll(BTN_SELECTOR).forEach((b) => { b.textContent = text; });
}

// Provider EIP-1193 dari koneksi AppKit (injected maupun WalletConnect).
// Dipakai halaman untuk personal_sign; fallback ke window.ethereum.
function getProvider() {
  try {
    const p = appkit && appkit.getWalletProvider && appkit.getWalletProvider();
    if (p && typeof p.request === 'function') return p;
  } catch (e) { console.error('[wallet.js] getWalletProvider', e); }
  return window.ethereum || null;
}
window.dryWallet = { address: null, appkit, getProvider };

document.querySelectorAll(BTN_SELECTOR).forEach((b) => {
  b.addEventListener('click', (e) => {
    e.preventDefault();
    if (!appkit) { alert('Wallet belum dikonfigurasi (Project ID belum diisi).'); return; }
    // Belum konek -> modal pilih wallet. Sudah konek -> modal akun (ada Disconnect).
    appkit.open();
  });
});

// Hook halaman (genesis.html / drill.html / profile.html) — diberi alamat saat akun berubah,
// karena koneksi lewat AppKit/WalletConnect tidak selalu tersedia di window.ethereum.
function pushToPages(address) {
  try { if (window.GenesisView && window.GenesisView.setAddress) window.GenesisView.setAddress(address); } catch (e) { console.error('[wallet.js] GenesisView', e); }
  try { if (window.DrillPicker && window.DrillPicker.setAddress) window.DrillPicker.setAddress(address); } catch (e) { console.error('[wallet.js] DrillPicker', e); }
  try { if (window.ProfileView && window.ProfileView.setAddress) window.ProfileView.setAddress(address); } catch (e) { console.error('[wallet.js] ProfileView', e); }
}

if (appkit) {
  appkit.subscribeAccount((acc) => {
    const address = (acc && acc.isConnected && acc.address) ? acc.address : null;
    setLabel(address ? short(address) : DEFAULT_LABEL);
    window.dryWallet.address = address;
    pushToPages(address);
    document.dispatchEvent(new CustomEvent('drywallet:change', { detail: { address } }));
  });
}

// Sidebar (semua halaman): pastikan menu Account > Profile ada dan sidebar bisa di-scroll.
// Dilewati kalau halaman sudah punya menunya.
(function patchSidebar() {
  const nav = document.querySelector('.side nav');
  if (nav && !nav.querySelector('a[href="profile.html"]')) {
    const lab = document.createElement('div');
    lab.className = 'ws label';
    lab.textContent = 'Account';
    const a = document.createElement('a');
    a.className = 'nav';
    a.href = 'profile.html';
    a.innerHTML = '<span class="ic">&#9680;</span>Profile<i class="dot"></i>';
    nav.append(lab, a);
  }
  if (!document.getElementById('dry-side-fix')) {
    const st = document.createElement('style');
    st.id = 'dry-side-fix';
    st.textContent = '.side{overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}.side>*{flex-shrink:0}';
    document.head.appendChild(st);
  }
})();
