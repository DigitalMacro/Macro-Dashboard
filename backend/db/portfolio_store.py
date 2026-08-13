"""
Portfolio persistence — backend/db/portfolio_store.py
SQLite store for the mock L/S book. Single-user, module-level connection.
"""

import os
import sqlite3
import threading
from typing import Optional

DB_PATH = os.path.join(os.path.dirname(__file__), "portfolio.db")

_conn: Optional[sqlite3.Connection] = None
_lock = threading.Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('long', 'short')),
    weight REAL NOT NULL,
    entry_date TEXT NOT NULL,
    entry_price REAL,
    exit_date TEXT,
    exit_price REAL,
    thesis TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
"""


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute(_SCHEMA)
        _conn.commit()
    return _conn


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["status"] = "closed" if d["exit_date"] else "open"
    return d


def add_position(
    ticker: str,
    side: str,
    weight: float,
    entry_date: str,
    entry_price: float,
    thesis: Optional[str] = None,
) -> dict:
    with _lock:
        conn = _get_conn()
        cur = conn.execute(
            "INSERT INTO positions (ticker, side, weight, entry_date, entry_price, thesis) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (ticker.upper(), side, weight, entry_date, entry_price, thesis),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM positions WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _row_to_dict(row)


def close_position(position_id: int, exit_date: str, exit_price: float) -> Optional[dict]:
    with _lock:
        conn = _get_conn()
        cur = conn.execute(
            "UPDATE positions SET exit_date = ?, exit_price = ? "
            "WHERE id = ? AND exit_date IS NULL",
            (exit_date, exit_price, position_id),
        )
        conn.commit()
        if cur.rowcount == 0:
            return None
        row = conn.execute("SELECT * FROM positions WHERE id = ?", (position_id,)).fetchone()
    return _row_to_dict(row)


def delete_position(position_id: int) -> bool:
    with _lock:
        conn = _get_conn()
        cur = conn.execute("DELETE FROM positions WHERE id = ?", (position_id,))
        conn.commit()
    return cur.rowcount > 0


def get_position(position_id: int) -> Optional[dict]:
    row = _get_conn().execute(
        "SELECT * FROM positions WHERE id = ?", (position_id,)
    ).fetchone()
    return _row_to_dict(row) if row else None


def get_open_positions() -> list:
    rows = _get_conn().execute(
        "SELECT * FROM positions WHERE exit_date IS NULL ORDER BY id"
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_closed_positions() -> list:
    rows = _get_conn().execute(
        "SELECT * FROM positions WHERE exit_date IS NOT NULL ORDER BY id"
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_all_positions() -> list:
    rows = _get_conn().execute("SELECT * FROM positions ORDER BY id").fetchall()
    return [_row_to_dict(r) for r in rows]
