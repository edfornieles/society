"use client";

import { SocietyBiblePanel } from "./SocietyBiblePanel";
import { useSociety } from "./SocietyContext";

export function SocietyBiblePanelV2() {
  const { bible } = useSociety();
  return <SocietyBiblePanel bible={bible} />;
}
