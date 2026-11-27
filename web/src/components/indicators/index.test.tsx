import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, loadAgentCatalogs } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { channelItems, priorityItems, severityItems, statusItems } from "@/components/settings2/pickers";
import { presets, rangeLabel } from "@/components/reports/RangePicker";
import { VolumeLegend, VolumeTable } from "@/components/reports/VolumeChart";
import { ChannelIcon, PriorityIcon, PriorityPill, SentimentIcon, SeverityChip, SeverityPill, SlaPill, SpamIcon, StatusIcon, StatusPill, slaState } from ".";

// The agent app loads its French catalogs before rendering (the root route's loader).
beforeAll(() => loadAgentCatalogs("fr"));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await i18n.changeLanguage("en");
  vi.unstubAllGlobals();
});

describe("indicator localization", () => {
  it("updates mounted standalone indicators when the French catalog loads, preserving workspace labels", async () => {
    const ticket = { status: "open" as const, sla: { first_response_due_at: new Date(Date.now() - 120000).toISOString(), resolution_due_at: null, breached: true } };
    const state = slaState(ticket);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <StatusIcon status="on_hold" />
          <PriorityIcon priority="high" />
          <PriorityIcon priority={null} />
          <SeverityChip severity="sev1" />
          <SeverityPill severity="sev2" />
          <ChannelIcon channel="portal" />
          <SentimentIcon sentiment="frustrated" />
          <SpamIcon />
          <StatusPill status="open" />
          <StatusPill status="pending" label="Waiting on supplier" />
          <PriorityPill priority="low" label="Custom priority" />
          <SlaPill ticket={ticket} />
        </TooltipProvider>,
      );
    });
    expect(container.querySelector('[aria-label="On hold"]')).not.toBeNull();
    expect(container.textContent).toContain("2m over");
    await act(async () => { await i18n.changeLanguage("fr"); });
    for (const label of ["En pause", "Élevée", "Aucune priorité", "Gravité 1", "Portail", "Frustré", "Indésirable"]) {
      expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    }
    expect(container.textContent).toContain("Ouvert");
    expect(container.textContent).toContain("Gravité 2");
    expect(container.textContent).toContain("Waiting on supplier");
    expect(container.textContent).toContain("Custom priority");
    expect(container.textContent).toContain("2m de retard");
    expect(slaState(ticket)).toEqual(state);
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.querySelector('[aria-label="On hold"]')).not.toBeNull();
  });

  it("builds localized picker labels without changing enum values", async () => {
    const english = [statusItems(), priorityItems(), severityItems(), channelItems()];
    await i18n.changeLanguage("fr");
    const french = [statusItems(), priorityItems(), severityItems(), channelItems()];
    expect(french.map((items) => items.map((item) => item.value))).toEqual(english.map((items) => items.map((item) => item.value)));
    expect(french[0].map((item) => item.label)).toEqual(["Ouvert", "En attente", "En pause", "Résolu", "Fermé"]);
    expect(french[1][1].label).toBe("Élevée");
    expect(french[2][0].hint).toBe("Panne critique");
    expect(french[3][3].label).toBe("Portail");
  });

  it("updates report legends and displayed dates while retaining ISO ranges", async () => {
    const now = new Date(2026, 9, 21, 12);
    const english = presets(now);
    await act(async () => root.render(<><VolumeLegend /><VolumeTable days={[{ date: "2026-02-04", created: 3, solved: 2 }]} /></>));
    expect(container.textContent).toContain("Created");
    expect(container.textContent).toContain("Wed, Feb 4");
    await act(async () => { await i18n.changeLanguage("fr"); });
    expect(container.textContent).toContain("Créés");
    expect(container.textContent).toContain("Résolus");
    expect(container.textContent).toContain("mer. 4 févr.");
    expect(presets(now).map((p) => p.range)).toEqual(english.map((p) => p.range));
    expect(presets(now).find((p) => p.id === "7")!.label).toBe("7 derniers jours");
    expect(rangeLabel({ from: "2026-02-04", to: "2026-02-06" })).toContain("févr.");
  });
});
