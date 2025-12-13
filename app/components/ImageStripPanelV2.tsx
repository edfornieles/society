"use client";

import { useMemo, useState } from "react";
import { useSociety } from "./SocietyContext";
import type { GeneratedImage } from "./ImageStrip";

export function ImageStripPanelV2() {
  const { images, setImages } = useSociety();
  const [busyKey, setBusyKey] = useState<string>("");
  const [lastError, setLastError] = useState<string>("");

  const reversed = useMemo(() => images.slice().reverse(), [images]);

  const onReroll = async (reverseIdx: number) => {
    const img = reversed[reverseIdx];
    if (!img?.promptUsed) {
      setLastError("No prompt saved for this image yet.");
      return;
    }
    const key = `${img.at}-${reverseIdx}`;
    setBusyKey(key);
    setLastError("");

    // #region agent log
    fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "debug-session",
        runId: "pre-rules",
        hypothesisId: "H17",
        location: "ImageStripPanelV2:onReroll",
        message: "Re-rolling image",
        data: { hasPrompt: true, promptChars: img.promptUsed.length, title: img.title },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    try {
      const r = await fetch("/api/image-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: img.promptUsed, size: "1024x1024" }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.b64) {
        setLastError(String(data?.error ?? "Image generation failed"));
        return;
      }

      // Replace the corresponding image (same order) with a new b64.
      const forwardIdx = images.length - 1 - reverseIdx;
      setImages((prev) => {
        const next = prev.slice();
        const cur = next[forwardIdx];
        if (!cur) return prev;
        next[forwardIdx] = { ...cur, b64: String(data.b64), at: new Date().toLocaleString() } satisfies GeneratedImage;
        return next;
      });
    } finally {
      setBusyKey("");
    }
  };

  return (
    <div className="card" style={{ maxHeight: "78vh", overflow: "auto" }}>
      <strong>Illustrations</strong>
      <small className="muted" style={{ display: "block", marginTop: 4 }}>
        Auto-generated (and re-rollable) square images that reflect canon + aesthetics.
      </small>
      {lastError ? (
        <small className="muted" style={{ display: "block", marginTop: 6 }}>
          Image error: {lastError}
        </small>
      ) : null}
      <hr />

      {reversed.length === 0 ? (
        <small className="muted">No images yet.</small>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {reversed.map((img, reverseIdx) => {
            const key = `${img.at}-${reverseIdx}`;
            const busy = busyKey === key;
            return (
              <div key={key} style={{ display: "grid", gap: 6 }}>
                <div className="kv" style={{ justifyContent: "space-between" }}>
                  <div className="kv">
                    <span className="tag">{img.title}</span>
                    <small className="muted">{img.at}</small>
                  </div>
                  <button onClick={() => onReroll(reverseIdx)} disabled={busy || !img.promptUsed}>
                    {busy ? "Re-rolling…" : "Re-roll"}
                  </button>
                </div>

                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={img.title}
                  src={`data:image/png;base64,${img.b64}`}
                  style={{ width: "100%", borderRadius: 10, border: "1px solid #e5e7eb" }}
                />
                {img.caption ? <small className="muted">{img.caption}</small> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


