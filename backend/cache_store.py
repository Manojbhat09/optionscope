# backend/cache_store.py
"""Key/value cache storage. This layer only knows about bytes-in/bytes-out —
no TTL policy, no coverage rules, no domain knowledge. That lives in
range_cache.py and in each call site. Keeping storage and policy separate
means the storage backend (file today, Redis later if this ever runs as
more than one process) can change without touching any caching logic."""

import json
import os
import tempfile
import time


class CacheStore:
    def get(self, key):
        raise NotImplementedError

    def set(self, key, value):
        raise NotImplementedError

    def delete(self, key):
        raise NotImplementedError

    def age_seconds(self, key):
        """Seconds since this key was last written, or None if absent."""
        raise NotImplementedError


def _safe_filename(key):
    return key.replace('/', '_').replace(':', '__').replace('\\', '_') + '.json'


class FileCacheStore(CacheStore):
    """JSON-per-key file store with crash-safe atomic writes: write to a temp
    file in the same directory, then os.replace() — atomic on POSIX, so a
    concurrent reader (Flask's dev server is threaded) or a crash mid-write
    never observes a partially-written cache file."""

    def __init__(self, root_dir):
        self.root_dir = root_dir
        os.makedirs(root_dir, exist_ok=True)

    def _path(self, key):
        return os.path.join(self.root_dir, _safe_filename(key))

    def get(self, key):
        path = self._path(key)
        if not os.path.exists(path):
            return None
        try:
            with open(path) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return None  # corrupt/partial file — treat as a cache miss, not a crash

    def set(self, key, value):
        path = self._path(key)
        fd, tmp_path = tempfile.mkstemp(dir=self.root_dir, prefix='.tmp_')
        try:
            with os.fdopen(fd, 'w') as f:
                json.dump(value, f)
            os.replace(tmp_path, path)
        except Exception:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise

    def delete(self, key):
        path = self._path(key)
        if os.path.exists(path):
            os.remove(path)

    def age_seconds(self, key):
        path = self._path(key)
        if not os.path.exists(path):
            return None
        return time.time() - os.path.getmtime(path)
