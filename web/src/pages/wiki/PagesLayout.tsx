// Pages' frame (contracts/pages.md): the wiki's, in Pages' area.

import { AreaProvider } from "@/lib/wiki/area";
import { AreaFrame } from "./WikiLayout";

export default function PagesLayout() {
  return (
    <AreaProvider area="pages">
      <AreaFrame />
    </AreaProvider>
  );
}
