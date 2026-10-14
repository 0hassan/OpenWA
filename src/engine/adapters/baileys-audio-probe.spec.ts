import { probeAudio, WAVEFORM_BARS } from './baileys-audio-probe';

const u32be = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};

/** FORM/AIFF whose ID3 chunk declares 0xffffff00 bytes: music-metadata's file read aborts its process on it. */
function oversizedAiff(): Buffer {
  const body = Buffer.concat([
    Buffer.from('AIFF'),
    Buffer.from('ID3 '),
    u32be(0xffffff00),
    Buffer.from('ID3\x04', 'latin1'),
  ]);
  return Buffer.concat([Buffer.from('FORM'), u32be(body.length), body]);
}

/** Unsigned 8-bit mono PCM at 8 kHz: a square wave, so every stretch of it is as loud as any other. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Buffer.alloc(rate * seconds);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.floor(i / 20) % 2 === 0 ? 200 : 56;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28); // bytes per second
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

describe('probeAudio', () => {
  // Each probe is a Node process that loads a parser, and a decoder for a voice note.
  jest.setTimeout(60_000);

  it('reads the duration of an audio file', async () => {
    const probe = await probeAudio(wav(3), false);

    expect(probe.seconds).toBe(3);
    expect(probe.waveform).toBeUndefined();
  });

  it('reads the waveform of a voice note as 64 bars scaled so the loudest is 100', async () => {
    const probe = await probeAudio(wav(3), true);

    expect(probe.seconds).toBe(3);
    expect(probe.waveform).toBeInstanceOf(Uint8Array);
    expect(probe.waveform).toHaveLength(WAVEFORM_BARS);
    expect(Math.max(...(probe.waveform as Uint8Array))).toBe(100);
  });

  it('answers nothing for bytes no parser reads, rather than rejecting', async () => {
    await expect(probeAudio(Buffer.from('not audio at all'), true)).resolves.toEqual({});
  });

  it('survives a file that aborts the process of a reader that opens it', async () => {
    // Opened as a file, music-metadata dies on this one with SIGABRT in node::fs::Read. Whatever the
    // child does with it, the caller must get an answer and keep running.
    await expect(probeAudio(oversizedAiff(), false)).resolves.toEqual({});
    await expect(probeAudio(oversizedAiff(), true)).resolves.toEqual({});
  });
});
