import type { SecretAuthState } from "cruzo-web3";

type WalletPubKey = NonNullable<SecretAuthState["pubKey"]>;

const IDENTITY_EMOJIS = [
  "📞", "🎙️", "📡", "🔊", "🎧", "📻", "🌐", "✨",
  "🟢", "🔵", "🟣", "🟡", "🔴", "🦋", "🌊", "🎯",
  "🔐", "🗝️", "💬", "👋", "🤝", "🙌", "✌️", "🤙",
  "🐶", "🐱", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁",
  "🍎", "🍊", "🍋", "🍇", "🍓", "🫐", "🌶️", "🥑",
  "⚡", "🔥", "💎", "🌙", "☀️", "⭐", "🎵", "🎸",
] as const;

function canonicalPubKey(pubKey: WalletPubKey) {
  return `${pubKey.type}|${pubKey.encoding}|${pubKey.value.toLowerCase()}`;
}

async function digestPubKey(pubKey: WalletPubKey) {
  const data = new TextEncoder().encode(canonicalPubKey(pubKey));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export async function pubKeyToCallIdentity(
  pubKey: WalletPubKey,
  length = 4,
): Promise<string> {
  const hash = await digestPubKey(pubKey);
  const emojis: string[] = [];

  for (let i = 0; i < length; i++) {
    emojis.push(IDENTITY_EMOJIS[hash[i]! % IDENTITY_EMOJIS.length]!);
  }

  return emojis.join("");
}
