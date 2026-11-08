/** 8 → "8 min", 130 → "2 hr", 3000 → "2 d". */
export function ageLabel(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} hr`;
  return `${Math.floor(m / 1440)} d`;
}

/** "SECTION I – LOSSES INSURED > COVERAGE A – DWELLING" → "Coverage A – Dwelling". */
export function sectionLabel(section: string): string {
  const last = section.split(">").at(-1)!.trim();
  return last.toLowerCase().replace(/(^|[\s–-])([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Of|And|The|To|For)\b/g, (w) => w.toLowerCase());
}

export function dayLabel(minutesAgo: number): string {
  if (minutesAgo < 1440) return "Today";
  if (minutesAgo < 2880) return "Yesterday";
  return `${Math.floor(minutesAgo / 1440)} days ago`;
}
