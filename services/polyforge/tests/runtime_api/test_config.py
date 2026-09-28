"""Service configuration: what it reads, what it refuses, and what it never prints.

There is no AT id for configuration, so this module names the acceptance property it protects
instead: an operator must not be able to start a process that accepts unsigned assertions, and
must not be able to leak the shared secret into a log. Both are refusals, and a refusal that
is only documented is not a control.
"""

from __future__ import annotations

import json
import os
import pathlib
import tempfile
import unittest

from polyforge.services.runtime_api.config import (
    DEFAULT_AUDIENCE,
    DEFAULT_BIND,
    DEFAULT_DB,
    DEFAULT_PORT,
    ConfigurationError,
    ServiceConfig,
)
from services.polyforge.tests.runtime_api.fixtures import ISSUER, SECRET


def _env(**overrides: str) -> dict[str, str]:
    base = {
        "POLYFORGE_BRIDGE_ISSUER": ISSUER,
        "POLYFORGE_BRIDGE_SECRET": SECRET,
    }
    base.update(overrides)
    return base


class FromEnvTests(unittest.TestCase):
    def test_it_reads_every_documented_variable(self) -> None:
        config = ServiceConfig.from_env(
            _env(
                POLYFORGE_DB="/var/lib/polyforge.db",
                POLYFORGE_BIND="0.0.0.0",
                POLYFORGE_PORT="9000",
                POLYFORGE_REPLAY_WINDOW_SECONDS="45",
                POLYFORGE_ALLOWED_AUDIENCE="polyforge-runtime,polyforge-canary",
                POLYFORGE_INSTANCE_ROLE="canary",
                POLYFORGE_READ_ONLY="true",
                POLYFORGE_RECONCILER_INTERVAL_SECONDS="12.5",
                POLYFORGE_OUTBOX_INTERVAL_SECONDS="2",
                POLYFORGE_OUTBOX_LEASE_SECONDS="60",
                POLYFORGE_MAX_BODY_BYTES="2048",
                POLYFORGE_NONCE_CACHE_ENTRIES="128",
                POLYFORGE_LOG_LEVEL="debug",
            )
        )
        self.assertEqual(config.db, "/var/lib/polyforge.db")
        self.assertEqual(config.bind, "0.0.0.0")
        self.assertEqual(config.port, 9000)
        self.assertEqual(config.replay_window_seconds, 45)
        self.assertEqual(config.allowed_audience, ("polyforge-runtime", "polyforge-canary"))
        self.assertEqual(config.default_audience, DEFAULT_AUDIENCE)
        self.assertEqual(config.instance_role, "canary")
        self.assertTrue(config.read_only)
        self.assertEqual(config.reconciler_interval_seconds, 12.5)
        self.assertEqual(config.outbox_interval_seconds, 2.0)
        self.assertEqual(config.outbox_lease_seconds, 60.0)
        self.assertEqual(config.max_body_bytes, 2048)
        self.assertEqual(config.nonce_cache_entries, 128)
        self.assertEqual(config.log_level, "DEBUG")

    def test_it_falls_back_to_the_documented_defaults(self) -> None:
        config = ServiceConfig.from_env(_env())
        self.assertEqual(config.db, DEFAULT_DB)
        self.assertEqual(config.bind, DEFAULT_BIND)
        self.assertEqual(config.port, DEFAULT_PORT)
        self.assertEqual(config.allowed_audience, (DEFAULT_AUDIENCE,))
        self.assertEqual(config.instance_role, "runtime")
        self.assertFalse(config.read_only)

    def test_a_blank_variable_falls_back_rather_than_producing_an_empty_value(self) -> None:
        config = ServiceConfig.from_env(_env(POLYFORGE_DB="   "))
        self.assertEqual(config.db, DEFAULT_DB)

    def test_an_audience_list_deduplicates_and_drops_blanks(self) -> None:
        config = ServiceConfig.from_env(
            _env(POLYFORGE_ALLOWED_AUDIENCE="a;b, a ,c;")
        )
        self.assertEqual(config.allowed_audience, ("a", "b", "c"))

    def test_it_reads_the_real_environment_when_asked(self) -> None:
        previous = {key: os.environ.get(key) for key in ("POLYFORGE_BRIDGE_ISSUER", "POLYFORGE_BRIDGE_SECRET")}
        os.environ["POLYFORGE_BRIDGE_ISSUER"] = ISSUER
        os.environ["POLYFORGE_BRIDGE_SECRET"] = SECRET
        try:
            self.assertEqual(ServiceConfig.from_env().bridge_issuer, ISSUER)
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


