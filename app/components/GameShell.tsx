"use client";

import { useEffect, useState } from "react";
import { SessionPickerV2 } from "./SessionPickerV2";
import { VoiceConsoleV2 } from "./VoiceConsoleV2";
import { ImageStripV2 } from "./ImageStripV2";
import { RulesPanel } from "./RulesPanel";
import { useSociety } from "./SocietyContext";
import { createEmptyBible } from "@/lib/societyBible";
import type { Playfulness } from "@/lib/prompts";

export function GameShell() {
  const { setBible, setImages, setFinalRecord, setSummary, setSessionId } = useSociety();
  const [showRules, setShowRules] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageProgress, setImageProgress] = useState(0);
  const [showRecapPrompt, setShowRecapPrompt] = useState(false);
  const [hasLoadedSession, setHasLoadedSession] = useState(false);
  const [resumeMode, setResumeMode] = useState<"new" | "continue" | "recap">("new");

  const [voice, setVoice] = useState<"marin" | "alloy" | "verse" | "aria" | "ember">("marin");
  const [playfulness, setPlayfulness] = useState<Playfulness>(2);
  const [autoImages, setAutoImages] = useState(true);
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

  const onNewGame = () => {
    window.localStorage.removeItem("society:lastSessionId");
    window.localStorage.setItem("society:skipAutoLoad", "1");
    setShowSaved(false);
    setHasLoadedSession(false);
    setResumeMode("new");
    setSessionId("");
    setBible(createEmptyBible());
    setImages([]);
    setFinalRecord("");
    setSummary("");
  };

  return (
    <main className="gameRoot">
      <div className="gameLayout">
        <nav className="topNav">
          <button className="logoPixel logoButton" onClick={onNewGame} type="button" aria-label="New game">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/society_logo_upper_corner.png" alt="Society" className="logoImage" />
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
          <details className="navHintDetails">
            <summary>Session tips</summary>
            <p className="navHintBody muted">
              Stop ends voice only — your progress stays in this browser until you use New Game. Press Start (or Play) to reconnect voice. Use <strong>Saved</strong> to open a stored session.
            </p>
          </details>
        </nav>
        <div className={`imageProgressWrap ${imageBusy ? "is-visible" : "is-hidden"}`}>
          <div className="imageProgressLabel">Generating image</div>
          <div className="imageProgressTrack">
            <div className={`imageProgressBar progress-${progressStep}`} />
          </div>
        </div>
        <aside className="gameSidebar">
          <VoiceConsoleV2
            showRules={showRules}
            showSettings={showSettings}
            onToggleSettings={() => setShowSettings((v) => !v)}
            startLabel={hasLoadedSession ? "Play" : "Start"}
            resumeMode={resumeMode}
            voice={voice}
            setVoice={setVoice}
            playfulness={playfulness}
            setPlayfulness={setPlayfulness}
            autoImages={autoImages}
            setAutoImages={setAutoImages}
            autoEveryTurns={autoEveryTurns}
            setAutoEveryTurns={setAutoEveryTurns}
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
              <p className="muted">
                Want a quick recap of everything built so far before you continue?
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
