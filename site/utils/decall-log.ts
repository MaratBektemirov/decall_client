export type DecallLogLevel = "info" | "warn" | "error";

export type DecallLogCategory =
  | "session"
  | "signal"
  | "webrtc"
  | "ice"
  | "media"
  | "api";

export type DecallLogEntry = {
  ts: string;
  level: DecallLogLevel;
  category: DecallLogCategory;
  message: string;
  detail?: unknown;
};

type LogListener = (entry: DecallLogEntry) => void;

const listeners = new Set<LogListener>();

function serializeDetail(detail: unknown): string {
  if (detail instanceof Error) return detail.message;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function formatDecallLogLine(entry: DecallLogEntry): string {
  const time = entry.ts.slice(11, 23);
  const tag = entry.level === "error" ? "ERR" : entry.level === "warn" ? "WRN" : "INF";
  let line = `${time} [${tag}] ${entry.category}: ${entry.message}`;
  if (entry.detail !== undefined) {
    line += ` — ${serializeDetail(entry.detail)}`;
  }
  return line;
}

export function decallLog(
  category: DecallLogCategory,
  message: string,
  detail?: unknown,
  level: DecallLogLevel = "info",
) {
  const entry: DecallLogEntry = {
    ts: new Date().toISOString(),
    level,
    category,
    message,
    detail,
  };

  const prefix = `[Decall:${category}]`;
  if (level === "error") console.error(prefix, message, detail ?? "");
  else if (level === "warn") console.warn(prefix, message, detail ?? "");
  else console.info(prefix, message, detail ?? "");

  listeners.forEach((listener) => listener(entry));
}

export function subscribeDecallLog(listener: LogListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function iceCandidateType(candidate: RTCIceCandidateInit): string {
  const parts = candidate.candidate?.split(" ") ?? [];
  const typIdx = parts.indexOf("typ");
  return typIdx >= 0 ? parts[typIdx + 1] : "unknown";
}

export function describeWebSocketClose(code: number, reason: string): string {
  if (code === 1000) return "Normal closure";
  if (code === 1006) {
    return "Abnormal closure (no close frame) — often firewall, proxy, or ISP blocking WebSockets";
  }
  if (code === 1015) return "TLS handshake failure";
  return reason || `WebSocket closed (code ${code})`;
}

export function hintForIceFailure(): string {
  return "ICE failed — UDP peer connectivity may be blocked by router, firewall, or ISP. "
    + "Symmetric NAT and corporate networks often need a TURN relay. Try mobile hotspot or another network.";
}

export function hintForSignalFailure(): string {
  return "Signaling WebSocket failed — check API URL, HTTPS/WSS, and whether the provider blocks WebSockets.";
}
