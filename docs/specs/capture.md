# Spec: Capture

## Sources

- `RecorderSource`: browser recording (mic + system/tab audio).
- `MediaImportSource`: existing audio/video files (needs ffmpeg).
- `WatchedFolderSource`: chokidar on configured folders; documents go to ingest, media to `MediaImportSource`.
- `ArchiveImportSource`: see the importers in CONNECTORS.md.
- `CaptureSource` interface, reserved for future passive screen capture (not in V1).

## Browser recorder (Windows: Chrome or Edge)

1. **Consent modal.** Two checkboxes ("participants informed", "laws vary by jurisdiction"), meeting or lecture type, optional notebook, optional linked calendar event (prefilled from the current event). Consent is logged to the audit log.
2. `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })` for the mic.
3. `getDisplayMedia({ video: true, audio: true, systemAudio: 'include' })`. The user picks a **tab** (with "Share tab audio") or the **entire screen** (with "Share system audio", which captures native Zoom/Teams/Meet apps on Windows). The video track is stopped immediately. If no audio track is returned, the recorder shows "system audio not shared — mic only" and continues.
4. An AudioWorklet downmixes each source to 16 kHz mono Int16. The two sources are kept as **separate channels** (mic, system).
5. Every 5 s it POSTs `PUT /api/v1/recordings/:id/chunks/:n` with both channels. The daemon appends them to `blobs/rec/<id>/{mic,system}.pcm`. A lost tab loses at most 5 s. On reload, the recorder offers "finish recording" for an unfinished session.
6. Indicator: a red dot in the UI header, "● REC" in the tab title, and an elapsed timer. Stop = one click. `beforeunload` warns while recording.

`http://127.0.0.1` is a secure context, so capture APIs work without TLS.

## Transcription

- The daemon writes WAV headers and runs `whisper-cli -m ggml-small.bin -f mic.wav -oj -t <cores-2>`. It's run separately per channel and outputs JSON segments with timestamps.
- Channel → `speaker_label`: mic = "You", system = "Others". Only one channel → "mixed".
- **Echo dedup:** if a mic segment overlaps a system segment in time and the text similarity (token Jaccard) is > 0.6, drop the mic one.
- Language: auto-detect by default. Setting: force `en` (faster). Multilingual models are used if you choose them.
- It's a heavy job, serialized with Ollama-heavy jobs. Progress is reported via SSE.
- Speed check in `doctor`: if `small` runs slower than 0.5× real time on this CPU, default to `base`.

## After transcription

`meeting` document (anchors = transcript windows ≤ 60 s) → ingest → `understand` job (see the assistant spec) → if a notebook is set, the document is added to `notebook_sources` → deadlines and promises go to `commitments`.

## Media import

`ffmpeg -i in -ac 1 -ar 16000 -f s16le` gives PCM, then the same pipeline with channel = mixed. Supported: anything ffmpeg reads.

## Known limitations (documented in the README)

- No true diarization. "You vs Others" only, and "Others" isn't split by person.
- On macOS, system audio via `getDisplayMedia` depends on the macOS and Chrome versions. Tab audio works. This isn't targeted in V1.
- On Linux, system audio support varies (PipeWire); tab audio works.
- No live captions in V1.
- Recording legality is the user's responsibility. The consent prompt is a reminder, not legal compliance.
