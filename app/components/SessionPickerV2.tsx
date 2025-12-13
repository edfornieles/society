"use client";

import { useEffect, useMemo, useState } from "react";
import { useSociety } from "./SocietyContext";
import { getGame, listGames } from "@/lib/gameHistory";

export function SessionPickerV2({ disabled }: { disabled?: boolean }) {
  const { history, setHistory, setBible, setImages, setFinalRecord, setSummary } = useSociety();
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const options = useMemo(() => history, [history]);

  useEffect(() => {
    // Load/refresh on mount
    listGames().then(setHistory).catch(() => {});
  }, [setHistory]);

  const onSelect = async (id: string) => {
    setSelectedId(id);
    if (!id) return;
    setLoading(true);
    try {
      const g = await getGame(id);
      if (!g) return;
      setBible(g.bible);
      setImages(g.images);
      setFinalRecord(g.finalRecordText ?? "");
      setSummary("");

      // #region agent log
      fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "debug-session",
          runId: "pre-rules",
          hypothesisId: "H16",
          location: "SessionPickerV2:onSelect",
          message: "Loaded past session",
          data: { id, turn: g.bible.turnCount, images: g.images.length, hasFinalRecord: Boolean(g.finalRecordText) },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setHistory(await listGames());
  };

  return (
    <div className="card">
      <div className="kv" style={{ justifyContent: "space-between" }}>
        <strong>Sessions</strong>
        <button onClick={onRefresh} disabled={disabled || loading}>
          Refresh
        </button>
      </div>

      <hr />

      <label className="tag" style={{ width: "100%" }}>
        Last sessions{" "}
        <select
          value={selectedId}
          disabled={disabled || loading || options.length === 0}
          onChange={(e) => onSelect(e.target.value)}
          style={{ marginLeft: 6, width: "100%" }}
        >
          <option value="">{options.length ? "Select a session…" : "No saved sessions yet"}</option>
          {options.map((g) => (
            <option key={g.id} value={g.id}>
              {(g.title || "Untitled society") + " — " + new Date(g.createdAt).toLocaleDateString()}
            </option>
          ))}
        </select>
      </label>

      <small className="muted" style={{ display: "block", marginTop: 8 }}>
        Select one, then press Start to continue where you left off (canon + images + record load automatically).
      </small>
    </div>
  );
}


