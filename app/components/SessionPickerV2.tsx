"use client";

import { useEffect, useMemo, useState } from "react";
import { useSociety } from "./SocietyContext";
import { getGame, listGames, normalizeSavedGame, saveGame } from "@/lib/gameHistory";

export function SessionPickerV2({
  disabled,
  showSaved,
  onSessionLoaded,
}: {
  disabled?: boolean;
  showSaved: boolean;
  onSessionLoaded?: () => void;
}) {
  const { history, setHistory, setBible, setImages, setFinalRecord, setSummary, setSessionId } = useSociety();
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const options = useMemo(() => history, [history]);

  useEffect(() => {
    // Load/refresh on mount
    listGames().then(setHistory).catch(() => {});
    const handler = () => listGames().then(setHistory).catch(() => {});
    window.addEventListener("society-sessions-updated", handler);
    return () => window.removeEventListener("society-sessions-updated", handler);
  }, [setHistory]);

  // Refetch whenever the Saved menu opens so the list isn’t stale (e.g. after restarts).
  useEffect(() => {
    if (!showSaved) return;
    listGames().then(setHistory).catch(() => {});
  }, [showSaved, setHistory]);

  const onSelect = async (id: string) => {
    setSelectedId(id);
    if (!id) return;
    setLoading(true);
    try {
      const g = await getGame(id);
      if (!g) return;
      const normalized = normalizeSavedGame(g);
      if (normalized.changed) {
        await saveGame(normalized.game);
      }
      setBible(normalized.game.bible);
      setImages(normalized.game.images);
      setFinalRecord(normalized.game.finalRecordText ?? "");
      setSummary(normalized.game.summary ?? "");
      setSessionId(normalized.game.id);
      onSessionLoaded?.();    } finally {
      setLoading(false);
    }
  };

  if (!showSaved) return null;

  return (
    <div className="card sessionCard" role="menu" aria-label="Saved sessions">
      <div className="sessionCardHeader">SAVED SOCIETIES</div>
      {options.length === 0 ? (
        <p className="sessionEmpty">No saved sessions yet.</p>
      ) : (
        <div className="sessionList">
          {options.map((g) => (
            <button
              key={g.id}
              type="button"
              role="menuitem"
              className={`sessionRow ${g.id === selectedId ? "sessionRow--active" : ""}`}
              disabled={disabled || loading}
              onClick={() => onSelect(g.id)}
            >
              <span className="sessionRowTitle">{g.title || "Untitled society"}</span>
              <span className="sessionRowDate">{new Date(g.createdAt).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
      )}
      {loading ? <div className="sessionLoading">Loading…</div> : null}
    </div>
  );
}


