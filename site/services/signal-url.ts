export function signalWebSocketUrl() {
  const apiBase = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, "");

  if (apiBase.startsWith("http://") || apiBase.startsWith("https://")) {
    const url = new URL(apiBase + "/signal");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${apiBase}/signal`;
}
