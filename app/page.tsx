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

        <div className="layout mt16">
          <div className="layoutLeft">
            <SessionPickerV2 />
          </div>
          <div className="layoutCenter">
            <VoiceConsoleV2 />
          </div>
          <div className="layoutRight">
            <SocietyBiblePanelV2 />
            <RulesPanel />
            <SessionRecordPanelV2 />
          </div>
          <div className="layoutImages">
            <ImageStripV2 />
          </div>
        </div>
      </main>
    </SocietyProvider>
  );
}
