"use client";

import { useEffect } from "react";
import { aiRulesSections, playerRulesSections } from "@/lib/rules";

export function RulesPanel() {
  useEffect(() => {  }, []);

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

