"""The PolyForge Runtime Service HTTP layer.

Responsibility: expose the Graph Core as the signed, scope-bound ``/v1`` surface described in
``docs/05-PROTOCOL.md``, and nothing else.

The package is a transport, not a second brain:

* :mod:`config` reads the operator's environment and refuses one that would make the trust
  boundary meaningless.
* :mod:`auth` verifies the six signature headers and produces the only identity the process
  ever sees.
* :mod:`router` holds the one route table the router dispatches on and the OpenAPI document is
  generated from.
* :mod:`app` runs the request pipeline and the endpoint handlers, and owns the two background
  loops.
* :mod:`errors` maps a refusal onto exactly one response shape.
* :mod:`openapi` emits the document; :mod:`server` and :mod:`__main__` start the process.

Nothing here mutates engineering state: every write goes through one
:class:`polyforge.core.runtime.engine.RuntimeEngine` method, in one Core transaction, under
the Core's own idempotency and fencing rules.
"""

from __future__ import annotations

from polyforge.services.runtime_api.app import RuntimeService, build_service
from polyforge.services.runtime_api.auth import (
    ActorAssertion,
    AuthContext,
    NonceCache,
    RequestAuthenticator,
    canonical_request_bytes,
    sign_headers,
)
from polyforge.services.runtime_api.config import ConfigurationError, ServiceConfig
from polyforge.services.runtime_api.router import ENDPOINTS, Endpoint, Request, Response, ROUTER
from polyforge.services.runtime_api.server import create_server, serve

__all__ = [
    "ENDPOINTS",
    "ActorAssertion",
    "AuthContext",
    "ConfigurationError",
    "Endpoint",
    "NonceCache",
    "Request",
    "RequestAuthenticator",
    "Response",
    "ROUTER",
    "RuntimeService",
    "ServiceConfig",
    "build_service",
    "canonical_request_bytes",
    "create_server",
    "serve",
    "sign_headers",
]
