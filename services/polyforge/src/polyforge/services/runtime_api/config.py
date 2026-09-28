"""Environment-driven service configuration.

Responsibility: turn the operator's environment (or a JSON file) into the immutable
:class:`ServiceConfig` the rest of the process reads, and refuse to produce one that would
make the trust boundary meaningless.

Invariants:

* **The shared secret is never empty and never logged.** An empty ``bridgeSecret`` is a
  configuration error, not a default: a service that starts with no secret accepts requests
  from anyone who can reach the port, and every actor assertion it receives is then
  self-asserted. :meth:`ServiceConfig.validate` refuses it before a socket is opened.
* Exactly one bridge issuer may be configured. A ``human`` actor assertion is only trusted
  from an issuer the operator named, and "the operator named more than one" is not a
  decidable answer, so a list is refused rather than treated as "any of these".
* The secret is redacted in ``repr``, in ``to_public_dict``, and therefore in any log line or
  traceback frame that formats the config. ``POLYFORGE_BRIDGE_SECRET`` is read from the
  environment only; it is never given a value that would work by default.
* Operational knobs (reconciler interval, outbox lease, body cap) are validated here rather
  than at first use, so a bad deployment fails at start-up instead of on the first request.
"""

from __future__ import annotations

import json
import os
import pathlib
from dataclasses import dataclass, field, replace
from typing import Any, Final, Mapping

__all__ = [
    "DEFAULT_AUDIENCE",
    "DEFAULT_BIND",
    "DEFAULT_DB",
    "DEFAULT_INSTANCE_ROLE",
    "DEFAULT_PORT",
    "DEFAULT_REPLAY_WINDOW_SECONDS",
    "ConfigurationError",
    "ServiceConfig",
]

#: Audience a request is bound to (``docs/05-PROTOCOL.md`` section 1). A captured request
#: signed for this service cannot be replayed at another one.
DEFAULT_AUDIENCE: Final[str] = "polyforge-runtime"
DEFAULT_BIND: Final[str] = "127.0.0.1"
DEFAULT_PORT: Final[int] = 8710
DEFAULT_DB: Final[str] = "var/polyforge.db"
DEFAULT_INSTANCE_ROLE: Final[str] = "runtime"
DEFAULT_REPLAY_WINDOW_SECONDS: Final[int] = 120

#: Env var names. They are spelled out so an operator's `.env.example` and this module
#: cannot drift without a diff.
ENV_DB: Final[str] = "POLYFORGE_DB"
ENV_BIND: Final[str] = "POLYFORGE_BIND"
ENV_PORT: Final[str] = "POLYFORGE_PORT"
ENV_ISSUER: Final[str] = "POLYFORGE_BRIDGE_ISSUER"
ENV_SECRET: Final[str] = "POLYFORGE_BRIDGE_SECRET"
ENV_WINDOW: Final[str] = "POLYFORGE_REPLAY_WINDOW_SECONDS"
ENV_AUDIENCE: Final[str] = "POLYFORGE_ALLOWED_AUDIENCE"
ENV_ROLE: Final[str] = "POLYFORGE_INSTANCE_ROLE"
ENV_READ_ONLY: Final[str] = "POLYFORGE_READ_ONLY"
ENV_RECONCILER: Final[str] = "POLYFORGE_RECONCILER_INTERVAL_SECONDS"
ENV_OUTBOX: Final[str] = "POLYFORGE_OUTBOX_INTERVAL_SECONDS"
ENV_OUTBOX_LEASE: Final[str] = "POLYFORGE_OUTBOX_LEASE_SECONDS"
ENV_MAX_BODY: Final[str] = "POLYFORGE_MAX_BODY_BYTES"
ENV_LOG_LEVEL: Final[str] = "POLYFORGE_LOG_LEVEL"
ENV_NONCE_CACHE: Final[str] = "POLYFORGE_NONCE_CACHE_ENTRIES"

_REDACTED: Final[str] = "***redacted***"


class ConfigurationError(RuntimeError):
    """The process must not start with this configuration."""


def _as_bool(value: Any, field_name: str) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    raise ConfigurationError(f"{field_name} must be a boolean, got {value!r}")


