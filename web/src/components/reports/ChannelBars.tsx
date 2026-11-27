import { useTranslation } from "react-i18next";
import type { Channel, ReportsOverview } from "@/lib/api/types";
import { ChannelIcon, channelLabel } from "@/components/tickets/bits";
import { channelTone } from "@/lib/tones";
import { BreakdownBars, ShareBar, type BarRow } from "./Bars";

const order: Channel[] = ["email", "chat", "portal", "api", "phone", "whatsapp"];

/** Each channel in its own tone: a share strip on top, ranked bars under it. */
export function ChannelBars({ data }: { data: ReportsOverview["by_channel"] }) {
  const { t } = useTranslation("reports");
  useTranslation("indicators");
  const rows: BarRow[] = order
    .map((c) => ({ id: c, label: channelLabel(c), text: channelLabel(c), value: data[c] ?? 0, tone: channelTone[c], icon: <ChannelIcon channel={c} /> }))
    .sort((a, b) => b.value - a.value);
  return (
    <div className="flex flex-col gap-5">
      <ShareBar rows={rows} />
      <BreakdownBars rows={rows} unit={(n) => t("unit.tickets", { count: n })} />
    </div>
  );
}
