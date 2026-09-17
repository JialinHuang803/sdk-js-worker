function releaseSection(changelog: string, version: string): string[] | null {
  const lines = changelog.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const section: string[] = [];
  let found = false;
  let fence: string | null = null;
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = line.match(/^ {0,3}##\s+(.+?)\s*#*\s*$/)?.[1];
    if (heading) {
      if (found) break;
      const headingVersion = heading.match(/^\[?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?:\]|\s|$)/)?.[1];
      found = headingVersion === version;
      continue;
    }
    if (found) section.push(line);
  }
  return found ? section : null;
}

function breakingEntries(section: string[]): string[] {
  const entries: string[] = [];
  let level: number | null = null;
  for (const line of section) {
    const heading = line.match(/^ {0,3}(#{3,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (level !== null && heading[1].length <= level) level = null;
      if (/^breaking changes$/i.test(heading[2])) level = heading[1].length;
      else if (level !== null) entries.push(heading[2]);
      continue;
    }
    if (level !== null && line.trim()) entries.push(line.trim());
  }
  return entries;
}

export function detectBreakingChanges(
  head: string | null,
  base: string | null,
  version: string | null,
): boolean | null {
  if (head === null || version === null) return null;
  const section = releaseSection(head, version);
  if (section === null) return null;
  const entries = breakingEntries(section);
  const previous = new Set(
    breakingEntries(base === null ? [] : releaseSection(base, version) ?? []),
  );
  return entries.some((entry) => !previous.has(entry));
}
