"use client";

import { useMemo, useState } from "react";
import { useSociety } from "./SocietyContext";

function asArr(x: any): string[] {
  return Array.isArray(x) ? x.map(String) : [];
}

function mdEscape(s: string) {
  return s.replaceAll("\n", " ").trim();
}

export function SessionRecordPanelV2() {
  const { summary, finalRecord } = useSociety();
  const [showRaw, setShowRaw] = useState(false);

  const parsed = useMemo(() => {
    try {
      return JSON.parse(finalRecord) as any;
    } catch {
      return null;
    }
  }, [finalRecord]);

  const markdown = useMemo(() => {
    if (!parsed) return "";
    const title = String(parsed.title ?? "Society record");
    const logline = String(parsed.logline ?? "");
    const tone = String(parsed.tone ?? "");
    const core = asArr(parsed.core_values);
    const status = asArr(parsed.status_markers);
    const taboos = asArr(parsed.taboos);
    const threads = asArr(parsed.open_threads);
    const changelog = asArr(parsed.canon_changelog);
    const inst = parsed.institutions ?? {};
    const daily = parsed.daily_life ?? {};
    const aes = parsed.aesthetics ?? {};
    const cons = parsed.constraints ?? {};

    return [
      `## ${mdEscape(title)}`,
      logline ? `\n**Logline**: ${mdEscape(logline)}` : "",
      tone ? `\n**Tone**: ${mdEscape(tone)}` : "",
      core.length ? `\n### Core values\n${core.map((x) => `- ${mdEscape(x)}`).join("\n")}` : "",
      status.length ? `\n### Status markers\n${status.map((x) => `- ${mdEscape(x)}`).join("\n")}` : "",
      `\n### Institutions`,
      inst.education ? `- **Education**: ${mdEscape(String(inst.education))}` : "- **Education**: (unknown)",
      inst.law ? `- **Law**: ${mdEscape(String(inst.law))}` : "- **Law**: (unknown)",
      inst.care ? `- **Care**: ${mdEscape(String(inst.care))}` : "- **Care**: (unknown)",
      inst.media ? `- **Media**: ${mdEscape(String(inst.media))}` : "- **Media**: (unknown)",
      inst.religion_or_myth ? `- **Religion/Myth**: ${mdEscape(String(inst.religion_or_myth))}` : "- **Religion/Myth**: (unknown)",
      `\n### Daily life`,
      daily.a_day_in_the_life ? `${mdEscape(String(daily.a_day_in_the_life))}` : "(unknown)",
      daily.housing ? `\n- **Housing**: ${mdEscape(String(daily.housing))}` : "",
      daily.work_rhythm ? `\n- **Work rhythm**: ${mdEscape(String(daily.work_rhythm))}` : "",
      daily.food_leisure ? `\n- **Food & leisure**: ${mdEscape(String(daily.food_leisure))}` : "",
      `\n### Aesthetics`,
      aes.architecture ? `- **Architecture**: ${mdEscape(String(aes.architecture))}` : "- **Architecture**: (unknown)",
      aes.fashion ? `- **Fashion**: ${mdEscape(String(aes.fashion))}` : "- **Fashion**: (unknown)",
      aes.public_ritual ? `- **Public ritual**: ${mdEscape(String(aes.public_ritual))}` : "- **Public ritual**: (unknown)",
      `\n### Constraints`,
      cons.environment ? `- **Environment**: ${mdEscape(String(cons.environment))}` : "- **Environment**: (unknown)",
      cons.resources ? `- **Resources**: ${mdEscape(String(cons.resources))}` : "- **Resources**: (unknown)",
      cons.tech_level ? `- **Tech level**: ${mdEscape(String(cons.tech_level))}` : "- **Tech level**: (unknown)",
      parsed.foreign_policy ? `\n### Foreign policy\n${mdEscape(String(parsed.foreign_policy))}` : "",
      taboos.length ? `\n### Taboos\n${taboos.map((x) => `- ${mdEscape(x)}`).join("\n")}` : "",
      threads.length ? `\n### Open threads\n${threads.map((x) => `- ${mdEscape(x)}`).join("\n")}` : "",
      changelog.length ? `\n### Canon (recent)\n${changelog.map((x) => `- ${mdEscape(x)}`).join("\n")}` : "",
      "",
    ]
      .filter(Boolean)
      .join("\n");
  }, [parsed]);

  return (
    <div className="card">
      <div className="kv" style={{ justifyContent: "space-between" }}>
        <strong>Summary so far</strong>
        <div className="kv">
          <button
            onClick={() => {
              if (!summary) return;
              navigator.clipboard.writeText(summary).catch(() => {});
            }}
            disabled={!summary}
          >
            Copy
          </button>
          <button
            onClick={() => {
              if (!summary) return;
              const blob = new Blob([summary], { type: "text/markdown;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "society-summary-so-far.md";
              a.click();
              URL.revokeObjectURL(url);
            }}
            disabled={!summary}
          >
            Download
          </button>
        </div>
      </div>
      <small className="muted" style={{ display: "block", marginTop: 4 }}>
        Generate this anytime to catch up mid-game.
      </small>
      <hr />
      {summary ? <pre>{summary}</pre> : <small className="muted">No summary yet. Press “Generate summary”.</small>}
      <hr />

      <div className="kv" style={{ justifyContent: "space-between" }}>
        <strong>Session record</strong>
        <div className="kv">
          <label className="tag">
            Raw{" "}
            <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} style={{ marginLeft: 6 }} />
          </label>
          <button
            onClick={() => {
              if (!markdown) return;
              navigator.clipboard.writeText(markdown).catch(() => {});
            }}
            disabled={!markdown}
          >
            Copy
          </button>
          <button
            onClick={() => {
              if (!markdown) return;
              const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "society-session.md";
              a.click();
              URL.revokeObjectURL(url);
            }}
            disabled={!markdown}
          >
            Download
          </button>
        </div>
      </div>
      <small className="muted" style={{ display: "block", marginTop: 4 }}>
        Saved when you press Stop.
      </small>
      <hr />
      {finalRecord ? (
        showRaw ? (
          <pre>{finalRecord}</pre>
        ) : markdown ? (
          <pre>{markdown}</pre>
        ) : (
          <pre>{finalRecord}</pre>
        )
      ) : (
        <small className="muted">No record yet. Press Stop to generate a full breakdown.</small>
      )}
    </div>
  );
}


