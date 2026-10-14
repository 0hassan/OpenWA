/**
 * A `run:` block with its shell comments removed.
 *
 * Exists because a script's only appearance in a workflow can be inside a comment, and a substring
 * match cannot tell a command from a mention — so `# ./scripts/x.sh disabled` would satisfy the
 * very checks written to catch that. Only executable lines count. Shared by the workflow-gate
 * specs (ci-privilege-gate, release-gate-parity); lives outside a .spec so importing it does not
 * drag another spec's describe blocks into the importing suite's run.
 */
export function executableLines(run: string): string {
  return run
    .split('\n')
    .map(line => {
      const hash = commentStart(line);
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join('\n');
}

/**
 * Where a shell comment starts in `line`, or -1. A `#` begins one only at the start of the line or after
 * whitespace, and outside quotes: in `npm --version#; curl x | sh` the shell runs the curl, and `$#` and
 * `${#list[@]}` are not comments either. Cutting the line at such a `#` would hide the command behind it
 * from every check that reads these lines.
 */
function commentStart(line: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === '\\' && quote === '"') i++;
      else if (char === quote) quote = null;
    } else if (char === '\\') {
      i++;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return i;
    }
  }
  return -1;
}
