"use client";

import { useEffect, useRef, useState } from "react";
import { SessionPickerV2 } from "./SessionPickerV2";
import { OpenVoiceConsole } from "./OpenVoiceConsole";
import { ImageStripV2 } from "./ImageStripV2";
import { RulesPanel } from "./RulesPanel";
import { useSociety } from "./SocietyContext";
import type { Playfulness } from "@/lib/prompts";
import { withBase } from "@/lib/basePath";

export function GameShell() {
  const { bible, summary } = useSociety();
  const [showRules, setShowRules] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageProgress, setImageProgress] = useState(0);
  const [showRecapPrompt, setShowRecapPrompt] = useState(false);
  const [hasLoadedSession, setHasLoadedSession] = useState(false);
  const [resumeMode, setResumeMode] = useState<"new" | "continue" | "recap">("new");
  // Filled by OpenVoiceConsole with its "start a fresh game" fn so the New Game
  // button can invoke it directly inside this React click (reliable activation).
  const newGameRef = useRef<(() => void) | null>(null);

  // Default 1 (BALANCED): grounded, curious, real edge only when the player
  // opens the door — NOT the old default 2 (EDGY), which made institutions
  // "default to cruel" and turned neutral premises like "socialism" dystopian.
  const [playfulness, setPlayfulness] = useState<Playfulness>(1);
  const [autoImages, setAutoImages] = useState(true);
  // Back to every turn per request — per-image cost is already controlled via
  // gpt-image-1-mini at "medium" quality (~8-12x cheaper than the original
  // unset-quality gpt-image-1 setup), so every-turn generation here is not
  // the same cost problem it was before that fix.
  const [autoEveryTurns, setAutoEveryTurns] = useState(1);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { busy?: boolean } | undefined;
      setImageBusy(Boolean(detail?.busy));
    };
    window.addEventListener("society-image-busy", handler);
    return () => window.removeEventListener("society-image-busy", handler);
  }, []);

  useEffect(() => {
    const handler = () => {
      onNewGame();
    };
    window.addEventListener("society-reset", handler);
    return () => window.removeEventListener("society-reset", handler);
  }, []);

  useEffect(() => {
    if (!imageBusy) {
      setImageProgress(0);
      return;
    }
    setImageProgress(5);
    const start = Date.now();
    const durationMs = 20000;
    const id = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.min(90, Math.round((elapsed / durationMs) * 90));
      setImageProgress(Math.max(5, pct));
    }, 200);
    return () => window.clearInterval(id);
  }, [imageBusy]);


  const progressStep = Math.min(100, Math.max(0, Math.round(imageProgress / 10) * 10));

  // Written recap shown in the recap modal so a returning player can read what
  // was built before deciding to recap aloud or continue.
  const coreValue = String(bible?.canon?.coreValues?.[0] ?? "").trim();
  const canonHighlights = (bible?.changelog ?? [])
    .slice()
    .sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
    .map((c) => String(c.entry ?? "").trim())
    .filter((e) => e.length > 2)
    .slice(-6);
  const hasWrittenRecap = Boolean(summary?.trim()) || Boolean(coreValue) || canonHighlights.length > 0;

  const onNewGame = () => {
    window.localStorage.removeItem("society:lastSessionId");
    window.localStorage.setItem("society:skipAutoLoad", "1");
    setShowSaved(false);
    setShowRecapPrompt(false);
    setHasLoadedSession(false);
    setResumeMode("new");
    // Start a fresh game immediately, in this same click. The console owns the
    // session/state reset + greeting (doNewGame); calling it directly here —
    // rather than via a window event — makes activation reliable.
    newGameRef.current?.();
  };

  return (
    <main className="gameRoot">
      <div className="gameLayout">
        <nav className="topNav">
          <button className="logoPixel logoButton" onClick={onNewGame} type="button" aria-label="New game">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={withBase("/society_logo_upper_corner.png")} alt="Society" className="logoImage" />
          </button>
          <div className="hudNav">
            <button onClick={onNewGame}>New Game</button>
            <div className="savedMenu">
              <button onClick={() => setShowSaved((v) => !v)}>Saved</button>
              <SessionPickerV2
                showSaved={showSaved}
                onSessionLoaded={() => {
                  setShowSaved(false);
                  setHasLoadedSession(true);
                  setResumeMode("continue");
                  setShowRecapPrompt(true);
                  window.dispatchEvent(new Event("society-session-loaded"));
                }}
              />
            </div>
            <button onClick={() => setShowRules((v) => !v)}>{showRules ? "Hide rules" : "Rules"}</button>
            <button onClick={() => setShowSettings((v) => !v)}>
              Settings
            </button>
          </div>
        </nav>
        <div className={`imageProgressWrap ${imageBusy ? "is-visible" : "is-hidden"}`}>
          <div className="imageProgressLabel">Generating image</div>
          <div className="imageProgressTrack">
            <div className={`imageProgressBar progress-${progressStep}`} />
          </div>
        </div>
        <aside className="gameSidebar">
          <OpenVoiceConsole
            showSettings={showSettings}
            onToggleSettings={() => setShowSettings((v) => !v)}
            startLabel={hasLoadedSession ? "Play" : "Start"}
            resumeMode={resumeMode}
            playfulness={playfulness}
            setPlayfulness={setPlayfulness}
            autoImages={autoImages}
            setAutoImages={setAutoImages}
            autoEveryTurns={autoEveryTurns}
            setAutoEveryTurns={setAutoEveryTurns}
            newGameRef={newGameRef}
          />
        </aside>

        <section className="gameStage">
          <ImageStripV2 />
        </section>
      </div>

      {showRules ? (
        <div className="modalOverlay">
          <div className="modalCard">
            <div className="modalHeader">
              <strong>Rules</strong>
              <button className="modalClose" onClick={() => setShowRules(false)}>
                X
              </button>
            </div>
            <div className="modalBody">
              <RulesPanel />
            </div>
          </div>
        </div>
      ) : null}

      {showRecapPrompt ? (
        <div className="modalOverlay">
          <div className="modalCard">
            <div className="modalHeader">
              <strong>Recap this session?</strong>
              <button className="modalClose" onClick={() => setShowRecapPrompt(false)}>
                X
              </button>
            </div>
            <div className="modalBody">
              {hasWrittenRecap ? (
                <div className="recapSummary">
                  {coreValue ? (
                    <p className="recapCore">
                      <span className="muted">The most important thing in this society:</span>
                      <br />
                      <strong>{coreValue}</strong>
                    </p>
                  ) : null}
                  {summary?.trim() ? (
                    <pre className="recapText">{summary.trim()}</pre>
                  ) : canonHighlights.length > 0 ? (
                    <ul className="recapList">
                      {canonHighlights.map((entry, i) => (
                        <li key={i}>{entry}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : (
                <p className="muted">This session is just getting started — nothing to recap yet.</p>
              )}
              <p className="muted">
                Want the recap read aloud before you continue, or jump straight back in?
              </p>
              <div className="kv">
                <button
                  onClick={() => {
                    setShowRecapPrompt(false);
                    setResumeMode("recap");
                    window.dispatchEvent(new CustomEvent("society-recap", { detail: { mode: "recap" } }));
                  }}
                >
                  Yes, recap
                </button>
                <button
                  onClick={() => {
                    setShowRecapPrompt(false);
                    setResumeMode("continue");
                    window.dispatchEvent(new Event("society-resume"));
                  }}
                >
                  No, continue
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

    </main>
  );
}
