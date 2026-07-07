"use client";

import { useEffect, useMemo, useState } from "react";
import { useSociety } from "./SocietyContext";
import { getGame, listGamesStrict, normalizeSavedGame, saveGame } from "@/lib/gameHistory";

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
  // Distinguish "the list is empty" from "the fetch failed" — a transient
  // network error used to render as "No saved sessions yet.", which reads as
  // data loss to a player with thirty societies saved.
  const [listError, setListError] = useState(false);

  const options = useMemo(() => history, [history]);

  const refresh = () => {
    listGamesStrict()
      .then((rows) => {
        setHistory(rows);
        setListError(false);
      })
      .catch(() => setListError(true));
  };

  // Do NOT fetch on mount — the shared SocietyContext already loads the list
  // once, and a second fetch here doubled the /api/sessions load on every
  // page open (that endpoint parses every full session record, so it's the
  // expensive one). Only listen for explicit updates and refetch when the
  // Saved menu is actually opened.
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener("society-sessions-updated", handler);
    return () => window.removeEventListener("society-sessions-updated", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setHistory]);

  // Refetch when the Saved menu opens so the list isn’t stale (e.g. after restarts).
  useEffect(() => {
    if (!showSaved) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      {listError ? (
        <p className="sessionEmpty">
          Couldn’t load your saved societies —{" "}
          <button type="button" onClick={refresh} style={{ font: "inherit" }}>
            retry
          </button>
        </p>
      ) : options.length === 0 ? (
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


