import { useUIStore, type Venue } from "../../stores/ui";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

const VENUES: { id: Venue; label: string }[] = [
  { id: "all", label: "All" },
  { id: "robinhood", label: "Robinhood" },
  { id: "kalshi", label: "Kalshi" },
];

/** All / Robinhood / Kalshi — one selection shared by the Portfolio and Activity tabs. */
export function VenueSwitch() {
  const venue = useUIStore((s) => s.venue);
  const setVenue = useUIStore((s) => s.setVenue);
  return (
    <ToggleGroup
      type="single"
      value={venue}
      onValueChange={(v) => v && setVenue(v as Venue)}
      className="w-full gap-1 rounded-md border border-border p-0.5"
    >
      {VENUES.map((v) => (
        <ToggleGroupItem
          key={v.id}
          value={v.id}
          className="flex-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground data-[state=on]:bg-muted data-[state=on]:font-medium data-[state=on]:text-foreground"
        >
          {v.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
