"""The OpenAPI document cannot drift from the router.

The document is generated from :data:`ENDPOINTS`, so parity is a property rather than a
convention. This test asserts it anyway, because a future hand-written path would be exactly
the kind of drift the generation was supposed to make impossible, and a test that says so is
cheaper than a client discovering it.

The other assertions are about the document being *usable*: valid JSON, a self-consistent set
of ``$ref``s, a declared auth scheme on every secured operation, and every Core error code
reachable in at least one documented response.
"""

from __future__ import annotations

import json
import unittest

from polyforge.core.errors import ERROR_CODES, ERROR_STATUS
from polyforge.services.runtime_api.auth import AUTH_HEADERS
from polyforge.services.runtime_api.openapi import (
    SCHEMAS,
    SECURITY_SCHEMES,
    build_document,
    documented_routes,
)
from polyforge.services.runtime_api.router import API_BASE, ENDPOINTS, endpoint_paths
from services.polyforge.tests.runtime_api.fixtures import RuntimeApiCase


class DocumentShapeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.document = build_document()

    def test_the_document_is_valid_json(self) -> None:
        text = json.dumps(self.document, sort_keys=True)
        self.assertEqual(json.loads(text)["openapi"], "3.1.0")

    def test_the_document_parses_through_stdout_rendering(self) -> None:
        from polyforge.services.runtime_api.__main__ import main

        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.assertEqual(main(["--openapi"]), 0)
        self.assertEqual(json.loads(buffer.getvalue())["openapi"], "3.1.0")

    def test_the_document_lists_exactly_the_routes_the_router_serves(self) -> None:
        self.assertEqual(documented_routes(), endpoint_paths())

    def test_every_router_route_is_reachable(self) -> None:
        for method, path in self.document["paths"].items():
            self.assertTrue(method.startswith(API_BASE), msg=path)

    def test_every_endpoint_has_an_operation_id_and_a_summary(self) -> None:
        seen: set[str] = set()
        for path, methods in self.document["paths"].items():
            for method, operation in methods.items():
                self.assertTrue(operation["summary"], msg=f"{method} {path}")
                self.assertTrue(operation["operationId"], msg=f"{method} {path}")
                self.assertNotIn(operation["operationId"], seen, msg="operationId must be unique")
                seen.add(operation["operationId"])
        self.assertEqual(len(seen), len(ENDPOINTS))

    def test_every_response_carries_a_description(self) -> None:
        for path, methods in self.document["paths"].items():
            for method, operation in methods.items():
                for status, response in operation["responses"].items():
                    self.assertTrue(response.get("description"), msg=f"{method} {path} {status}")

    def test_the_success_status_matches_the_router(self) -> None:
        for endpoint in ENDPOINTS:
            operation = self.document["paths"][endpoint.full_path][endpoint.method.lower()]
            self.assertIn(str(endpoint.success_status), operation["responses"])

    def test_every_declared_failure_status_comes_from_the_core_table(self) -> None:
        for endpoint in ENDPOINTS:
            operation = self.document["paths"][endpoint.full_path][endpoint.method.lower()]
            for code in endpoint.failure_codes:
                self.assertIn(
                    str(ERROR_STATUS[code]), operation["responses"], msg=f"{endpoint.name} {code}"
                )

    def test_every_core_error_code_is_reachable_somewhere_in_the_document(self) -> None:
        documented: set[str] = set()
        for methods in self.document["paths"].values():
            for operation in methods.values():
                for status in operation["responses"]:
                    documented.add(status)
        for code in ERROR_CODES:
            self.assertIn(str(ERROR_STATUS[code]), documented, msg=code)

    def test_every_error_response_references_the_error_envelope(self) -> None:
        for path, methods in self.document["paths"].items():
            for method, operation in methods.items():
                for status, response in operation["responses"].items():
                    if status.startswith("2"):
                        continue
                    schema = response["content"]["application/json"]["schema"]
                    self.assertEqual(schema, {"$ref": "#/components/schemas/ErrorEnvelope"})

    def test_every_request_body_references_a_declared_schema(self) -> None:
        for path, methods in self.document["paths"].items():
            for method, operation in methods.items():
                if "requestBody" not in operation:
                    continue
                schema = operation["requestBody"]["content"]["application/json"]["schema"]
                name = schema["$ref"].rsplit("/", 1)[-1]
                self.assertIn(name, SCHEMAS, msg=f"{method} {path}")

    def test_every_response_references_a_declared_schema(self) -> None:
        for path, methods in self.document["paths"].items():
            for method, operation in methods.items():
                for status, response in operation["responses"].items():
                    if "content" not in response:
                        continue
                    schema = response["content"]["application/json"]["schema"]
                    if "$ref" not in schema:
                        continue
                    name = schema["$ref"].rsplit("/", 1)[-1]
                    self.assertIn(name, SCHEMAS, msg=f"{method} {path} {status}")

    def test_every_ref_in_the_document_resolves(self) -> None:
        text = json.dumps(self.document)
        for fragment in set(
            part.split('"')[0]
            for part in text.split('"$ref":"#/components/schemas/')[1:]
        ):
            self.assertIn(fragment, SCHEMAS, msg=fragment)

    def test_every_required_property_is_declared(self) -> None:
        for name, schema in SCHEMAS.items():
            for required in schema.get("required", ()):
                self.assertIn(required, schema["properties"], msg=f"{name}.{required}")

    def test_every_security_scheme_is_declared(self) -> None:
        for path, methods in self.document["paths"].items():
            for method, operation in methods.items():
                for requirement in operation.get("security", []):
                    for scheme in requirement:
                        self.assertIn(
                            scheme, SECURITY_SCHEMES, msg=f"{method} {path} declares {scheme}"
                        )

    def test_a_secured_operation_requires_all_six_signature_headers(self) -> None:
        declared = {
            SECURITY_SCHEMES[name]["name"] for name in SECURITY_SCHEMES if name != "pfAudience"
        }
        self.assertEqual(declared, set(AUTH_HEADERS))
        for path, methods in self.document["paths"].items():
            for method, operation in methods.items():
                if not operation.get("security"):
                    continue
                required = set()
                for requirement in operation["security"]:
                    required |= set(requirement)
                self.assertEqual(len(required), 6, msg=f"{method} {path}")

    def test_exactly_one_route_is_unauthenticated(self) -> None:
        open_routes = [
            f"{method.upper()} {path}"
            for path, methods in self.document["paths"].items()
            for method, operation in methods.items()
            if not operation.get("security")
        ]
        self.assertEqual(open_routes, ["GET /v1/health/live"])

    def test_the_canonical_request_schema_pins_the_nine_signed_keys(self) -> None:
        """This schema is the interoperability contract with the TypeScript bridge."""
        self.assertEqual(
            set(SCHEMAS["CanonicalRequest"]["required"]),
            {
                "actor",
                "audience",
                "bodyHash",
                "issuer",
                "method",
                "nonce",
                "path",
                "scope",
                "timestamp",
            },
        )
        self.assertEqual(
            set(SCHEMAS["CanonicalRequest"]["properties"]),
            set(SCHEMAS["CanonicalRequest"]["required"]),
        )

    def test_the_servers_entry_names_the_base(self) -> None:
        self.assertEqual(self.document["servers"], [{"url": API_BASE}])

    def test_every_tag_is_described(self) -> None:
        for tag in self.document["tags"]:
            self.assertTrue(tag["description"])
        used = {endpoint.tag for endpoint in ENDPOINTS}
        self.assertEqual({tag["name"] for tag in self.document["tags"]}, used)


class DocumentOverHttpTests(RuntimeApiCase):
    """The same document is served, and it is the same one ``--openapi`` prints."""

    def test_the_served_document_matches_the_generated_one(self) -> None:
        status, body, headers = self.client.call("GET", "/v1/openapi.json")
        self.assertEqual(status, 200, msg=body)
        self.assertEqual(body, build_document())
        self.assertIn("X-PF-Correlation-Id", headers)

    def test_the_document_needs_no_configuration_to_generate(self) -> None:
        """``--openapi`` must work for an operator with no secret in the environment."""
        import contextlib
        import io
        import os

        from polyforge.services.runtime_api.__main__ import main

        buffer = io.StringIO()
        previous = {key: os.environ.get(key) for key in list(os.environ) if key.startswith("POLYFORGE_")}
        for key in previous:
            del os.environ[key]
        try:
            with contextlib.redirect_stdout(buffer):
                self.assertEqual(main(["--openapi"]), 0)
        finally:
            for key, value in previous.items():
                if value is not None:
                    os.environ[key] = value
        self.assertIn("/v1/work-orders", json.loads(buffer.getvalue())["paths"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
