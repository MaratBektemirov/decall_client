import { web3Service } from "cruzo-web3";

export const tonManifestUrl = new URL(
  `${import.meta.env.BASE_URL}tonconnect-manifest.json`,
  window.location.href,
).href;

web3Service.setTonManifestUrl(tonManifestUrl);

const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;

if (walletConnectProjectId) {
  web3Service.setWalletConnectProjectId(walletConnectProjectId);
}
