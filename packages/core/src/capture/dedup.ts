import { tokenJaccard } from "../text/similarity.ts";
import type { WhisperSegment } from "./whisper-run.ts";

export const ECHO_JACCARD = 0.6;

/**
 * Without headphones the mic also hears the other side. A mic segment that overlaps a system
 * segment in time and says nearly the same words (token Jaccard > 0.6) is that echo: drop it
 * and keep the clean system copy (capture.md "Echo dedup").
 */
export function dropEchoes(mic: WhisperSegment[], system: WhisperSegment[]): WhisperSegment[] {
  return mic.filter(
    (m) =>
      !system.some(
        (s) =>
          s.startMs < m.endMs && m.startMs < s.endMs && tokenJaccard(m.text, s.text) > ECHO_JACCARD,
      ),
  );
}
