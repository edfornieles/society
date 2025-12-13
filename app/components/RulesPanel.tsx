"use client";

import { useEffect } from "react";
import { aiRulesSections, playerRulesSections } from "@/lib/rules";

export function RulesPanel() {
  useEffect(() => {
    // #region agent log
    fetch("http://127.0.0.1:7242/ingest/b2dae784-5015-4eea-b33c-5e75d4eaa8bc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "debug-session",
        runId: "pre-rules",
        hypothesisId: "H2",
        location: "RulesPanel:useEffect",
        message: "Rules panel rendered",
        data: { playerSections: playerRulesSections.length, aiSections: aiRulesSections.length },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
  }, []);

  return (
    <div className="card">
      <div className="kv" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>Rules</strong> <span className="tag">Always-on</span>
        </div>
      </div>

      <hr />

      <section style={{ display: "grid", gap: 8 }}>
        <strong>Player rules</strong>
        {playerRulesSections.map((section) => (
          <div key={section.title}>
            <div className="tag">{section.title}</div>
            <ul style={{ margin: "6px 0 12px 16px" }}>
              {section.bullets.map((b, i) => (
                <li key={i} style={{ lineHeight: 1.4 }}>
                  {b}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <hr />

      <section style={{ display: "grid", gap: 8 }}>
        <strong>AI facilitator rules</strong>
        {aiRulesSections.map((section) => (
          <div key={section.title}>
            <div className="tag">{section.title}</div>
            <ul style={{ margin: "6px 0 12px 16px" }}>
              {section.bullets.map((b, i) => (
                <li key={i} style={{ lineHeight: 1.4 }}>
                  {b}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

