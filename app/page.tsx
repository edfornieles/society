import { HomeClient } from "./HomeClient";

// Render the game at the app root so it serves at the bare deploy path
// (edfornieles.com/society, where basePath=/society) — no redirect hop.
// The /society_canyon route still renders the same thing for backward-compat
// with existing links.
export default function Page() {
  return <HomeClient />;
}
