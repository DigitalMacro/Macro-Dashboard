"""
Simple in-memory cache with TTL.
"""

import time

_cache: dict = {}


def cached_fetch(key: str, ttl_seconds: int, fetch_fn):
    now = time.time()
    if key in _cache:
        val, ts = _cache[key]
        if now - ts < ttl_seconds:
            return val
    result = fetch_fn()
    _cache[key] = (result, now)
    return result


def invalidate(key: str):
    _cache.pop(key, None)


def clear():
    _cache.clear()
