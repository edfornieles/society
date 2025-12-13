import { SocietyProvider } from "./components/SocietyContext";
import { VoiceConsoleV2 } from "./components/VoiceConsoleV2";
import { SocietyBiblePanelV2 } from "./components/SocietyBiblePanelV2";
import { ImageStripV2 } from "./components/ImageStripV2";
import { RulesPanel } from "./components/RulesPanel";

export default function PageV2() {
  return (
    <SocietyProvider>
      <main>
        <h1>Society — realtime voice prototype (V2)</h1>
        <small className="muted">
          V2 lifts state into a shared context so Bible + images update live.
        </small>

        <div className="row" style={{ marginTop: 16 }}>
          <div className="col" style={{ flex: 1.2 }}>
            <VoiceConsoleV2 />
          </div>
          <div className="col" style={{ flex: 0.8, display: "grid", gap: 16 }}>
            <SocietyBiblePanelV2 />
            <RulesPanel />
            <ImageStripV2 />
          </div>
        </div>
      </main>
    </SocietyProvider>
  );
}
