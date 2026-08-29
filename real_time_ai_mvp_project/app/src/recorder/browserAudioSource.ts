import type { AudioSource, MediaRecorderLike } from "./types";

/**
 * ブラウザの getUserMedia / MediaRecorder を AudioSource として包む。
 * ここがブラウザAPIに触れる唯一の場所。
 */

/**
 * 優先度順の候補。Opus を最優先する(REQUIREMENTS.md の通信要件:
 * 圧縮音声でモバイル回線に収める)。
 */
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

export function pickMimeType(
  isSupported: (type: string) => boolean = (type) => MediaRecorder.isTypeSupported(type),
): string | undefined {
  return PREFERRED_MIME_TYPES.find(isSupported);
}

export class UnsupportedBrowserError extends Error {
  constructor() {
    super("このブラウザは録音に対応していません。Chrome / Safari の最新版をお試しください。");
    this.name = "UnsupportedBrowserError";
  }
}

export class MicPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicPermissionError";
  }
}

/** DOMException の name から日本語のメッセージを組み立てる */
export function describeMicError(error: unknown): { denied: boolean; message: string } {
  const name = error instanceof DOMException ? error.name : "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        denied: true,
        message:
          "マイクの使用が許可されませんでした。ブラウザの設定でこのサイトのマイクを許可してください。",
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
      return { denied: false, message: "マイクが見つかりません。デバイスの接続を確認してください。" };
    case "NotReadableError":
    case "TrackStartError":
      return {
        denied: false,
        message: "マイクを他のアプリが使用中です。そのアプリを閉じてからもう一度お試しください。",
      };
    default:
      return {
        denied: false,
        message: error instanceof Error ? error.message : "マイクの初期化に失敗しました。",
      };
  }
}

export const browserAudioSource: AudioSource = {
  async open() {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new UnsupportedBrowserError();
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      const { denied, message } = describeMicError(error);
      throw denied ? new MicPermissionError(message) : new Error(message);
    }

    const mimeType = pickMimeType();
    const create = (): MediaRecorderLike =>
      new MediaRecorder(stream, mimeType ? { mimeType } : undefined) as unknown as MediaRecorderLike;

    return {
      recorder: create(),
      // 同じマイクで作り直す。マイク権限の再要求は発生しない
      renew: create,
      close: () => {
        for (const track of stream.getTracks()) track.stop();
      },
    };
  },
};
