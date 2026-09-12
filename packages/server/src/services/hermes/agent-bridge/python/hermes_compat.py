"""Compatibility shims for Hermes Agent internal import paths.

Hermes Agent is not a stable Python API: its September 2026 decomposition
moved several internal modules (see ``COMPAT_MANIFEST.md`` in the
hermes-agent repository). The temporary re-export shims in the old modules
emit ``HermesPluginCompatWarning`` and are scheduled for removal, and private
names were never covered at all.

The bridge resolves every affected symbol from its current location first and
falls back to the pre-decomposition location so older Hermes installs keep
working. Add new moved symbols here instead of scattering try/except imports.
"""
from __future__ import annotations

import importlib
from typing import Any

# Symbols resolved through the old-location fallback. Surfaced in the worker
# startup log (``bridge.worker.initialized``) so a future upstream
# decomposition shows up in logs instead of failing silently.
_FALLBACKS_USED: list[dict[str, str]] = []


def fallbacks_used() -> list[dict[str, str]]:
    return [dict(entry) for entry in _FALLBACKS_USED]


def import_attr(new_module: str, name: str, old_module: str) -> Any:
    """Resolve ``name`` trying ``new_module`` first, then ``old_module``.

    Raises ``ImportError`` when the symbol exists in neither module so call
    sites can keep a single ``except ImportError`` guard.
    """
    try:
        return getattr(importlib.import_module(new_module), name)
    except (ImportError, AttributeError):
        pass
    try:
        module = importlib.import_module(old_module)
        value = getattr(module, name)
    except AttributeError as exc:
        raise ImportError(
            f"cannot import name {name!r} from {new_module!r} or {old_module!r}"
        ) from exc
    _FALLBACKS_USED.append({
        "name": name,
        "resolved_from": old_module,
        "expected_new_module": new_module,
    })
    return value
