"""HTTP-layer tests for the PolyForge Runtime Service.

Responsibility: hold the transport to the same contract the Core holds itself. Every module
names the acceptance-test ids from ``docs/03-MIGRATION-ROLLOUT-ACCEPTANCE.md`` section 10 that
it covers, so a gap in the matrix is a missing module rather than a missing assertion.

Coverage map:

* ``test_auth``      - AT-13 (no forged actor or approval), AT-29 (cross-company refused)
* ``test_scope``     - AT-03, AT-29
* ``test_idempotency`` - AT-26 (duplicate and out-of-order), AT-17 (concurrent draft update)
* ``test_surface``   - every documented endpoint's status, error mapping, event cursor
* ``test_health``    - honest health transitions, AT-27 (reconciler idempotence)
* ``test_outbox``    - AT-27 crash safety of the intent queue
* ``test_openapi``   - the document cannot drift from the router
* ``test_e2e_flow``  - AT-04, AT-07, AT-26 end to end over a real socket
"""

from __future__ import annotations

import logging

# The service logs a security event for every refusal, which is the behaviour under test. Without
# a handler on the package logger those records reach ``logging.lastResort`` and print to stderr,
# burying a real failure in dozens of expected warnings.
logging.getLogger("polyforge").addHandler(logging.NullHandler())

__all__: list[str] = []
