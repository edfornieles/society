"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SocietyBible } from "@/lib/societyBible";
import { bumpTurn, createEmptyBible, addCanonLines, addOpenThreads } from "@/lib/societyBible";
import { systemInstructions, bibleSummaryForModel, oobUpdatePrompt, recapPrompt, imagePromptFromBible, Playfulness } from "@/lib/prompts";
import { safeJsonParse, sanitizeUpdate } from "@/lib/guardrails";
import { mkSessionUpdate, mkResponseCreate } from "@/lib/realtimeEvents";
import type { GeneratedImage } from "@/lib/generatedImage";

type LogLine = { at: string; dir: "in" | "out" | "sys"; text: string };

type BibleUpdate = {
  addCanon: string[];
  addOpenThreads: string[];
  contradictionsFound: string[];
  reconciliationOptions: string[];
};

const VOICES = ["marin", "alloy", "verse", "aria", "ember"] as const;

export function VoiceConsole() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const [voice, setVoice] = useState<(typeof VOICES)[number]>("marin");
  const [playfulness, setPlayfulness] = useState<Playfulness>(2);

  const [bible, setBible] = useState<SocietyBible>(() => createEmptyBible());
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [liveTranscript, setLiveTranscript] = useState<string>("");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const lastAssistantTranscriptRef = useRef<string>("");

  const addLog = (dir: LogLine["dir"], text: string) => {
    setLog((prev) => [...prev.slice(-250), { at: new Date().toLocaleTimeString(), dir, text }]);
  };

  const tools = useMemo(() => {
    // Tools are optional in this starter. We also do a robust out-of-band JSON update after each assistant turn.
    // If the model calls these tools, we log it; the "real" canon source of truth is still the Society Bible.
    return [
      {
        type: "function",
        name: "society_propose_bible_update",
        description: "Propose small canon additions and open threads for the Society Bible. Keep it consistent.",
        parameters: {
          type: "object",
          properties: {
            addCanon: { type: "array", items: { type: "string" } },
            addOpenThreads: { type: "array", items: { type: "string" } },
            contradictionsFound: { type: "array", items: { type: "string" } },
            reconciliationOptions: { type: "array", items: { type: "string" } },
          },
          required: ["addCanon", "addOpenThreads", "contradictionsFound", "reconciliationOptions"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "society_propose_image_scene",
        description: "Propose a vivid image scene prompt that illustrates the society consistently with canon.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            prompt: { type: "string" },
            negativePrompt: { type: "string" },
          },
          required: ["title", "prompt", "negativePrompt"],
          additionalProperties: false,
        },
      },
    ];
  }, []);

  const sendEvent = (evt: any) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(evt));
    addLog("out", JSON.stringify(evt));
  };

  async function start() {
    setConnecting(true);
    setLiveTranscript("");
    try {
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Remote audio playback
      const audio = new Audio();
      audio.autoplay = true;
      remoteAudioRef.current = audio;
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0];
        audio.play().catch(() => {});
      };

      // Local mic
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });      pc.addTrack(ms.getAudioTracks()[0], ms);

      // Data channel for events
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        addLog("sys", "Data channel open.");
        setConnected(true);
        setConnecting(false);

        const sessionInstructions = `${systemInstructions(playfulness)}\n\n${bibleSummaryForModel(bible)}`;
        // Session guardrails + tool config.
        // Note: voice must match the server session voice before the first audio response.
        sendEvent(
          mkSessionUpdate({
            type: "realtime",
            model: "gpt-realtime",
            output_modalities: ["audio"],
            instructions: sessionInstructions,
            tools,
            tool_choice: "auto",
            // Keep default VAD (semantic_vad); you can disable auto responses later if you want more control.
          })
        );

        // Send a proactive greeting so the AI immediately invites the user to play.
        sendEvent(
          mkResponseCreate({
            output_modalities: ["audio"],
            instructions:
              "Greet warmly, then invite the first move. Say: 'You ready to play Society? Why don’t you start: what’s the most important thing in this society?' Optionally offer 2–3 example answers (e.g., empathy, honor, efficiency). Keep it short and speakable.",
            metadata: { topic: "greeting" },
          })
        );
      };

      dc.onmessage = (e) => handleServerEvent(e.data);

      pc.onconnectionstatechange = () => {
        addLog("sys", `pc.connectionState=${pc.connectionState}`);
        if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
          stop();
        }
      };

      // Offer/Answer exchange via your server (unified interface)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResp = await fetch(`/api/realtime-session?voice=${encodeURIComponent(voice)}`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
      });

      if (!sdpResp.ok) {
        const err = await sdpResp.text();
        throw new Error(err);
      }

      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      addLog("sys", "WebRTC connected; waiting for session.created...");
      setConnecting(false);
    } catch (err: any) {      setConnecting(false);
      addLog("sys", `Start error: ${String(err?.message ?? err)}`);
      stop();
    }
  }

  function stop() {
    setConnected(false);
    setConnecting(false);
    const dc = dcRef.current;
    if (dc) {
      try { dc.close(); } catch {}
      dcRef.current = null;
    }
    const pc = pcRef.current;
    if (pc) {
      try { pc.close(); } catch {}
      pcRef.current = null;
    }
    const audio = remoteAudioRef.current;
    if (audio) {
      try { audio.srcObject = null; } catch {}
      remoteAudioRef.current = null;
    }
    addLog("sys", "Stopped.");
  }

  // --- Server event handling --------------------------------------------------

  const handleServerEvent = async (raw: string) => {
    let evt: any = null;
    try { evt = JSON.parse(raw); } catch { return; }

    // Keep the log readable
    if (evt?.type) addLog("in", `${evt.type}`);

    if (evt.type === "error") {    }

    // Transcript deltas (audio transcript)
    if (evt.type === "response.output_audio_transcript.delta") {
      const delta = evt?.delta ?? "";
      setLiveTranscript((t) => t + delta);
      return;
    }

    if (evt.type === "response.output_audio_transcript.done") {
      const transcript = evt?.transcript ?? liveTranscript;
      lastAssistantTranscriptRef.current = transcript;
      setBible((b) => ({ ...b, lastAiUtterance: transcript }));
      setLiveTranscript("");

      // After the model speaks, we do an out-of-band JSON update to propose canon changes.
      // This avoids tool-calling interrupting speech.
      await requestOobBibleUpdate(transcript);
      return;
    }

    // Final response object (can also carry function calls)
    if (evt.type === "response.done") {
      // If this was our recap or OOB update, it'll have metadata.topic.
      const topic = evt?.response?.metadata?.topic;

      // Handle function calling outputs if present.
      const output = evt?.response?.output ?? [];
      for (const item of output) {
        if (item?.type === "function_call") {
          await handleFunctionCall(item);
        }
      }

      if (topic === "recap") {
        const text = extractTextFromResponse(evt);
        const parsed = safeJsonParse<any>(text);
        if (parsed?.canonRecap) {
          addLog("sys", `Recap: ${parsed.canonRecap.join(" | ")}`);
        } else {
          addLog("sys", `Recap (raw): ${text.slice(0, 600)}`);
        }
      }

      if (topic === "bible_update") {
        const text = extractTextFromResponse(evt);
        const parsed = sanitizeUpdate(safeJsonParse<Partial<BibleUpdate>>(text));
        if (parsed) {
          applyBibleUpdate(parsed);
        } else {
          addLog("sys", `Could not parse bible_update JSON. Raw: ${text.slice(0, 500)}`);
        }
      }

      return;
    }
  };

  function extractTextFromResponse(evt: any): string {
    // response.output may include content parts; keep this defensive.
    const out = evt?.response?.output ?? [];
    let combined = "";
    for (const o of out) {
      if (o?.type === "message") {
        const content = o?.content ?? [];
        for (const c of content) {
          if (c?.type === "output_text" && typeof c?.text === "string") combined += c.text;
        }
      }
      // Some servers may put text directly on output items (rare).
      if (typeof o?.text === "string") combined += o.text;
    }
    return combined.trim();
  }

  async function handleFunctionCall(item: any) {
    const name = item?.name;
    const call_id = item?.call_id;
    const args = safeJsonParse<any>(item?.arguments ?? "{}") ?? {};
    addLog("sys", `Function call: ${name}(${JSON.stringify(args)})`);

    if (!call_id || !name) return;

    // We treat these as suggestions; apply carefully.
    if (name === "society_propose_bible_update") {
      const parsed = sanitizeUpdate(args);
      if (parsed) applyBibleUpdate(parsed);
      // Send function_call_output acknowledgement so the model can continue if needed.
      sendEvent({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id, output: JSON.stringify({ ok: true }) },
      });
      // Only create a response if this function call was the only output (avoid double-speaking).
      // We can't fully know here, but it's generally safe to skip.
      return;
    }

    if (name === "society_propose_image_scene") {
      // Just log in starter; you'll likely generate images from these later.
      sendEvent({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id, output: JSON.stringify({ ok: true }) },
      });
      return;
    }

    sendEvent({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id, output: JSON.stringify({ ok: false, error: "unknown_function" }) },
    });
  }

  async function requestOobBibleUpdate(lastTranscript: string) {
    const prompt = oobUpdatePrompt(bible, lastTranscript);
    sendEvent(
      mkResponseCreate({
        conversation: "none",
        metadata: { topic: "bible_update" },
        output_modalities: ["text"],
        instructions: prompt,
      })
    );
  }

  function applyBibleUpdate(update: BibleUpdate) {
    setBible((prev) => {
      const turn = prev.turnCount + 1;
      let next = bumpTurn(prev);
      next.lastAiUtterance = lastAssistantTranscriptRef.current || prev.lastAiUtterance;
      if (update.addCanon?.length) next = addCanonLines(next, update.addCanon, turn);
      if (update.addOpenThreads?.length) next = addOpenThreads(next, update.addOpenThreads);
      return next;
    });
  }

  // --- UI actions -------------------------------------------------------------

  const onRecap = () => {
    sendEvent(
      mkResponseCreate({
        conversation: "none",
        metadata: { topic: "recap" },
        output_modalities: ["text"],
        instructions: recapPrompt(bible),
      })
    );
  };

  const onUndo = () => {
    setBible((prev) => {
      const next = structuredClone(prev);
      next.changelog.pop();
      return next;
    });
    addLog("sys", "Undo: removed last canon line.");
  };

  const onGenerateImage = async () => {
    const prompt = imagePromptFromBible(bible);
    addLog("sys", "Generating image...");
    const r = await fetch("/api/image-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, size: "1024x1024" }),
    });
    if (!r.ok) {
      addLog("sys", `Image error: ${await r.text()}`);
      return;
    }
    const data = (await r.json()) as { b64: string };
    setImages((prev) => [
      ...prev,
      { b64: data.b64, title: `Turn ${bible.turnCount}: civic space`, at: new Date().toLocaleString() },
    ]);
  };

  useEffect(() => () => stop(), []);

  return (
    <div className="card">
      <div className="kv" style={{ justifyContent: "space-between" }}>
        <div className="kv">
          <strong>Realtime voice</strong>
          <span className="tag">{connected ? "connected" : connecting ? "connecting…" : "offline"}</span>
        </div>

        <div className="kv">
          <label className="tag">
            Voice{" "}
            <select
              value={voice}
              disabled={connected || connecting}
              onChange={(e) => setVoice(e.target.value as any)}
              style={{ marginLeft: 6 }}
            >
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>

          <label className="tag">
            Play{" "}
            <select
              value={playfulness}
              disabled={connected || connecting}
              onChange={(e) => setPlayfulness(Number(e.target.value) as Playfulness)}
              style={{ marginLeft: 6 }}
            >
              <option value={0}>0</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>

          {!connected ? (
            <button onClick={start} disabled={connecting}>
              Start
            </button>
          ) : (
            <button onClick={stop}>Stop</button>
          )}
        </div>
      </div>

      <hr />

      <div className="kv">
        <button onClick={onRecap} disabled={!connected}>
          Recap
        </button>
        <button onClick={onUndo}>
          Undo last canon line
        </button>
        <button onClick={onGenerateImage}>
          Generate image
        </button>
        <span className="tag">Tip: wear headphones to avoid echo.</span>
      </div>

      <hr />

      <div style={{ display: "grid", gap: 10 }}>
        <section>
          <strong>Live transcript (assistant)</strong>
          <div className="card" style={{ borderRadius: 10 }}>
            {liveTranscript ? <pre>{liveTranscript}</pre> : <small className="muted">Waiting…</small>}
          </div>
        </section>

        <section>
          <strong>Event log</strong>
          <div className="card" style={{ borderRadius: 10, maxHeight: 240, overflow: "auto" }}>
            {log.length === 0 ? (
              <small className="muted">No events yet.</small>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {log.slice().reverse().slice(0, 120).map((l, i) => (
                  <div key={i}>
                    <span className="tag">{l.at}</span>{" "}
                    <span className="tag">{l.dir}</span>{" "}
                    <span style={{ fontSize: 12 }}>{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
