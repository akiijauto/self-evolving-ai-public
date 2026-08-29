#!/usr/bin/env python3
"""需要データの保存層。日付ごとの JSONL に追記する。

保存形式を JSONL にしているのは、このリポジトリ既存の events.jsonl /
critic_findings.jsonl と揃えるため。プレーンテキストなので git で差分が
追え、外部DBに依存しない(要件定義の「ツール非依存」方針を踏襲)。

依存ライブラリなし(標準ライブラリのみ)。
"""
import json
import pathlib

from . import schema

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "context" / "demand"


def data_file(captured_at, data_dir=None):
    """指定日の保存先パスを返す(例: context/demand/2026-08-02.jsonl)。"""
    base = pathlib.Path(data_dir) if data_dir else DATA_DIR
    return base / ("%s.jsonl" % captured_at)


def append(records, captured_at, data_dir=None):
    """需要レコードを検証したうえで当日ファイルに追記し、件数を返す。

    1件でもスキーマ違反があれば、何も書かずに SchemaError を送出する。
    途中まで書いて壊れたファイルを残さないため。
    """
    validated = [schema.validate(dict(r)) for r in records]
    for record in validated:
        if record["captured_at"] != captured_at:
            raise schema.SchemaError(
                "captured_at が保存先の日付と一致しません: %r != %r"
                % (record["captured_at"], captured_at)
            )

    path = data_file(captured_at, data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for record in validated:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    return len(validated)


def replace_source(records, captured_at, source_name, data_dir=None):
    """指定日・指定収集元のレコードを丸ごと置き換える。

    同じ日に同じ収集元を2回収集すると、単純な追記では順位が重複した
    データが残ってしまう(GitHub Actions の手動再実行と定時実行が同じ日に
    重なるだけで起きる)。収集を何度実行しても結果が同じになるよう、
    その収集元の既存レコードを取り除いてから書き直す。

    書き込みは一時ファイルへ書いてから置き換える。途中で失敗しても
    既存のデータを壊さないため。
    """
    validated = [schema.validate(dict(r)) for r in records]
    for record in validated:
        if record["captured_at"] != captured_at:
            raise schema.SchemaError(
                "captured_at が保存先の日付と一致しません: %r != %r"
                % (record["captured_at"], captured_at)
            )
        if record["source"] != source_name:
            raise schema.SchemaError(
                "source が置き換え対象と一致しません: %r != %r"
                % (record["source"], source_name)
            )

    kept = [r for r in load(captured_at, data_dir) if r.get("source") != source_name]

    path = data_file(captured_at, data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for record in kept + validated:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    tmp.replace(path)
    return len(validated)


def load(captured_at, data_dir=None):
    """指定日の需要レコードをすべて読み込む。ファイルが無ければ空リスト。"""
    path = data_file(captured_at, data_dir)
    if not path.exists():
        return []
    records = []
    with path.open(encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError("%s の %d行目が不正なJSONです: %s" % (path, line_no, exc))
    return records


def available_dates(data_dir=None):
    """保存済みの日付を昇順で返す。前日比の算出などに使う。"""
    base = pathlib.Path(data_dir) if data_dir else DATA_DIR
    if not base.exists():
        return []
    return sorted(p.stem for p in base.glob("*.jsonl"))


def previous_date(captured_at, data_dir=None):
    """指定日より前で、データが存在する直近の日付を返す。無ければ None。

    「前日」ではなく「直近の収集日」を返すのは、収集が失敗した日が
    あっても順位変動の比較対象を見失わないようにするため。
    """
    earlier = [d for d in available_dates(data_dir) if d < captured_at]
    return earlier[-1] if earlier else None
