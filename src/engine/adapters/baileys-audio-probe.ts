import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/** What could be read from an outgoing audio file; a field is absent when it could not be read. */
export interface AudioProbe {
  /** Playing time in whole seconds. */
  seconds?: number;
  /** The amplitude bars WhatsApp draws on a voice note, 0 to 100 each. */
  waveform?: Uint8Array;
}

/** Bars on a voice note, the count Baileys' own waveform uses. */
export const WAVEFORM_BARS = 64;

/** Wall-clock ceiling for one probe; the child is killed past it. */
const PROBE_TIMEOUT_MS = 30_000;
/** What the child may print: a duration and 64 small integers, a line each. */
const MAX_OUTPUT_CHARS = 4096;
/** Probes running at once. Each is a whole Node process with a decoder loaded in it. */
const probes = new ConcurrencyLimiter(2);
/** The directory holding node_modules, whether this file runs from src/ or from dist/. */
const APP_ROOT = join(__dirname, '..', '..', '..');

/**
 * Run in the child, with the file on stdin. The same two reads Baileys makes for an outgoing audio
 * message, music-metadata for the duration and audio-decode for the voice-note bars, with the same
 * bar arithmetic, so a file both can read gets the same answer here.
 */
const PROBE_SCRIPT = `
const bars = ${WAVEFORM_BARS};
const wantWaveform = process.argv[1] === 'ptt';
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', async () => {
  const input = Buffer.concat(chunks);
  try {
    const mm = await import('music-metadata');
    const metadata = await mm.parseBuffer(input, undefined, { duration: true });
    const duration = metadata.format.duration;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
      process.stdout.write(JSON.stringify({ seconds: Math.floor(duration) }) + '\\n');
    }
  } catch {}
  if (wantWaveform) {
    try {
      const { default: decode } = await import('audio-decode');
      const raw = (await decode(input)).getChannelData(0);
      const block = Math.floor(raw.length / bars);
      const averages = [];
      for (let i = 0; i < bars; i++) {
        let sum = 0;
        for (let j = 0; j < block; j++) sum += Math.abs(raw[block * i + j]);
        averages.push(sum / block);
      }
      const peak = Math.max(...averages);
      if (peak > 0 && Number.isFinite(peak)) {
        process.stdout.write(JSON.stringify({ waveform: averages.map(value => Math.floor((100 * value) / peak)) }) + '\\n');
      }
    } catch {}
  }
});
`;

function parseProbe(output: string): AudioProbe {
  const probe: AudioProbe = {};
  for (const line of output.split('\n')) {
    let value: { seconds?: unknown; waveform?: unknown };
    try {
      value = JSON.parse(line) as { seconds?: unknown; waveform?: unknown };
    } catch {
      continue;
    }
    if (typeof value.seconds === 'number' && Number.isInteger(value.seconds) && value.seconds >= 0) {
      probe.seconds = value.seconds;
    }
    const bars = value.waveform;
    if (
      Array.isArray(bars) &&
      bars.length === WAVEFORM_BARS &&
      bars.every(bar => typeof bar === 'number' && Number.isInteger(bar) && bar >= 0 && bar <= 100)
    ) {
      probe.waveform = Uint8Array.from(bars as number[]);
    }
  }
  return probe;
}

function runProbe(data: Buffer, ptt: boolean): Promise<AudioProbe> {
  return new Promise(resolve => {
    let settled = false;
    let output = '';
    const child = spawn(process.execPath, ['-e', PROBE_SCRIPT, ptt ? 'ptt' : 'audio'], {
      cwd: APP_ROOT,
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const finish = (probe: AudioProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(parseProbe(output));
    }, PROBE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > MAX_OUTPUT_CHARS) {
        child.kill('SIGKILL');
        finish({});
      }
    });
    child.on('error', () => finish({}));
    // Whatever the child printed before it died still counts: the duration is printed before the decode.
    child.on('close', () => finish(parseProbe(output)));
    // The child may end before it has read everything it was sent.
    child.stdin.on('error', () => undefined);
    child.stdin.end(data);
  });
}

/**
 * Read the duration, and for a voice note the waveform, of an outgoing audio file in a separate process.
 *
 * Baileys makes both reads in the gateway's own process when the message does not carry them. They run
 * parsers and decoders over bytes a caller chose: a 30-byte AIFF file aborts the process in
 * music-metadata's file read, and a few hundred kilobytes of Opus packets decode into gigabytes of
 * samples. Neither is an error the caller of the gateway can catch. Here a file that does either
 * costs the child, and the answer is simply missing. Never rejects.
 */
export function probeAudio(data: Buffer, ptt: boolean): Promise<AudioProbe> {
  return probes.run(() => runProbe(data, ptt)).catch(() => ({}));
}
