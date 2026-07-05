import type { SecretAuthProof } from "cruzo-web3/secret-auth";
import { decallLog } from "site/utils/decall-log";

const apiBase = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, "");

export async function fetchTurnIceServers(proof: SecretAuthProof): Promise<RTCIceServer[]> {
  const url = `${apiBase}/turn-credentials`;
  decallLog("api", "POST turn-credentials", { url });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ proof }),
  });

  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // ignore
    }
    decallLog("api", "TURN credentials failed", { status: res.status, detail }, "error");
    throw new Error(`turn credentials failed: ${detail}`);
  }

  const data = (await res.json()) as { iceServers?: RTCIceServer[] };
  if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
    throw new Error("invalid turn credentials response");
  }

  decallLog("api", "TURN credentials received", {
    servers: data.iceServers.length,
    urls: data.iceServers.flatMap((server) =>
      Array.isArray(server.urls) ? server.urls : [server.urls],
    ),
  });

  return data.iceServers;
}
