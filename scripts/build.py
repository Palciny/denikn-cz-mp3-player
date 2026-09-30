from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin

import feedparser
import requests
from bs4 import BeautifulSoup

RSS_DIRECTORY_URL = "https://denikn.cz/rss-odber/"
OUTPUT_PATH = Path(__file__).resolve().parents[1] / "docs" / "data" / "articles.json"
LATEST_OUTPUT_PATH = Path(__file__).resolve().parents[1] / "docs" / "data" / "latest.json"
SITE_ROOT = "https://denikn.cz/"
ACCEPT_LANGUAGE = "cs-CZ,cs;q=0.9,sk;q=0.8,en-US;q=0.7,en;q=0.6"
# Used only if curl_cffi is unavailable. The old self-identifying bot UA is an
# easy thing for the edge to filter on.
FALLBACK_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
# Browser TLS/HTTP2 fingerprints to impersonate, tried in order when the edge
# answers 403. A plain `requests` session looks like Python at the TLS layer.
IMPERSONATE_PROFILES = [
    p.strip()
    for p in os.environ.get("IMPERSONATE_PROFILES", "chrome,firefox,edge,safari").split(",")
    if p.strip()
]
# Stop fetching article pages after this many 403s in a row - past that point
# it is an IP-level block and more requests only deepen it.
MAX_CONSECUTIVE_BLOCKS = int(os.environ.get("MAX_CONSECUTIVE_BLOCKS", "3"))
MAX_FEED_ITEMS_PER_FEED = 150
REQUEST_TIMEOUT = 30

MP3_RE = re.compile(r"https?://[^\s\"'<>]+\.mp3(?:\?[^\s\"'<>]*)?", re.IGNORECASE)
DENNIKN_ARTICLE_RE = re.compile(r"^https://denikn\.cz/\d+/", re.IGNORECASE)

KNOWN_FEEDS = [
    "https://denikn.cz/feed",
    "https://denikn.cz/cesko/feed/",
    "https://denikn.cz/svet/feed",
    "https://denikn.cz/ekonomika/feed",
    "https://denikn.cz/nazory/feed",
    "https://denikn.cz/kultura/feed",
    "https://denikn.cz/veda/feed",
    "https://denikn.cz/sport/feed",
    "https://denikn.cz/audio/feed",
]



@dataclass
class ArticleRecord:
    title: str
    url: str
    mp3_url: str
    published: str | None
    published_day: str | None
    categories: list[str]
    feed_url: str | None
    first_seen: str
    last_seen: str


class BlockedError(Exception):
    """The edge refused the request (HTTP 403)."""


def make_session(profile: str | None):
    if profile:
        try:
            from curl_cffi import requests as curl_requests

            created = curl_requests.Session(
                impersonate=profile, default_headers=True, allow_redirects=True
            )
            created.headers.update({"Accept-Language": ACCEPT_LANGUAGE})
            return created
        except Exception as exc:
            print(f"Cannot impersonate {profile}: {exc}")
            return None
    created = requests.Session()
    created.headers.update(
        {"User-Agent": FALLBACK_USER_AGENT, "Accept-Language": ACCEPT_LANGUAGE}
    )
    return created


session = None
profile_index = -1


def next_session() -> bool:
    """Move to the next usable fingerprint. False once the list is exhausted."""
    global session, profile_index
    while profile_index + 1 < len(IMPERSONATE_PROFILES):
        profile_index += 1
        candidate = make_session(IMPERSONATE_PROFILES[profile_index])
        if candidate is not None:
            session = candidate
            print(f"HTTP transport: curl_cffi (impersonate={IMPERSONATE_PROFILES[profile_index]})")
            return True
    return False


if not next_session():
    session = make_session(None)
    print("HTTP transport: requests (no fingerprint impersonation available)")


def fetch_text(url: str, referer: str | None = None) -> str:
    headers = {"Referer": referer} if referer else None
    while True:
        response = session.get(url, timeout=REQUEST_TIMEOUT, headers=headers)
        if response.status_code == 403:
            # 403 is a verdict on this fingerprint; try another browser once.
            if next_session():
                print(f"::warning::{url} refused (HTTP 403) - retrying with another profile")
                continue
            raise BlockedError("HTTP 403")
        response.raise_for_status()
        return response.text


def parse_published(value: str | None) -> str | None:
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return None


def iso_day(value: str | None) -> str | None:
    if not value:
        return None
    return value[:10]


