"""``python -m polyforge.services.runtime_api`` — start the Runtime Service.

Responsibility: argument parsing, logging setup, and the process lifecycle. This is the only
module in the package that configures logging or writes to stdout, because it is the only one
that is a program rather than a library.

Invariants:

* **Logging goes to stderr, never stdout.** ``--openapi`` writes the document to stdout so it
  can be piped; if a log line also went there, the pipe would be unparseable.
* **A configuration error exits non-zero without a traceback.** A missing shared secret is an
  operator mistake, not a bug, and a stack trace would bury the one sentence that says what to
  fix.
* **No argument is required to read a document.** ``--openapi`` needs no configuration at all,
  because generating the document must not depend on being able to start a service.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from typing import Sequence

from polyforge.services.runtime_api.config import ConfigurationError, ServiceConfig
from polyforge.services.runtime_api.openapi import build_document

__all__ = ["main"]

EXIT_OK = 0
EXIT_CONFIG = 2
EXIT_FAILED = 1


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m polyforge.services.runtime_api",
        description="The PolyForge Graph Runtime Service over HTTP.",
    )
    parser.add_argument(
        "--config",
        metavar="PATH",
        help="JSON config file. The shared secret still comes from the environment.",
    )
    parser.add_argument(
        "--db",
        metavar="PATH",
        help="Override POLYFORGE_DB. ':memory:' is accepted for a scratch instance.",
    )
    parser.add_argument("--bind", metavar="HOST", help="Override POLYFORGE_BIND.")
    parser.add_argument("--port", type=int, metavar="PORT", help="Override POLYFORGE_PORT.")
    parser.add_argument(
        "--read-only",
        action="store_true",
        help=(
            "Serve reads and reconciliation and refuse admissions. Health reports read_only."
        ),
    )
    parser.add_argument(
        "--log-level",
        metavar="LEVEL",
        help="Override POLYFORGE_LOG_LEVEL. Records identifiers, never bodies or secrets.",
    )
    parser.add_argument(
        "--openapi",
        action="store_true",
        help="Write the OpenAPI 3.1 document to stdout and exit. Needs no configuration.",
    )
    return parser


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.openapi:
        # Canonical JSON on stdout: a document that diffs cleanly is one nobody re-derives by
        # hand. No logging is configured, so nothing can contaminate the pipe.
        json.dump(build_document(), sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return EXIT_OK

    overrides: dict[str, object] = {}
    if args.db:
        overrides["db"] = args.db
    if args.bind:
        overrides["bind"] = args.bind
    if args.port is not None:
        overrides["port"] = args.port
    if args.read_only:
        overrides["read_only"] = True
    if args.log_level:
        overrides["log_level"] = args.log_level.upper()

    try:
        config = (
            ServiceConfig.load(args.config)
            if args.config
            else ServiceConfig.from_env(os.environ)
        )
        if overrides:
            config = config.with_overrides(**overrides)
        config.validate()
    except ConfigurationError as exc:
        _configure_logging("INFO")
        logging.getLogger("polyforge.runtime_api").error(
            "runtime_api.configuration_refused",
            extra={"pf.event": "runtime_api.configuration_refused", "pf.reason": str(exc)},
        )
        sys.stderr.write(f"configuration refused: {exc}\n")
        return EXIT_CONFIG

    _configure_logging(config.log_level)
    from polyforge.services.runtime_api.server import serve

    try:
        return serve(config)
    except KeyboardInterrupt:  # pragma: no cover - the signal handler normally gets there first
        return EXIT_OK
    except OSError as exc:
        logging.getLogger("polyforge.runtime_api").error(
            "runtime_api.bind_failed",
            extra={"pf.event": "runtime_api.bind_failed", "pf.reason": type(exc).__name__},
        )
        sys.stderr.write(f"could not serve on {config.bind}:{config.port}: {exc}\n")
        return EXIT_FAILED


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
