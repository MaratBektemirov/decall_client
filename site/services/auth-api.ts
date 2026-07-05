import type { SecretAuthChallenge } from "cruzo-web3/secret-auth";
import { decallLog } from "site/utils/decall-log";

const apiBase = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, "");

export async function fetchAuthChallenge(): Promise<SecretAuthChallenge> {
  const url = `${apiBase}/auth/challenge`;
  decallLog("api", "GET challenge", { url });

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    decallLog("api", "Challenge request failed", { status: res.status, url }, "error");
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

  decallLog("api", "Challenge received", { domain: data.domain, exp: data.exp });
  return data;
}
