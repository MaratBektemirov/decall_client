import type { SecretAuthState } from "cruzo-web3";

type WalletPubKey = NonNullable<SecretAuthState["pubKey"]>;

function canonicalPubKey(pubKey: WalletPubKey) {
  return `${pubKey.type}|${pubKey.encoding}|${pubKey.value.toLowerCase()}`;
}

export async function pubKeyToCallIdentity(
  pubKey: WalletPubKey,
): Promise<string> {
  // Собираем строку ключа
  const canonicalString = canonicalPubKey(pubKey);

  // Отправляю строку на бэкенд
  const response = await fetch(`/api/generate-id?pubkey=${encodeURIComponent(canonicalString)}`);

  if (!response.ok) {
    throw new Error("Failed to generate Call ID from server");
  }

  // Получаем от сервера готовый результат со словами
  const data = await response.json();

  return data.id;
}
