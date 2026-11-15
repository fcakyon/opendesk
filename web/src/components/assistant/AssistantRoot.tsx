// Mounted once in the app shell: the floating panel (and the phone sheet) and
// the global ⌘J toggle. The docked column is AssistantDock, in the main row.
// In a ticket's reply box ⌘J asks Ollie for a draft instead: the composer handles
// the key first and marks it taken, so the toggle here skips it.

import { useShortcuts } from "@/lib/shortcuts";
import { AssistantFloat } from "./AssistantPanel";
import { useAssistantOn } from "./OllieButton";
import { ollie } from "./store";

export { AssistantDock } from "./AssistantPanel";
export { OllieButton } from "./OllieButton";

export function AssistantRoot() {
  const on = useAssistantOn();
  useShortcuts({ "global.ollie": () => ollie.toggle() }, on);
  if (!on) return null;
  return <AssistantFloat />;
}
