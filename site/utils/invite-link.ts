function appBasePath() {
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  return base === "" ? "" : base;
}

export function parseJoinCallId(href = window.location.href): string | null {
  const url = new URL(href);

  const fromSearch = url.searchParams.get("join")?.trim();
  if (fromSearch) return fromSearch;

  const hash = url.hash;
  const queryStart = hash.indexOf("?");
  if (queryStart < 0) return null;

  const fromHash = new URLSearchParams(hash.slice(queryStart + 1)).get("join")?.trim();
  return fromHash || null;
}

export function buildInviteLink(callId: string): string {
  const trimmed = callId.trim();
  const origin = window.location.origin;
  const base = appBasePath();
  const path = base ? `${base}/` : "/";

  return `${origin}${path}?join=${encodeURIComponent(trimmed)}`;
}

export function clearJoinFromUrl(href = window.location.href) {
  const url = new URL(href);
  let changed = false;

  if (url.searchParams.has("join")) {
    url.searchParams.delete("join");
    changed = true;
  }

  const hash = url.hash;
  const queryStart = hash.indexOf("?");
  if (queryStart >= 0) {
    const hashPath = hash.slice(0, queryStart) || "#/";
    const hashParams = new URLSearchParams(hash.slice(queryStart + 1));
    if (hashParams.has("join")) {
      hashParams.delete("join");
      const rest = hashParams.toString();
      url.hash = rest ? `${hashPath}?${rest}` : hashPath;
      changed = true;
    }
  }

  if (!changed) return;

  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}
