"""Кэш результатов расчёта по содержимому сценария.

Расчёт полностью детерминирован: одинаковый сценарий и одинаковые настройки
дают одинаковый результат. Поэтому ключом служит хеш содержимого — повторный
запрос того же варианта (частый случай при сравнении и при перезагрузке
страницы) обслуживается мгновенно.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Callable, Generic, TypeVar

T = TypeVar("T")


class LruCache(Generic[T]):
    """Потокобезопасный LRU-кэш фиксированного размера."""

    def __init__(self, capacity: int) -> None:
        self._capacity = max(1, capacity)
        self._items: OrderedDict[str, T] = OrderedDict()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> T | None:
        with self._lock:
            if key not in self._items:
                self.misses += 1
                return None
            self._items.move_to_end(key)
            self.hits += 1
            return self._items[key]

    def put(self, key: str, value: T) -> None:
        with self._lock:
            self._items[key] = value
            self._items.move_to_end(key)
            while len(self._items) > self._capacity:
                self._items.popitem(last=False)

    def get_or_create(self, key: str, factory: Callable[[], T]) -> T:
        cached = self.get(key)
        if cached is not None:
            return cached
        value = factory()
        self.put(key, value)
        return value

    def keys(self) -> list[str]:
        with self._lock:
            return list(self._items.keys())

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "size": len(self._items),
                "capacity": self._capacity,
                "hits": self.hits,
                "misses": self.misses,
            }
