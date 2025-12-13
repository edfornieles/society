import type { SocietyBible } from "@/lib/societyBible";

export function SocietyBiblePanel({ bible }: { bible: SocietyBible }) {
  return (
    <div className="card">
      <div className="kv" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>Society Bible</strong> <span className="tag">Turn {bible.turnCount}</span>
        </div>
      </div>

      <hr />

      <div style={{ display: "grid", gap: 10 }}>
        <section>
          <strong>Open threads</strong>
          <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
            {bible.openThreads.length === 0 ? (
              <small className="muted">None yet.</small>
            ) : (
              bible.openThreads.slice(-10).map((t, i) => (
                <div key={i} className="tag">
                  {t}
                </div>
              ))
            )}
          </div>
        </section>

        <section>
          <strong>Changelog (recent canon)</strong>
          <div style={{ marginTop: 6, display: "grid", gap: 8 }}>
            {bible.changelog.length === 0 ? (
              <small className="muted">Start speaking to create canon.</small>
            ) : (
              bible.changelog.slice(-12).reverse().map((c, i) => (
                <div key={i}>
                  <div className="tag">Turn {c.turn}</div>
                  <div style={{ marginTop: 4 }}>{c.entry}</div>
                  <small className="muted">{c.at}</small>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
