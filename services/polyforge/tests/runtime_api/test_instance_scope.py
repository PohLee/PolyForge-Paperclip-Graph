"""Instance-scoped routes need a signature but not a tenant.

``/v1/health``, ``/v1/health/ready`` and ``/v1/recover`` answer questions about the deployment
rather than about a company. Requiring a probe to name a tenant it knows nothing about would be
both unusable and misleading, so those routes accept an empty scope — while still requiring the
full signature, and still signing whatever scope *is* sent.

The property that actually matters is the one in ``TestInstanceScope``: an instance-scoped route
must not become a way to reach tenant data, and a tenant-scoped route must not become reachable
without a tenant.
"""

from __future__ import annotations

import unittest
from typing import Any

from .fixtures import COMPANY_A, PROJECT_A, SCOPE_A, RuntimeApiCase, agent_actor, system_actor


class InstanceScopedRouteTests(RuntimeApiCase):
    def _strip_scope(self, headers: dict[str, str]) -> dict[str, str]:
        return {k: v for k, v in headers.items() if k.lower() != "x-pf-scope"}

    def test_health_accepts_a_signed_caller_with_no_tenant(self) -> None:
        status, body, _ = self.client.call("GET", "/v1/health", scope={})
        self.assertEqual(status, 200, body)
        self.assertIn(body["status"], ("ready", "read_only", "degraded", "blocked"))

    def test_health_ready_accepts_a_signed_caller_with_no_tenant(self) -> None:
        status, body, _ = self.client.call("GET", "/v1/health/ready", scope={})
        self.assertIn(status, (200, 503), body)
        self.assertIn(body["status"], ("ready", "read_only", "degraded", "blocked"))

    def test_health_still_refuses_an_unsigned_caller(self) -> None:
        status, body, _ = self.client.call("GET", "/v1/health", sign=False)
        self.assertEqual(status, 403, body)
        self.assertEqual(self.client.error_code(status, body), "AUTHORIZATION_DENIED")

    def test_health_refuses_a_signature_over_a_substituted_tenant(self) -> None:
        """An empty scope is only acceptable because it is signed as an empty scope.

        Stripping the header after signing must not produce a request that verifies against a
        scope the caller never signed.
        """
        payload = b""
        headers = self.client.headers("GET", "/v1/health", payload, scope=SCOPE_A)
        stripped = self._strip_scope(headers)
        status, body, _ = self.client.call("GET", "/v1/health", headers=stripped, sign=False)
        self.assertEqual(status, 403, body)

    def test_health_refuses_a_malformed_scope_that_was_sent(self) -> None:
        """Sending a broken scope is an error, not a request to be treated as instance-scoped."""
        headers = self.client.headers("GET", "/v1/health", b"", scope=SCOPE_A)
        headers["X-PF-Scope"] = "not-base64url-json"
        status, body, _ = self.client.call("GET", "/v1/health", headers=headers, sign=False)
        self.assertEqual(status, 403, body)
        self.assertEqual(self.client.error_code(status, body), "AUTHORIZATION_DENIED")

    def test_recover_accepts_no_tenant_but_still_requires_the_operator_role(self) -> None:
        actor: dict[str, Any] = dict(system_actor())
        status, body, _ = self.client.call("POST", "/v1/recover", {}, scope={}, actor=actor)
        self.assertEqual(status, 200, body)

        unprivileged = agent_actor()
        status, body, _ = self.client.call("POST", "/v1/recover", {}, scope={}, actor=unprivileged)
        self.assertEqual(status, 403, body)

    def test_tenant_routes_still_require_a_tenant(self) -> None:
        for method, path, payload in (
            ("GET", "/v1/runs", None),
            ("POST", "/v1/work-orders", {"companyRef": COMPANY_A, "startIntentId": "x"}),
        ):
            with self.subTest(path=path):
                status, body, _ = self.client.call(method, path, payload, scope={})
                self.assertEqual(status, 403, body)
                self.assertEqual(self.client.error_code(status, body), "AUTHORIZATION_DENIED")

    def test_an_instance_scoped_route_cannot_read_tenant_data(self) -> None:
        """The carve-out is about the *scope header*, never about the data a route may return.

        `/v1/health` reports instance facts. It must not acquire a tenant's runs by being called
        with a scope, and it must not acquire them by being called without one.
        """
        status, body, _ = self.client.call("GET", "/v1/health", scope={})
        self.assertEqual(status, 200, body)
        serialised = repr(body)
        self.assertNotIn(COMPANY_A, serialised)
        self.assertNotIn(PROJECT_A, serialised)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
