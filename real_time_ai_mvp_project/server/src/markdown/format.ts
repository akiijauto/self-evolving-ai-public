import type { SessionStatus } from "@rt-mvp/protocol";

/**
 * Markdownの整形。DATAFLOW.md の「Markdownスキーマ」に対応する。
 *
 * ここは純粋関数だけを置く。ファイルにも時計にも触らない。
 * スキーマが正しいかどうかを、入出力だけで検証できる状態を保つ。
 */

export interface Participant {
  /** 「自社」「顧客」など */
  side: string;
  names: string[];
}

export interface MeetingDoc {
  sessionId: string;
  startedAt: Date;
  endedAt: Date | null;
  title: string | null;
  participants: Participant[];
  status: SessionStatus;
}

export interface TranscriptEntry {
  /** 発話時刻(壁時計)。`## HH:MM:SS` の見出しになる */
  at: Date;
  /** 話者ラベル。話者分離が使えない場合は null で、見出しは時刻のみになる */
  speaker: string | null;
  text: string;
}

/**
 * ISO 8601(ローカルのオフセット付き)。
 *
 * `toISOString()` は必ずUTCになるが、商談の記録は現地時刻で読みたい。
 * DATAFLOW.md の例も `2026-08-01T09:00:00+09:00` の形で書かれている。
 */
export function toLocalIso(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
  );
}

/** `HH:MM:SS`。transcript.md の見出しに使う */
export function toClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function renderMeeting(meeting: MeetingDoc): string {
  const lines = [
    "# Meeting",
    "",
    `- session_id: ${meeting.sessionId}`,
    `- started_at: ${toLocalIso(meeting.startedAt)}`,
    `- ended_at:${meeting.endedAt === null ? "" : ` ${toLocalIso(meeting.endedAt)}`}`,
    `- title:${meeting.title === null ? "" : ` ${inline(meeting.title)}`}`,
    "- participants:",
  ];

  for (const participant of meeting.participants) {
    lines.push(`  - ${inline(participant.side)}: ${participant.names.map(inline).join("、")}`);
  }

  lines.push(`- status: ${meeting.status}`, "");
  return lines.join("\n");
}

/**
 * transcript.md に追記する1件分。
 *
 * 本文の改行は潰して1段落にする。**追記専用ファイルの構造を壊さないため。**
 * 認識結果に `## ` で始まる行が混ざると、見出しとして解釈されて
 * 差分の切り出しが崩れる。1発話 = 1見出し + 1段落を常に保つ。
 */
export function renderTranscriptEntry(entry: TranscriptEntry): string {
  const heading =
    entry.speaker === null || entry.speaker === ""
      ? `## ${toClock(entry.at)}`
      : `## ${toClock(entry.at)} | ${inline(entry.speaker)}`;
  return `\n${heading}\n${inline(entry.text)}\n`;
}

/** 空のドキュメント。見出しだけを置き、以降の追記・置換の土台にする */
export function renderEmpty(heading: string): string {
  return `${heading}\n`;
}

/**
 * 1行に収める。改行・制御文字を空白に潰し、前後を削る。
 * 見出し行や箇条書きの構造を、本文が壊さないようにするための最小限の正規化。
 */
function inline(text: string): string {
  return text
    // 制御文字(改行・タブを含む)を空白へ潰してから、空白の連続をまとめる
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
