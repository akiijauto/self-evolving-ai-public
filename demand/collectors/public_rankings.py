#!/usr/bin/env python3
"""robots.txt と利用規約を実確認した公開ランキングページからの収集(Tier 3)。

ここに入っているのは、APIも公式フィードも提供されていないため
HTMLを直接読むしかない収集元。Tier 3 は --allow-tier3 を明示しない限り
実行されず、さらに sources.json の status が approved であることも必要。
(demand/registry.py の二重ゲート)

Tier 1/2 の収集元と分けてあるのは、HTMLは相手の都合でいつでも変わるため。
構造が変わったときに「静かに0件」にならないよう、各収集元で1件も取れなければ
CollectError を送出して失敗として表に出す。

規約上の根拠(いずれも 2026-08-03 に実確認):
  coconala   - 利用規約に自動収集の禁止条項なし。第14条第1項により集計データの
               権利は同社に帰属するため、取得結果は非公開の分析に限定する。
  kinokuniya - 自動収集の禁止条項なし。著作権ページが無断転載を禁じているため
               取得結果の転載・公表は行わない。
  dlsite     - 第17条は不正アクセス・過度な負荷・BOTによる不正操作を禁じるのみ。
               robots.txt の Crawl-delay: 10 を守る低頻度取得に限定する。

依存ライブラリなし(標準ライブラリのみ)。
"""
import html
import re

from . import base
from .. import schema

# DLsite の robots.txt が明示している Crawl-delay。相手が数字で示している以上、
# こちらの都合で短くしない。
DLSITE_CRAWL_DELAY_SEC = 10

# 1収集元あたりの上限件数。ランキングは上位ほど意味があり、
# 全件取ると相手への負荷と保存量だけが増える。
MAX_ITEMS = 50


def _text(fragment):
    """HTML断片からタグと余分な空白を落として本文だけ返す。"""
    stripped = re.sub(r"<[^>]+>", " ", fragment or "")
    return re.sub(r"\s+", " ", html.unescape(stripped)).strip()


def _int(text):
    """'2,128' のような表記を int にする。数字が無ければ None。"""
    if not text:
        return None
    digits = re.sub(r"[^0-9]", "", text)
    return int(digits) if digits else None


def _require(records, source_name, hint):
    """1件も取れなかった場合は失敗させる。

    HTML構造の変更で静かに0件になると、「毎日動いているから正常」と
    誤認する。沈黙して減らさないという方針(引き継ぎ資料 §6)をここで守る。
    """
    if not records:
        raise base.CollectError(
            "%s から1件も抽出できませんでした。HTML構造が変わった可能性があります(%s)"
            % (source_name, hint)
        )
    return records


# --- ココナラ --------------------------------------------------------------
# 出品サービスのランキング順(デフォルト並び)。並び順をURLクエリで指定できないため
# 取得できるのはこの順序のみ。販売実績数は構造化データとして存在せず、
# キャッチコピー内の自己申告テキストにしか現れないため metrics には入れない。
COCONALA_URL = "https://coconala.com/categories/22"
COCONALA_CATEGORY = "Web制作・HP作成・EC構築"

# 出品1件のカセットは入れ子が深く、終端をタグの対応で取ろうとすると途中で
# 切れて価格を取りこぼす。次のカセットの開始位置までを1件分として切り出す。
_COCONALA_SPLIT = re.compile(r'<div class="c-serviceCassette[ "]')
_COCONALA_LINK = re.compile(r'href="(/services/\d+)"')
_COCONALA_TITLE = re.compile(r'<div class="c-serviceCassette_title"[^>]*>(.*?)</div>', re.S)
_COCONALA_PRICE = re.compile(r'([0-9,]+)\s*円')


@base.register("coconala")
def collect_coconala(source, captured_at):
    """ココナラの1カテゴリのランキング順を返す。

    規約の包括条項(第13条第2項)に配慮し、取得するのは1日1回・1カテゴリのみ。
    """
    body = base.fetch(source.get("check_url") or COCONALA_URL)

    records = []
    seen = set()
    for fragment in _COCONALA_SPLIT.split(body)[1:]:
        link = _COCONALA_LINK.search(fragment)
        title_match = _COCONALA_TITLE.search(fragment)
        if not link or not title_match:
            continue
        path = link.group(1)
        if path in seen:
            continue
        seen.add(path)

        title = _text(title_match.group(1))
        if not title:
            continue
        # 価格は「〇〇円」の表記でしか出てこない。取れない出品もあるため必須にしない。
        price_match = _COCONALA_PRICE.search(_text(fragment))
        price = _int(price_match.group(1)) if price_match else None

        records.append(schema.make_record(
            captured_at=captured_at,
            source="coconala",
            domain="service",
            country="JP",
            category=COCONALA_CATEGORY,
            rank=len(records) + 1,
            title=title,
            url="https://coconala.com" + path,
            price=price,
            currency="JPY" if price is not None else None,
            note="デフォルトのランキング順。並び順は指定できず、算出基準は非公開。",
        ))
        if len(records) >= MAX_ITEMS:
            break

    return _require(records, "coconala", "c-serviceCassette")


# --- 紀伊國屋書店 ----------------------------------------------------------
# 国内店舗＋ウェブストア＋アプリの売上合算(紙＋電子)。代理指標ではなく実売ベース。
KINOKUNIYA_URL = "https://www.kinokuniya.co.jp/disp/CKnRankingPageCTop.jsp"

