import { SocietyProvider } from "./components/SocietyContext";
import { GameShell } from "./components/GameShell";

export default function Page() {
  return (
    <SocietyProvider>
      <GameShell />
    </SocietyProvider>
  );
}
