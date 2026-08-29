/// <reference types="vite/client" />

/**
 * ビルド時刻(ISO 8601)。vite.config.ts の define で埋め込まれる。
 * 実機がどの版を動かしているかを画面で確かめるためにある。
 */
declare const __BUILD_STAMP__: string;
