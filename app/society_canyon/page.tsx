import { permanentRedirect } from "next/navigation";

// The old "/society_canyon" address is retired — the game now lives at the app
// root (edfornieles.com/society, where basePath=/society). permanentRedirect
// honors basePath, so redirect("/") resolves to /society. 308 (permanent) so
// bookmarks/shared links to the old canyon URL update to the new one.
export default function SocietyCanyonPage() {
  permanentRedirect("/");
}
