import { SocietyProvider } from "./components/SocietyContext";
import { GameShell } from "./components/GameShell";

export default function PageV2() {
  return (
    <SocietyProvider>
      <GameShell />
    </SocietyProvider>
  );
}