def _as_float(value: Any, field_name: str, *, minimum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(f"{field_name} must be a number, got {value!r}") from exc
    if number < minimum:
        raise ConfigurationError(f"{field_name} must be >= {minimum}, got {number}")
    return number


def _as_int(value: Any, field_name: str, *, minimum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(f"{field_name} must be an integer, got {value!r}") from exc
    if number < minimum:
        raise ConfigurationError(f"{field_name} must be >= {minimum}, got {number}")
    return number


@dataclass(frozen=True, slots=True)
class ServiceConfig:
    """Everything the process needs to bind a port and verify a caller.

    Immutable on purpose: a handler thread must not observe a configuration that changed
    underneath it, so changing one is :meth:`with_overrides` producing a new value.
    """

    db: str = DEFAULT_DB
    bind: str = DEFAULT_BIND
    port: int = DEFAULT_PORT
    bridge_issuer: str = ""
    bridge_secret: str = field(repr=False, default="")
    replay_window_seconds: int = DEFAULT_REPLAY_WINDOW_SECONDS
    allowed_audience: tuple[str, ...] = (DEFAULT_AUDIENCE,)
    instance_role: str = DEFAULT_INSTANCE_ROLE
    read_only: bool = False
    reconciler_interval_seconds: float = 30.0
    outbox_interval_seconds: float = 5.0
    outbox_lease_seconds: float = 900.0
    max_body_bytes: int = 4 * 1024 * 1024
    nonce_cache_entries: int = 65_536
    log_level: str = "INFO"

    # -- construction ---------------------------------------------------

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "ServiceConfig":
        """Read the configuration from ``env`` (``os.environ`` when omitted)."""
        source = os.environ if env is None else env

        def read(name: str) -> str | None:
            value = source.get(name)
            if value is None:
                return None
            text = value.strip()
            return text or None

        audiences_raw = read(ENV_AUDIENCE)
        audiences = (
            tuple(
                dict.fromkeys(
                    part.strip() for part in audiences_raw.replace(";", ",").split(",") if part.strip()
                )
            )
            if audiences_raw
            else (DEFAULT_AUDIENCE,)
        )
        issuer = read(ENV_ISSUER) or ""
        secret = read(ENV_SECRET) or ""
        config = cls(
            db=read(ENV_DB) or DEFAULT_DB,
            bind=read(ENV_BIND) or DEFAULT_BIND,
            port=_as_int(read(ENV_PORT) or DEFAULT_PORT, ENV_PORT, minimum=0),
            bridge_issuer=issuer,
            bridge_secret=secret,
            replay_window_seconds=_as_int(
                read(ENV_WINDOW) or DEFAULT_REPLAY_WINDOW_SECONDS, ENV_WINDOW, minimum=1
            ),
            allowed_audience=audiences or (DEFAULT_AUDIENCE,),
            instance_role=read(ENV_ROLE) or DEFAULT_INSTANCE_ROLE,
            read_only=_as_bool(read(ENV_READ_ONLY) or "false", ENV_READ_ONLY),
            reconciler_interval_seconds=_as_float(
                read(ENV_RECONCILER) or 30.0, ENV_RECONCILER, minimum=0.1
            ),
            outbox_interval_seconds=_as_float(read(ENV_OUTBOX) or 5.0, ENV_OUTBOX, minimum=0.1),
            outbox_lease_seconds=_as_float(
                read(ENV_OUTBOX_LEASE) or 900.0, ENV_OUTBOX_LEASE, minimum=1.0
            ),
            max_body_bytes=_as_int(read(ENV_MAX_BODY) or 4 * 1024 * 1024, ENV_MAX_BODY, minimum=1024),
            nonce_cache_entries=_as_int(
                read(ENV_NONCE_CACHE) or 65_536, ENV_NONCE_CACHE, minimum=64
            ),
            log_level=(read(ENV_LOG_LEVEL) or "INFO").upper(),
        )
        config.validate()
        return config

    @classmethod
    def load(cls, path: str | pathlib.Path) -> "ServiceConfig":
        """Read a JSON config file. The shared secret never comes from it.

        Precedence is **file first, environment for the rest**: the file the operator named on
        the command line is an explicit statement of intent, and the environment fills the keys
        it does not mention. The one thing the file may never supply is ``bridgeSecret`` -
        putting a shared secret in a world-readable file is the failure this avoids - so it
        comes from ``POLYFORGE_BRIDGE_SECRET``, or from whatever variable ``bridgeSecretEnv``
        names.
        """
        target = pathlib.Path(path)
        try:
            raw = json.loads(target.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise ConfigurationError(f"config file {target} does not exist") from exc
        except json.JSONDecodeError as exc:
            raise ConfigurationError(f"config file {target} is not valid JSON: {exc}") from exc
        if not isinstance(raw, dict):
            raise ConfigurationError(f"config file {target} must contain a JSON object")

        body = dict(raw)
        secret = body.pop("bridgeSecret", None)
        secret_env = str(body.pop("bridgeSecretEnv", "") or "")
        if secret:
            raise ConfigurationError(
                f"config file {target} carries a bridgeSecret; put the shared secret in the "
                "environment instead so it is not written to disk"
            )
        env: dict[str, str] = {}
        if secret_env:
            value = os.environ.get(secret_env)
            if not value:
                raise ConfigurationError(
                    f"config file {target} names {secret_env} for the shared secret but it is empty"
                )
            env[ENV_SECRET] = value

        mapping: dict[str, Any] = {
            ENV_DB: body.get("db"),
            ENV_BIND: body.get("bind"),
            ENV_PORT: body.get("port"),
            ENV_ISSUER: body.get("bridgeIssuer", body.get("issuer")),
            ENV_WINDOW: body.get("replayWindowSeconds"),
            ENV_AUDIENCE: body.get("allowedAudience"),
            ENV_ROLE: body.get("instanceRole"),
            ENV_READ_ONLY: body.get("readOnly"),
            ENV_RECONCILER: body.get("reconcilerIntervalSeconds"),
            ENV_OUTBOX: body.get("outboxIntervalSeconds"),
            ENV_OUTBOX_LEASE: body.get("outboxLeaseSeconds"),
            ENV_MAX_BODY: body.get("maxBodyBytes"),
            ENV_NONCE_CACHE: body.get("nonceCacheEntries"),
            ENV_LOG_LEVEL: body.get("logLevel"),
        }
        for key, value in mapping.items():
            if value is None:
                continue
            if isinstance(value, (list, tuple)):
                value = ",".join(str(item) for item in value)
            env[key] = str(value)
        # File first, environment for the rest, and never a POLYFORGE_* key the file set.
        for key, value in os.environ.items():
            if key.startswith("POLYFORGE_") and key not in env:
                env[key] = value
        return cls.from_env(env)

    # -- validation -----------------------------------------------------

    def validate(self) -> None:
        """Refuse any configuration that would weaken or fake the trust boundary."""
        issuer = self.bridge_issuer.strip()
        if not issuer:
            raise ConfigurationError(
                f"{ENV_ISSUER} is required: the Runtime trusts assertions from exactly one bridge "
                "issuer, and with none configured it would have to trust all of them"
            )
        if any(separator in issuer for separator in (",", ";", " ")):
            # A list smuggled into a scalar field is how "exactly one issuer" quietly becomes
            # "any of these". A second issuer needs a second deliberate configuration.
            raise ConfigurationError(
                f"{ENV_ISSUER} must name exactly one issuer, got {issuer!r}; a Runtime may not "
                "trust more than one bridge, because a `human` assertion from any of them would "
                "then be authoritative"
            )
        if not self.bridge_secret:
            raise ConfigurationError(
                f"{ENV_SECRET} is required and may not be empty: an empty shared secret makes "
                "every actor assertion self-asserted, which is the one failure this boundary "
                "exists to prevent"
            )
        if len(self.bridge_secret) < 16:
            # Not a cryptographic claim, just a floor that rules out a truncated paste.
            raise ConfigurationError(
                f"{ENV_SECRET} must be at least 16 characters; got {len(self.bridge_secret)}"
            )
        if not self.allowed_audience:
            raise ConfigurationError(
                f"{ENV_AUDIENCE} must name at least one audience; a request has to be bound to one"
            )
        if self.port < 0 or self.port > 65_535:
            raise ConfigurationError(f"{ENV_PORT} must be a TCP port, got {self.port}")
        if not self.instance_role.strip():
            raise ConfigurationError(f"{ENV_ROLE} is required so a health report can name the instance")

    # -- derived values -------------------------------------------------

    @property
    def default_audience(self) -> str:
        return self.allowed_audience[0]

    def with_overrides(self, **changes: Any) -> "ServiceConfig":
        return replace(self, **changes)

    # -- redaction ------------------------------------------------------

    def to_public_dict(self) -> dict[str, Any]:
        """A loggable view. The secret is a presence marker, never a value or a digest."""
        return {
            "db": self.db,
            "bind": self.bind,
            "port": self.port,
            "bridgeIssuer": self.bridge_issuer,
            "bridgeSecret": _REDACTED if self.bridge_secret else "",
            "replayWindowSeconds": self.replay_window_seconds,
            "allowedAudience": list(self.allowed_audience),
            "instanceRole": self.instance_role,
            "readOnly": self.read_only,
            "reconcilerIntervalSeconds": self.reconciler_interval_seconds,
            "outboxIntervalSeconds": self.outbox_interval_seconds,
            "outboxLeaseSeconds": self.outbox_lease_seconds,
            "maxBodyBytes": self.max_body_bytes,
            "nonceCacheEntries": self.nonce_cache_entries,
            "logLevel": self.log_level,
        }

    def __repr__(self) -> str:
        return (
            f"ServiceConfig(db={self.db!r}, bind={self.bind!r}, port={self.port!r}, "
            f"bridge_issuer={self.bridge_issuer!r}, bridge_secret={_REDACTED!r}, "
            f"replay_window_seconds={self.replay_window_seconds!r}, "
            f"allowed_audience={self.allowed_audience!r}, instance_role={self.instance_role!r}, "
            f"read_only={self.read_only!r})"
        )

    __str__ = __repr__
