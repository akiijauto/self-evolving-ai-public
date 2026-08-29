"""収集元ごとの収集モジュール。

新しい収集元を追加する手順:
  1. demand/sources.json に規約確認の証跡付きでエントリを追加する
  2. このディレクトリに <収集元名>.py を作り、@base.register("<収集元名>") を
     付けた collect(source, captured_at) を定義する
  3. 下の import に1行足す

collect() は需要レコード(schema.make_record の戻り値)のリストを返す。
出典情報(tier / collect_method / terms_url)は呼び出し側が付与するため、
収集モジュール側で書く必要はない。
"""
from . import base  # noqa: F401
from . import apple_rss  # noqa: F401
from . import google_trends_rss  # noqa: F401
from . import steam  # noqa: F401
from . import wikimedia_pageviews  # noqa: F401
from . import job_boards  # noqa: F401
from . import package_downloads  # noqa: F401
from . import estat_dashboard  # noqa: F401
from . import indeed_hiring_lab  # noqa: F401
from . import public_rankings  # noqa: F401
