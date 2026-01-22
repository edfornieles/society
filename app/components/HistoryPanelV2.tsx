"use client";

import { useState } from "react";
import { useSociety } from "./SocietyContext";
import { deleteGame, getGame, listGames, normalizeSavedGame, saveGame } from "@/lib/gameHistory";

export function HistoryPanelV2() {
  const { setBible, setImages, setFinalRecord, setSummary, setSessionId, history, setHistory } = useSociety();
  const [loadingId, setLoadingId] = useState<string>("");

  const onRefresh = async () => {
    setHistory(await listGames());
  };

  const onLoad = async (id: string) => {
    setLoadingId(id);
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
    } finally {
      setLoadingId("");
    }
  };

  const onDelete = async (id: string) => {
    await deleteGame(id);
    await onRefresh();
  };

  return (
    <div className="card">
      <div className="kv" style={{ justifyContent: "space-between" }}>
        <strong>Past games</strong>
        <button onClick={onRefresh}>Refresh</button>
      </div>
      <hr />
      {history.length === 0 ? (
        <small className="muted">No saved games yet.</small>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {history.slice(0, 12).map((g) => (
            <div key={g.id} className="card" style={{ borderRadius: 10 }}>
              <div className="kv" style={{ justifyContent: "space-between" }}>
                <div style={{ display: "grid" }}>
                  <strong style={{ fontSize: 13 }}>{g.title || "Untitled society"}</strong>
                  <small className="muted">{new Date(g.createdAt).toLocaleString()}</small>
                </div>
                <div className="kv">
                  <button onClick={() => onLoad(g.id)} disabled={loadingId === g.id}>
                    {loadingId === g.id ? "Loading…" : "Load"}
                  </button>
                  <button onClick={() => onDelete(g.id)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


