"""PolyForge service processes.

Responsibility: the long-running processes that expose the Graph Core over a wire. The
Core itself (``polyforge.core``) knows nothing about HTTP; everything transport-shaped lives
under ``polyforge.services``.

Invariants:

* A service process adds a transport and a trust boundary. It never adds a second way to
  mutate engineering state: every write still goes through exactly one
  :class:`polyforge.core.runtime.engine.RuntimeEngine` method, in one Core transaction.
* A service never invents an answer. Where the platform is not reachable the service reports
  a blocked or read-only condition rather than degrading an authorization check into a plain
  confirmation (``docs/05-PROTOCOL.md`` sections 9 and 12).
* No service module imports a Paperclip SDK. The boundary is the signed, scope-bound
  request/response contract in ``docs/05-PROTOCOL.md``.
"""

from __future__ import annotations

__all__: list[str] = []
