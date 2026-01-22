"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { SocietyBible } from "@/lib/societyBible";
import { createEmptyBible } from "@/lib/societyBible";
import type { GeneratedImage } from "./ImageStrip";
import type { SavedGame } from "@/lib/gameHistory";
import { getGame, listGames } from "@/lib/gameHistory";

type SocietyState = {
  bible: SocietyBible;
  setBible: React.Dispatch<React.SetStateAction<SocietyBible>>;
  images: GeneratedImage[];
  setImages: React.Dispatch<React.SetStateAction<GeneratedImage[]>>;
  sessionId: string;
  setSessionId: React.Dispatch<React.SetStateAction<string>>;
  summary: string;
  setSummary: React.Dispatch<React.SetStateAction<string>>;
  finalRecord: string;
  setFinalRecord: React.Dispatch<React.SetStateAction<string>>;
  history: Pick<SavedGame, "id" | "createdAt" | "title">[];
  setHistory: React.Dispatch<React.SetStateAction<Pick<SavedGame, "id" | "createdAt" | "title">[]>>;
};

const Ctx = createContext<SocietyState | null>(null);

export function SocietyProvider({ children }: { children: React.ReactNode }) {
  const [bible, setBible] = useState<SocietyBible>(() => createEmptyBible());
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [summary, setSummary] = useState<string>("");
  const [finalRecord, setFinalRecord] = useState<string>("");
  const [history, setHistory] = useState<Pick<SavedGame, "id" | "createdAt" | "title">[]>([]);

  useEffect(() => {
    // Load saved games list once on mount.
    listGames().then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    const lastId = window.localStorage.getItem("society:lastSessionId");
    if (!lastId || sessionId) return;
    getGame(lastId)
      .then((g) => {
        if (!g) return;
        setBible(g.bible);
        setImages(g.images);
        setFinalRecord(g.finalRecordText ?? "");
        setSummary(g.summary ?? "");
        setSessionId(g.id);
      })
      .catch(() => {});
  }, [sessionId, setBible, setImages, setFinalRecord, setSummary, setSessionId]);

  useEffect(() => {
    if (sessionId) {
      window.localStorage.setItem("society:lastSessionId", sessionId);
    } else {
      window.localStorage.removeItem("society:lastSessionId");
    }
  }, [sessionId]);

  const value = useMemo(
    () => ({
      bible,
      setBible,
      images,
      setImages,
      sessionId,
      setSessionId,
      summary,
      setSummary,
      finalRecord,
      setFinalRecord,
      history,
      setHistory,
    }),
    [bible, images, sessionId, summary, finalRecord, history]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSociety() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSociety must be used within SocietyProvider");
  return v;
}