# このページには「総合」「コミック」「洋書」など複数のランキングが縦に並ぶ。
# 見出しごとに区切らないと、全ての節の1位が同じカテゴリの1位として混ざる。
_KINOKUNIYA_SECTION = re.compile(
    r'<div class="rankingList title_area[^"]*">\s*<h2>\s*(.*?)</h2>', re.S)
_KINOKUNIYA_ITEM = re.compile(r'<li class="rank_(\d+)">(.*?)</li>', re.S)
_KINOKUNIYA_TITLE = re.compile(r'<p class="book_title"><a[^>]*>(.*?)</a>', re.S)
_KINOKUNIYA_LINK = re.compile(r'<p class="book_title"><a href="([^"]+)"')
_KINOKUNIYA_PERIOD = re.compile(r'<p id="period">\s*(.*?)</p>', re.S)


@base.register("kinokuniya")
def collect_kinokuniya(source, captured_at):
    """紀伊國屋書店の総合ベストセラー(デイリー)を返す。"""
    body = base.fetch(source.get("check_url") or KINOKUNIYA_URL)

    period = _KINOKUNIYA_PERIOD.search(body)
    note = "国内店舗＋ウェブストア＋アプリの売上合計(紙＋電子)"
    if period:
        note = "%s / %s" % (_text(period.group(1)), note)

    # 見出しの位置で本文を切り分け、節ごとにカテゴリを付ける。
    sections = []
    matches = list(_KINOKUNIYA_SECTION.finditer(body))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        sections.append((_text(match.group(1)), body[match.end():end]))
    if not sections:
        sections = [("書籍総合", body)]

    records = []
    for category, fragment_body in sections:
        for match in _KINOKUNIYA_ITEM.finditer(fragment_body):
            fragment = match.group(2)
            title_match = _KINOKUNIYA_TITLE.search(fragment)
            if not title_match:
                continue
            title = _text(title_match.group(1))
            if not title:
                continue
            link = _KINOKUNIYA_LINK.search(fragment)

            records.append(schema.make_record(
                captured_at=captured_at,
                source="kinokuniya",
                domain="ec",
                country="JP",
                category=category or "書籍総合",
                rank=int(match.group(1)),
                title=title,
                url=link.group(1) if link else None,
                note=note,
            ))

    return _require(records, "kinokuniya", 'li class="rank_N"')


# --- DLsite ----------------------------------------------------------------
# 全年齢向け(/home/)のみを対象にする。販売数が数値として公開されている
# 数少ない収集元で、ランキング順位と実数の両方が取れる。
DLSITE_URL = "https://www.dlsite.com/home/ranking/day"

_DLSITE_ROW = re.compile(r'<tr[^>]*>(.*?)</tr>', re.S)
_DLSITE_RANK = re.compile(r'<div class="rank_no[^"]*">\s*(\d+)\s*</div>')
_DLSITE_DL = re.compile(r'<div class="dl_count">.*?</span>\s*([0-9,]+)\s*</div>', re.S)
_DLSITE_TITLE = re.compile(r'<dt class="work_name">.*?<a href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_DLSITE_MAKER = re.compile(r'<dd class="maker_name">\s*<a[^>]*>(.*?)</a>', re.S)
_DLSITE_PRICE = re.compile(r'<span class="work_price[^"]*">\s*([0-9,]+)')


@base.register("dlsite")
def collect_dlsite(source, captured_at):
    """DLsite(全年齢)のデイリーランキングを販売数付きで返す。"""
    # 全年齢向けの /home/ を固定で使う。sources.json の check_url は robots.txt
    # 判定用に成人向け(/maniax/)を指しているが、そちらは年齢確認の中間ページが
    # 返って一覧が入っておらず、収集対象としても適さない。
    # robots.txt が Crawl-delay: 10 を明示しているため、それ以上の間隔を空ける。
    body = base.fetch(source.get("endpoint") or DLSITE_URL,
                      interval=DLSITE_CRAWL_DELAY_SEC)

    records = []
    for row in _DLSITE_ROW.finditer(body):
        fragment = row.group(1)
        rank_match = _DLSITE_RANK.search(fragment)
        title_match = _DLSITE_TITLE.search(fragment)
        if not rank_match or not title_match:
            continue
        title = _text(title_match.group(2))
        if not title:
            continue

        dl_match = _DLSITE_DL.search(fragment)
        maker_match = _DLSITE_MAKER.search(fragment)
        price_match = _DLSITE_PRICE.search(fragment)
        metrics = {}
        if dl_match:
            sales = _int(dl_match.group(1))
            if sales is not None:
                metrics["sales_count"] = sales

        # DLsite は同順位を許す(93位が3件など実在する)。rank をそのまま使うと
        # 同一カテゴリ内で順位が重複し、日々の順位変動を追えなくなるため、
        # rank には出現順を入れ、サイトが表示している順位は metrics に残す。
        displayed = int(rank_match.group(1))
        position = len(records) + 1
        if displayed != position:
            metrics["displayed_rank"] = displayed

        parts = ["販売数は提供元が公開している実数"]
        if maker_match:
            parts.insert(0, "サークル: %s" % _text(maker_match.group(1)))
        if displayed != position:
            parts.append("サイト表示順位 %d(同順位あり)" % displayed)

        records.append(schema.make_record(
            captured_at=captured_at,
            source="dlsite",
            domain="ec",
            country="JP",
            category="全年齢デイリー",
            rank=position,
            title=title,
            url=title_match.group(1),
            price=_int(price_match.group(1)) if price_match else None,
            currency="JPY" if price_match else None,
            metrics=metrics or None,
            note=" / ".join(parts),
        ))
        if len(records) >= MAX_ITEMS:
            break

    return _require(records, "dlsite", 'tr > div class="rank_no"')
