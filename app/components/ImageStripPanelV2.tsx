"use client";

import { useEffect, useState } from "react";
import { useSociety } from "./SocietyContext";
import type { GeneratedImage } from "@/lib/generatedImage";

export function ImageStripPanelV2() {
  const { bible, images, setImages, sessionId } = useSociety();
  const [busyKey, setBusyKey] = useState<string>("");
  const [lastError, setLastError] = useState<string>("");
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [introStarted, setIntroStarted] = useState(false);
  const [recapActive, setRecapActive] = useState(false);
  const [imageAlert, setImageAlert] = useState<string>("");
  const [imageRenderFailed, setImageRenderFailed] = useState(false);

  useEffect(() => {
    if (images.length > 0) {
      setActiveIndex(images.length - 1);
    } else {
      setActiveIndex(0);
    }
  }, [images.length]);

  useEffect(() => {
    setImageRenderFailed(false);
  }, [activeIndex, images.length]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message?: string } | undefined;
      const msg = String(detail?.message ?? "").trim();
      if (!msg) return;
      setImageAlert(msg);
      window.setTimeout(() => setImageAlert(""), 5000);
    };
    window.addEventListener("society-image-alert", handler);
    return () => window.removeEventListener("society-image-alert", handler);
  }, []);

  useEffect(() => {
    const handler = () => setIntroStarted(false);
    window.addEventListener("society-reset", handler);
    window.addEventListener("society-session-loaded", handler);
    return () => {
      window.removeEventListener("society-reset", handler);
      window.removeEventListener("society-session-loaded", handler);
    };
  }, []);

  useEffect(() => {
    const handler = () => setIntroStarted(true);
    window.addEventListener("society-started", handler);
    return () => window.removeEventListener("society-started", handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { intervalMs?: number } | undefined;
      if (images.length === 0) return;
      const interval = Math.max(1800, Number(detail?.intervalMs ?? 2200));
      setRecapActive(true);
      setActiveIndex(0);
      let idx = 0;
      const id = window.setInterval(() => {
        idx += 1;
        if (idx >= images.length) {
          window.clearInterval(id);
          setRecapActive(false);
          return;
        }
        setActiveIndex(idx);
      }, interval);
    };
    window.addEventListener("society-recap-slideshow", handler);
    return () => window.removeEventListener("society-recap-slideshow", handler);
  }, [images.length]);

  const onReroll = async () => {
    const img = images[activeIndex];
    if (!img?.promptUsed) {
      setLastError("No prompt saved for this image yet.");
      return;
    }
    const key = `${img.at}-${activeIndex}`;
    setBusyKey(key);
    setLastError("");
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

      setImages((prev) => {
        const next = prev.slice();
        const cur = next[activeIndex];
        if (!cur) return prev;
        next[activeIndex] = { ...cur, b64: String(data.b64), at: new Date().toLocaleString() } satisfies GeneratedImage;
        return next;
      });
    } finally {
      setBusyKey("");
    }
  };

  const current = images[activeIndex] ?? images[images.length - 1];
  const currentSrc = current?.b64 ? `data:image/png;base64,${current.b64}` : (current?.imagePath ?? "");
  const canRenderCurrentImage = Boolean(currentSrc) && !imageRenderFailed;
  const canPrev = activeIndex > 0;
  const canNext = activeIndex < images.length - 1;
  const coreChoice = String(bible.canon.coreValues?.[0] ?? "").trim();
  const showPrompt = introStarted && !coreChoice;
  const showCoreChoiceUntilImage = introStarted && coreChoice && images.length === 0;
  const rawCaption = current?.caption?.trim() ?? "";
  const captionText = rawCaption ? rawCaption.replace(/\?/g, "").trim() : "";
  const fallbackDescription =
    captionText ||
    current?.title ||
    String(bible.lastAiUtterance ?? "").trim() ||
    "";

  return (
    <div className="imagePanelFull">
      {current ? (
        <>
          <div className="stageImageFrame">
            {canRenderCurrentImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt={current.title}
                src={currentSrc}
                className="stageImageForeground"
                onError={() => setImageRenderFailed(true)}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt="Image unavailable"
                src="/welcome-society.png"
                className="stageImageForeground"
              />
            )}
          </div>
          <div className="floatingCaption">
            <div className="floatingTitle integratedTitle floatingTitleRow">
              <span>{current.title}</span>
              <span className="imageNavArrows">
                <button
                  className="arrowButton"
                  onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
                  disabled={!canPrev}
                  aria-label="Previous image"
                >
                  ◀
                </button>
                <button
                  className="arrowButton"
                  onClick={() => setActiveIndex((i) => Math.min(images.length - 1, i + 1))}
                  disabled={!canNext}
                  aria-label="Next image"
                >
                  ▶
                </button>
              </span>
            </div>
            {showPrompt ? (
              <p>WHAT IS THE MOST IMPORTANT THING IN YOUR SOCIETY?</p>
            ) : showCoreChoiceUntilImage ? (
              <p className="coreChoiceText">{`THE MOST IMPORTANT THING IN THIS SOCIETY IS ${coreChoice.toUpperCase()}`}</p>
            ) : fallbackDescription ? (
              <p>{fallbackDescription}</p>
            ) : (
              <p className="muted">No scene summary yet.</p>
            )}
            {images.length > 1 ? <small className="muted">{activeIndex + 1} / {images.length}</small> : null}
            {lastError ? (
              <small className="muted imageError">
                Image error: {lastError}
              </small>
            ) : null}
            {!canRenderCurrentImage ? (
              <small className="muted imageError">
                Couldn&apos;t load this image source; showing fallback background.
              </small>
            ) : null}
            {imageAlert ? (
              <small className="muted imageNotice">
                {imageAlert}
              </small>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="Welcome To Society" src="/welcome-society.png" className="stageImageFull" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="Society logo" src="/society_logo.png" className="centerLogo" />
          <div className="floatingCaption">
            {!introStarted ? (
                  <p className="welcomeBody">
                    Worlds built on imagination.<br />
                    <button
                      className="startLink"
                      onClick={() => {
                        setIntroStarted(true);
                        window.dispatchEvent(new Event("society-start"));
                      }}
                    >
                      Press Start to begin
                    </button>
                    .
                  </p>
            ) : (
              <p>
                {coreChoice
                  ? `THE MOST IMPORTANT THING IN THIS SOCIETY IS ${coreChoice.toUpperCase()}`
                  : "WHAT IS THE MOST IMPORTANT THING IN YOUR SOCIETY?"}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}


