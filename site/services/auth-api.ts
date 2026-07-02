import type { SecretAuthChallenge } from "cruzo-web3/secret-auth";

const apiBase = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, "");

export async function fetchAuthChallenge(): Promise<SecretAuthChallenge> {
  const res = await fetch(`${apiBase}/auth/challenge`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`challenge request failed: ${res.status}`);
  }

  const data = (await res.json()) as SecretAuthChallenge;

  if (
    typeof data?.domain !== "string" ||
    typeof data?.nonce !== "string" ||
    typeof data?.exp !== "number"
  ) {
    throw new Error("invalid challenge response");
  }

  return data;
}
