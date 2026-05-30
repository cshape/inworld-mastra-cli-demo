import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { InworldRealtimeVoice } from '@mastra/voice-inworld';
import { z } from 'zod';

const getCurrentTime = createTool({
  id: 'get-current-time',
  description: 'Returns the current local time.',
  inputSchema: z.object({}),
  outputSchema: z.object({ time: z.string() }),
  execute: async () => ({ time: new Date().toLocaleTimeString() }),
});

const voice = new InworldRealtimeVoice({
  // Defaults: model 'inworld/models/gemma-4-26b-a4b-it', speaker 'Sarah',
  // STT 'inworld/inworld-stt-1', semantic-VAD turn detection.
  // Override any of these here (e.g. model: 'openai/gpt-5.4-nano', speaker: 'Jason').
  session: {
    audio: {
      input: {
        // 'low' makes semantic VAD wait for clearer end-of-turn pauses before
        // the bot responds — it was jumping in too quickly on 'medium'. This
        // also gives back-channels a clean window to play during your speech
        // without a competing main-response player fighting for the audio device.
        turn_detection: { type: 'semantic_vad', eagerness: 'low' },
      },
    },
  },
  providerData: {
    // Back-channels ("uh-huh", "I see") are short interjections the agent
    // emits WHILE you're still speaking. They're meant to overlap your speech,
    // so they are deliberately NOT cancelled by barge-in (see the `backchannel`
    // handler below). Gated by server prerequisites — ask your Inworld account team.
    //
    // Tuned aggressive for testing — fire early and often. Dial these back
    // toward the defaults (min_speech_ms 800, min_gap_ms 4000, max_per_turn 3,
    // eval_interval_ms 800) for production naturalness.
    backchannel: {
      enabled: true,
      min_speech_ms: 400, // start interjecting sooner after you begin speaking (default 800)
      min_gap_ms: 1200, // allow them closer together (default 4000)
      max_per_turn: 6, // more interjections per user turn (default 3)
      eval_interval_ms: 400, // evaluate eligibility more often (default 800)
    },
  },
});

new Agent({
  id: 'voice-demo',
  name: 'Voice Demo',
  instructions: 'You are a concise voice assistant. Reply in one or two short sentences. Use the get-current-time tool when asked the time.',
  model: 'n/a',
  tools: { getCurrentTime },
  // Cast: voice packages bundle their own copy of MastraVoice's base class
  // (extracted into the private @internal/voice package), whose ECMAScript
  // private brand differs from the @mastra/core copy the Agent's type expects.
  // The two are interchangeable at runtime; only the structural type check
  // trips on the private brand. This affects every current voice package.
  voice: voice as unknown as Agent['voice'],
});

const SOX = ['-t', 'raw', '-r', '24000', '-e', 'signed', '-b', '16', '-c', '1', '-q', '-'];

// Main responses: ONE short-lived `play` per response, keyed by response_id.
// Killing the process is the only way to stop playback instantly on barge-in —
// piping into a shared persistent player can't, because the OS pipe + sox
// buffers already hold up to ~1s of audio that keeps draining after you stop
// feeding it. So main responses get their own killable players.
const players = new Map<string, ChildProcess>();

voice.on('speaker', stream => {
  // A new response supersedes the previous one — kill leftover main players.
  for (const p of players.values()) p.kill('SIGTERM');
  players.clear();
  const id = (stream as unknown as { id: string }).id;
  const player = spawn('play', SOX, { stdio: ['pipe', 'ignore', 'ignore'] });
  players.set(id, player);
  player.stdin!.on('error', () => {}); // swallow EPIPE when killed mid-flush
  stream.pipe(player.stdin!);
  player.on('exit', () => players.delete(id));
});

// Barge-in: kill the interrupted response's player for an INSTANT stop. The SDK
// also sent `response.cancel` to stop the server. Back-channels live on a
// separate, persistent output (below) and are deliberately never killed here.
voice.on('interrupted', ({ response_id }) => players.get(response_id)?.kill('SIGTERM'));

// Back-channels: ONE persistent `play` opened up front. A fresh `play` per clip
// pays ~100-300ms of device-open latency — longer than a short "mhm", so those
// were only a blip. A warm, always-open device makes them audible. `--buffer
// 1024` (~20ms block) flushes each clip's tail so consecutive back-channels
// don't bleed together. We never kill this (back-channels overlap your speech).
const bc = spawn('play', ['--buffer', '1024', ...SOX], { stdio: ['pipe', 'ignore', 'ignore'] });
bc.stdin!.on('error', () => {});

// Single label-tracking printer so transcripts and back-channel lines never
// run together. A new label (you / bot / backchannel) starts a fresh line;
// same-label text appends. `endLine()` resets the label so the next write —
// even same role — starts a new line.
let lastLabel: string | null = null;
function print(label: string, text: string) {
  if (label !== lastLabel) {
    process.stdout.write(`\n[${label}] `);
    lastLabel = label;
  }
  process.stdout.write(text);
}
function endLine() {
  lastLabel = null;
}

// "Is the user speaking?" gate for back-channels. A back-channel is decided
// from your last partial transcript, so one can be synthesized just after you
// stop and land in the post-turn silence. We only play back-channels while
// you're speaking: mark speaking on the start signals (VAD speech-started, or
// barge-in) and stopped on the end signals (VAD speech-stopped, or your
// finalized transcript — the transcript is the reliable backstop because
// semantic-VAD edges don't always fire).
let speaking = false;
voice.on('speech-started', () => {
  speaking = true;
});
voice.on('interrupted', () => {
  speaking = true;
});
voice.on('speech-stopped', () => {
  speaking = false;
});

// Back-channels share the single output and are never stopped once playing.
// Track which actually played so only those print a line.
const playingBc = new Set<string>();
voice.on('backchannel', stream => {
  const id = (stream as unknown as { id: string }).id;
  if (!speaking) {
    stream.resume(); // arrived after you stopped — discard so it doesn't play late
    return;
  }
  playingBc.add(id);
  stream.pipe(bc.stdin!, { end: false });
});
voice.on('backchannel.done', ({ backchannel_id, phrase }) => {
  if (playingBc.delete(backchannel_id) && phrase) {
    print('backchannel', phrase);
    endLine();
  }
});
voice.on('backchannel.skipped', () => {});

voice.on('writing', ({ text, role }) => {
  if (text === '\n') {
    if (role === 'user') speaking = false; // finalized transcript = your turn ended
    endLine(); // turn finished — next line gets a fresh label
    return;
  }
  print(role === 'user' ? 'you' : 'bot', text);
});

voice.on('tool-call-start', ({ toolName }) => {
  print('tool', toolName);
  endLine();
});
voice.on('error', err => {
  endLine();
  console.error('\n[error]', err);
});

await voice.connect();
console.log('Connected. Use headphones for best experience. Speak when ready. Ctrl+C to exit.');

const mic = spawn('sox', ['-d', ...SOX], { stdio: ['ignore', 'pipe', 'ignore'] });
await voice.send(mic.stdout);

process.on('SIGINT', () => {
  mic.kill('SIGTERM');
  for (const p of players.values()) p.kill('SIGTERM');
  bc.kill('SIGTERM');
  voice.close();
  process.exit(0);
});
