"use client";

import { SocietyProvider } from "./components/SocietyContext";
import { GameShell } from "./components/GameShell";

export function HomeClient() {
  return (
    <SocietyProvider>
      <GameShell />
    </SocietyProvider>
  );
}
