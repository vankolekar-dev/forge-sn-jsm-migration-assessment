/** Minimal --flag value / --switch parser (no dependency). */
export function parseArgs(argv: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (inline !== undefined) flags[k] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[k] = argv[++i]!;
    else flags[k] = true;
  }
  return { flags, positional };
}

export const str = (v: string | true | undefined, fallback?: string): string | undefined => (typeof v === 'string' ? v : fallback);