class RefusalTests(unittest.TestCase):
    def test_no_secret_refuses_to_start(self) -> None:
        with self.assertRaises(ConfigurationError) as caught:
            ServiceConfig.from_env({"POLYFORGE_BRIDGE_ISSUER": ISSUER})
        self.assertIn("POLYFORGE_BRIDGE_SECRET", str(caught.exception))

    def test_a_blank_secret_refuses_to_start(self) -> None:
        with self.assertRaises(ConfigurationError):
            ServiceConfig.from_env(_env(POLYFORGE_BRIDGE_SECRET="   "))

    def test_no_issuer_refuses_to_start(self) -> None:
        with self.assertRaises(ConfigurationError) as caught:
            ServiceConfig.from_env({"POLYFORGE_BRIDGE_SECRET": SECRET})
        self.assertIn("POLYFORGE_BRIDGE_ISSUER", str(caught.exception))

    def test_a_truncated_secret_refuses_to_start(self) -> None:
        with self.assertRaises(ConfigurationError) as caught:
            ServiceConfig.from_env(_env(POLYFORGE_BRIDGE_SECRET="short"))
        self.assertIn("16 characters", str(caught.exception))

    def test_a_list_of_issuers_refuses_to_start(self) -> None:
        """``docs/05`` section 1: a ``human`` assertion is only trusted from *the* bridge."""
        for smuggled in ("bridge-a,bridge-b", "bridge-a;bridge-b", "bridge-a bridge-b"):
            with self.subTest(issuer=smuggled), self.assertRaises(ConfigurationError) as caught:
                ServiceConfig.from_env(_env(POLYFORGE_BRIDGE_ISSUER=smuggled))
            self.assertIn("exactly one issuer", str(caught.exception))

    def test_a_non_numeric_port_is_refused(self) -> None:
        with self.assertRaises(ConfigurationError):
            ServiceConfig.from_env(_env(POLYFORGE_PORT="not-a-port"))

    def test_an_out_of_range_port_is_refused(self) -> None:
        with self.assertRaises(ConfigurationError):
            ServiceConfig(bridge_issuer=ISSUER, bridge_secret=SECRET, port=70_000).validate()

    def test_a_zero_replay_window_is_refused(self) -> None:
        with self.assertRaises(ConfigurationError):
            ServiceConfig.from_env(_env(POLYFORGE_REPLAY_WINDOW_SECONDS="0"))

    def test_a_non_boolean_read_only_is_refused(self) -> None:
        with self.assertRaises(ConfigurationError):
            ServiceConfig.from_env(_env(POLYFORGE_READ_ONLY="perhaps"))

    def test_a_tiny_body_cap_is_refused(self) -> None:
        with self.assertRaises(ConfigurationError):
            ServiceConfig.from_env(_env(POLYFORGE_MAX_BODY_BYTES="10"))

    def test_an_unreadable_interval_is_refused(self) -> None:
        with self.assertRaises(ConfigurationError):
            ServiceConfig.from_env(_env(POLYFORGE_RECONCILER_INTERVAL_SECONDS="soon"))

    def test_a_lease_shorter_than_a_second_is_refused(self) -> None:
        with self.assertRaises(ConfigurationError):
            ServiceConfig.from_env(_env(POLYFORGE_OUTBOX_LEASE_SECONDS="0.1"))


class FileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix="pf-config-")
        self.addCleanup(self.directory.cleanup)
        self.path = pathlib.Path(self.directory.name) / "config.json"
        # A file is never a complete configuration: the shared secret is the operator's
        # environment, and a test that forgets that would be testing an impossible deployment.
        self._previous_secret = os.environ.get("POLYFORGE_BRIDGE_SECRET")
        os.environ["POLYFORGE_BRIDGE_SECRET"] = SECRET
        self.addCleanup(self._restore_secret)
        self._previous_port = os.environ.get("POLYFORGE_PORT")
        self.addCleanup(self._restore_port)

    def _restore_secret(self) -> None:
        if self._previous_secret is None:
            os.environ.pop("POLYFORGE_BRIDGE_SECRET", None)
        else:
            os.environ["POLYFORGE_BRIDGE_SECRET"] = self._previous_secret

    def _restore_port(self) -> None:
        if self._previous_port is None:
            os.environ.pop("POLYFORGE_PORT", None)
        else:
            os.environ["POLYFORGE_PORT"] = self._previous_port

    def _write(self, body: dict) -> pathlib.Path:
        self.path.write_text(json.dumps(body), encoding="utf-8")
        return self.path

    def test_a_file_supplies_everything_but_the_secret(self) -> None:
        path = self._write(
            {
                "db": "/var/lib/polyforge.db",
                "bind": "127.0.0.1",
                "port": 8123,
                "bridgeIssuer": "bridge-from-file",
                "replayWindowSeconds": 30,
                "allowedAudience": ["polyforge-runtime"],
                "instanceRole": "canary",
                "readOnly": True,
            }
        )
        config = ServiceConfig.load(path)
        self.assertEqual(config.bridge_issuer, "bridge-from-file")
        self.assertEqual(config.bridge_secret, SECRET)
        self.assertEqual(config.port, 8123)
        self.assertTrue(config.read_only)

    def test_a_file_carrying_a_secret_is_refused(self) -> None:
        """A shared secret in a world-readable file is the failure this design avoids."""
        path = self._write({"bridgeIssuer": "b", "bridgeSecret": SECRET})
        with self.assertRaises(ConfigurationError) as caught:
            ServiceConfig.load(path)
        self.assertIn("environment", str(caught.exception))

    def test_a_named_secret_variable_is_read_from_the_environment(self) -> None:
        path = self._write({"bridgeIssuer": "b", "bridgeSecretEnv": "PF_TEST_SECRET"})
        previous = os.environ.get("PF_TEST_SECRET")
        os.environ["PF_TEST_SECRET"] = SECRET
        try:
            self.assertEqual(ServiceConfig.load(path).bridge_secret, SECRET)
        finally:
            if previous is None:
                os.environ.pop("PF_TEST_SECRET", None)
            else:
                os.environ["PF_TEST_SECRET"] = previous

    def test_a_named_but_empty_secret_variable_is_refused(self) -> None:
        path = self._write({"bridgeIssuer": "b", "bridgeSecretEnv": "PF_TEST_SECRET_MISSING"})
        os.environ.pop("PF_TEST_SECRET_MISSING", None)
        with self.assertRaises(ConfigurationError):
            ServiceConfig.load(path)

    def test_a_missing_file_is_refused(self) -> None:
        with self.assertRaises(ConfigurationError) as caught:
            ServiceConfig.load(self.path)
        self.assertIn("does not exist", str(caught.exception))

    def test_invalid_json_is_refused(self) -> None:
        self.path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(ConfigurationError) as caught:
            ServiceConfig.load(self.path)
        self.assertIn("not valid JSON", str(caught.exception))

    def test_a_json_array_is_refused(self) -> None:
        self.path.write_text("[1, 2]", encoding="utf-8")
        with self.assertRaises(ConfigurationError):
            ServiceConfig.load(self.path)

    def test_the_file_wins_for_the_keys_it_sets(self) -> None:
        """Precedence is explicit: the file the operator named is the statement of intent."""
        path = self._write({"bridgeIssuer": "from-file", "port": 1})
        previous = os.environ.get("POLYFORGE_PORT")
        os.environ["POLYFORGE_PORT"] = "9999"
        try:
            self.assertEqual(ServiceConfig.load(path).port, 1)
        finally:
            if previous is None:
                os.environ.pop("POLYFORGE_PORT", None)
            else:
                os.environ["POLYFORGE_PORT"] = previous

    def test_the_environment_fills_the_keys_the_file_omits(self) -> None:
        path = self._write({"bridgeIssuer": "from-file"})
        os.environ["POLYFORGE_PORT"] = "9999"
        try:
            config = ServiceConfig.load(path)
            self.assertEqual(config.port, 9999)
            self.assertEqual(config.bridge_issuer, "from-file")
        finally:
            if self._previous_port is None:
                os.environ.pop("POLYFORGE_PORT", None)
            else:
                os.environ["POLYFORGE_PORT"] = self._previous_port


class RedactionTests(unittest.TestCase):
    def test_the_secret_appears_in_no_string_form_of_the_config(self) -> None:
        config = ServiceConfig(bridge_issuer=ISSUER, bridge_secret=SECRET)
        for rendering in (repr(config), str(config), json.dumps(config.to_public_dict())):
            self.assertNotIn(SECRET, rendering)
            self.assertIn("redacted", rendering)

    def test_the_public_view_omits_the_secret_entirely(self) -> None:
        public = ServiceConfig(bridge_issuer=ISSUER, bridge_secret=SECRET).to_public_dict()
        self.assertEqual(public["bridgeSecret"], "***redacted***")
        self.assertEqual(public["bridgeIssuer"], ISSUER)

    def test_an_absent_secret_is_reported_as_absent_not_as_a_placeholder(self) -> None:
        public = ServiceConfig(bridge_issuer=ISSUER).to_public_dict()
        self.assertEqual(public["bridgeSecret"], "")

    def test_with_overrides_produces_a_new_value(self) -> None:
        original = ServiceConfig(bridge_issuer=ISSUER, bridge_secret=SECRET)
        changed = original.with_overrides(read_only=True, port=1)
        self.assertFalse(original.read_only)
        self.assertEqual(original.port, DEFAULT_PORT)
        self.assertTrue(changed.read_only)
        self.assertEqual(changed.port, 1)
        self.assertEqual(changed.bridge_secret, SECRET)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
