import type { SecretAuthState } from "cruzo-web3";
import { decallLog } from "site/utils/decall-log";

type WalletPubKey = NonNullable<SecretAuthState["pubKey"]>;

const apiBase = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, "");

function canonicalPubKey(pubKey: WalletPubKey) {
  return `${pubKey.type}|${pubKey.encoding}|${pubKey.value.toLowerCase()}`;
}

export async function pubKeyToCallIdentity(
  pubKey: WalletPubKey,
): Promise<string> {
  // Key collecting
  const canonicalString = canonicalPubKey(pubKey);

  // send pub-key to backend
  const url = `${apiBase}/generate-id?pubkey=${encodeURIComponent(canonicalString)}`;
  decallLog("api", "GET generate-id");

  const response = await fetch(url);

  if (!response.ok) {
    decallLog("api", "generate-id failed", { status: response.status }, "error");
    throw new Error("Failed to generate Call ID from server");
  }

  // get the result from server
  const data = await response.json();

  decallLog("api", "Call ID generated");
  return data.id;
}