def dedupe_keep_order(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        value = (value or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def discover_feed_urls() -> list[str]:
    discovered: list[str] = []
    try:
        html = fetch_text(RSS_DIRECTORY_URL)
        soup = BeautifulSoup(html, "html.parser")
        for link in soup.select("a[href]"):
            href = (link.get("href") or "").strip()
            text = " ".join(link.stripped_strings)
            if "/feed" not in href:
                continue
            if "Minúty" in text or "Minúta" in text:
                continue
            discovered.append(urljoin(RSS_DIRECTORY_URL, href))
    except Exception as exc:
        print(f"Could not discover feeds from {RSS_DIRECTORY_URL}: {exc}")

    return dedupe_keep_order([*discovered, *KNOWN_FEEDS])


def extract_main_mp3(html: str, page_url: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")

    for source in soup.select("audio source[src]"):
        src = source.get("src", "").strip()
        if src and src.lower().endswith(".mp3") and "predplatne.mp3" not in src.lower():
            return urljoin(page_url, src)

    for audio in soup.select("audio[src]"):
        src = audio.get("src", "").strip()
        if src and src.lower().endswith(".mp3") and "predplatne.mp3" not in src.lower():
            return urljoin(page_url, src)

    for match in MP3_RE.findall(html):
        if "predplatne.mp3" in match.lower():
            continue
        return match

    return None


def feed_entry_mp3(entry: feedparser.FeedParserDict) -> str | None:
    """
    An MP3 linked straight from the RSS item (enclosure, media or body HTML).
    The feeds are not blocked, so this needs no article page request.
    """
    for link in entry.get("links", []) or []:
        href = (link.get("href") or "").strip()
        mime = link.get("type") or ""
        if (link.get("rel") == "enclosure" and href
                and ("audio" in mime or ".mp3" in href.lower())
                and "predplatne.mp3" not in href.lower()):
            return href

    for media in entry.get("media_content", []) or []:
        href = (media.get("url") or "").strip()
        if href and ".mp3" in href.lower() and "predplatne.mp3" not in href.lower():
            return href

    chunks = [c.get("value") or "" for c in entry.get("content", []) or []]
    chunks.append(entry.get("summary") or "")
    for chunk in chunks:
        if ".mp3" in chunk.lower():
            found = extract_main_mp3(chunk, entry.get("link") or SITE_ROOT)
            if found:
                return found
    return None


def extract_categories(entry: feedparser.FeedParserDict, html: str | None) -> list[str]:
    categories: list[str] = []

    for tag in entry.get("tags", []) or []:
        term = (getattr(tag, "term", None) or tag.get("term") or "").strip()
        if term:
            categories.append(term)

    if categories or not html:
        return dedupe_keep_order(categories)

    soup = BeautifulSoup(html, "html.parser")

    for meta in soup.select('meta[property="article:tag"], meta[name="news_keywords"], meta[property="article:section"]'):
        content = (meta.get("content") or "").strip()
        if not content:
            continue
        for part in [x.strip() for x in content.split(",")]:
            if part:
                categories.append(part)

    return dedupe_keep_order(categories)


def iter_feed_entries() -> Iterable[tuple[str, feedparser.FeedParserDict]]:
    for feed_url in discover_feed_urls():
        try:
            parsed = feedparser.parse(fetch_text(feed_url))
        except Exception as exc:
            print(f"Skipping feed {feed_url}: {exc}")
            continue

        for entry in parsed.entries[:MAX_FEED_ITEMS_PER_FEED]:
            link = (entry.get("link") or "").strip()
            if not link or not DENNIKN_ARTICLE_RE.search(link):
                continue
            yield feed_url, entry


def load_existing_records(now_iso: str) -> dict[str, ArticleRecord]:
    if not OUTPUT_PATH.exists():
        return {}

    try:
        payload = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"Could not read existing archive: {exc}")
        return {}

    existing: dict[str, ArticleRecord] = {}
    for item in payload.get("articles", []) or []:
        url = (item.get("url") or "").strip()
        mp3_url = (item.get("mp3_url") or "").strip()
        if not url or not mp3_url:
            continue
        existing[url] = ArticleRecord(
            title=(item.get("title") or url).strip(),
            url=url,
            mp3_url=mp3_url,
            published=item.get("published"),
            published_day=item.get("published_day") or iso_day(item.get("published")),
            categories=dedupe_keep_order(item.get("categories") or []),
            feed_url=item.get("feed_url"),
            first_seen=item.get("first_seen") or now_iso,
            last_seen=item.get("last_seen") or now_iso,
        )
    return existing


def build_records() -> tuple[list[ArticleRecord], list[str]]:
    now_iso = datetime.now(timezone.utc).isoformat()
    existing = load_existing_records(now_iso)
    records_by_url = dict(existing)
    seen_mp3s = {record.mp3_url for record in records_by_url.values()}

    feed_urls_seen: list[str] = []
    consecutive_blocks = 0
    page_fetch_disabled = False
    stats = {"known": 0, "by_feed": 0, "by_page": 0, "blocked": 0, "skipped": 0}

    for feed_url, entry in iter_feed_entries():
        feed_urls_seen.append(feed_url)
        url = (entry.get("link") or "").strip()
        title = (entry.get("title") or url).strip()

        previous = records_by_url.get(url)
        if previous is not None:
            # Already indexed - refreshing it would cost a page fetch for nothing.
            previous.last_seen = now_iso
            stats["known"] += 1
            continue

        html = None
        mp3_url = feed_entry_mp3(entry)
        if mp3_url:
            stats["by_feed"] += 1
        elif page_fetch_disabled:
            stats["skipped"] += 1
            continue
        else:
            try:
                html = fetch_text(url, referer=SITE_ROOT)
                consecutive_blocks = 0
                mp3_url = extract_main_mp3(html, url)
                if mp3_url:
                    stats["by_page"] += 1
            except BlockedError as exc:
                stats["blocked"] += 1
                consecutive_blocks += 1
                print(f"  blocked fetching {url}: {exc}")
                if consecutive_blocks >= MAX_CONSECUTIVE_BLOCKS:
                    page_fetch_disabled = True
                    print(f"::warning::{consecutive_blocks} article fetches blocked in a row - "
                          "skipping article pages for the rest of this run")
                continue
            except Exception as exc:
                print(f"Skipping {url}: {exc}")
                continue

        if not mp3_url:
            continue

        if mp3_url in seen_mp3s:
            continue

        published = parse_published(entry.get("published") or entry.get("updated"))
        categories = extract_categories(entry, html)

        record = ArticleRecord(
            title=title,
            url=url,
            mp3_url=mp3_url,
            published=published or (previous.published if previous else None),
            published_day=iso_day(published) or (previous.published_day if previous else None),
            categories=dedupe_keep_order([*(previous.categories if previous else []), *categories]),
            feed_url=feed_url,
            first_seen=previous.first_seen if previous else now_iso,
            last_seen=now_iso,
        )
        records_by_url[url] = record
        seen_mp3s.add(mp3_url)

    print("Run summary: " + ", ".join(f"{k}={v}" for k, v in stats.items()))

    records = list(records_by_url.values())
    records.sort(
        key=lambda item: (
            item.published or "",
            item.first_seen,
            item.title.lower(),
        ),
        reverse=True,
    )
    return records, dedupe_keep_order(feed_urls_seen)


def build_payload(
    *,
    records: list[ArticleRecord],
    payload_records: list[ArticleRecord],
    feed_urls: list[str],
    generated_at: str,
    latest_day: str | None,
) -> dict:
    categories = sorted({category for record in records for category in record.categories}, key=str.casefold)
    published_days = sorted({record.published_day for record in records if record.published_day}, reverse=True)
    return {
        "generated_at": generated_at,
        "sources": feed_urls,
        "count": len(payload_records),
        "total_count": len(records),
        "latest_day": latest_day,
        "categories": categories,
        "published_days": published_days,
        "articles": [asdict(record) for record in payload_records],
    }


def write_output(records: list[ArticleRecord], feed_urls: list[str]) -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    published_days = sorted({record.published_day for record in records if record.published_day}, reverse=True)
    latest_day = published_days[0] if published_days else None
    latest_records = [
        record
        for record in records
        if latest_day is None or record.published_day == latest_day
    ]
    generated_at = datetime.now(timezone.utc).isoformat()
    payload = build_payload(
        records=records,
        payload_records=records,
        feed_urls=feed_urls,
        generated_at=generated_at,
        latest_day=latest_day,
    )
    latest_payload = build_payload(
        records=records,
        payload_records=latest_records,
        feed_urls=feed_urls,
        generated_at=generated_at,
        latest_day=latest_day,
    )

    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    LATEST_OUTPUT_PATH.write_text(json.dumps(latest_payload, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    items, feed_urls = build_records()
    write_output(items, feed_urls)
    print(f"Wrote {len(items)} records from {len(feed_urls)} feed(s) to {OUTPUT_PATH} and {LATEST_OUTPUT_PATH}")
