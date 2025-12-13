import { SocietyProvider } from "./components/SocietyContext";
import { SessionPickerV2 } from "./components/SessionPickerV2";
import { VoiceConsoleV2 } from "./components/VoiceConsoleV2";
import { SocietyBiblePanelV2 } from "./components/SocietyBiblePanelV2";
import { ImageStripV2 } from "./components/ImageStripV2";
import { RulesPanel } from "./components/RulesPanel";
import { SessionRecordPanelV2 } from "./components/SessionRecordPanelV2";

export default function Page() {
  return (
    <SocietyProvider>
      <main>
        <h1>Society — realtime voice prototype</h1>
        <small className="muted">
          A spoken, yes-and worldbuilding game. Take turns inventing a fictional society. The AI should feel like a good friend.
        </small>

        <div className="row" style={{ marginTop: 16 }}>
          <div className="col" style={{ flex: 0.55 }}>
            <SessionPickerV2 />
          </div>
          <div className="col" style={{ flex: 1.2 }}>
            <VoiceConsoleV2 />
          </div>
          <div className="col" style={{ flex: 0.8, display: "grid", gap: 16 }}>
            <SocietyBiblePanelV2 />
            <RulesPanel />
            <SessionRecordPanelV2 />
          </div>
          <div className="col" style={{ flex: 0.7 }}>
            <ImageStripV2 />
          </div>
        </div>
      </main>
    </SocietyProvider>
  );
}
