// Anonymous per-browser identity (no login). A random id is generated on first
// visit and kept in localStorage, then sent as the `x-society-cid` header with
// every session request so each browser only ever sees + lists its OWN saved
// games. Not tied to IP (which changes across networks and is shared behind
// NAT/VPN) — this survives network changes and is stable per browser profile.
const CID_KEY = "society_cid";

export function getClientId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = window.localStorage.getItem(CID_KEY);
    if (!id || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `cid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      window.localStorage.setItem(CID_KEY, id);
    }
    return id;
  } catch {
    // localStorage blocked (private mode / disabled) — fall back to the legacy
    // shared pool by sending no id.
    return "";
  }
}

/** Header bag for session fetches. Empty when no id is available. */
export function clientIdHeaders(): Record<string, string> {
  const id = getClientId();
  return id ? { "x-society-cid": id } : {};
}
