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
    <div className="card sessionCard">
      <select
        value={selectedId}
        disabled={disabled || loading || options.length === 0}
        onChange={(e) => onSelect(e.target.value)}
        className="sessionSelect"
        aria-label="Saved sessions"
      >
        <option value="">{options.length ? "Select a session…" : "No saved sessions yet"}</option>
        {options.map((g) => (
          <option key={g.id} value={g.id}>
            {(g.title || "Untitled society") + " — " + new Date(g.createdAt).toLocaleDateString()}
          </option>
        ))}
      </select>
    </div>
  );
}


