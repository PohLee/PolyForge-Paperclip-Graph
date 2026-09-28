"""The HTTP server: stdlib ``ThreadingHTTPServer`` plus a ``RuntimeService``.

Responsibility: own the socket, the threads, and the signal handling, and turn a raw
``BaseHTTPRequestHandler`` request into a :class:`~polyforge.services.runtime_api.router.Request`
and back.

Invariants:

* **One worker per connection, one writer per database.** ``ThreadingHTTPServer`` gives each
  connection a thread; the Core's ``Database`` serialises writes behind its own lock and its
  ``BEGIN IMMEDIATE``, so concurrency is safe at the store rather than at the transport.
* **The body is read with a cap before anything parses it.** An unbounded
  ``Content-Length`` is refused with ``413`` rather than buffered, because a request that can
  make the process allocate without limit is a denial of service that needs no bug.
* **Every response carries ``X-PF-Correlation-Id`` and a ``Content-Length``.** The first joins
  the caller's log to this one; the second is what makes HTTP/1.1 keep-alive work at all, and a
  handler that forgets it hangs the next request on that connection.
* **Only the JSON content type is accepted for a body.** A body the Core will not parse should
  not be read into memory first.
* **A graceful stop is a stop, not a kill.** ``SIGINT``/``SIGTERM`` stop accepting, let the
  loops finish, close the database, and then exit. The signal handler itself only signals; the
  shutdown runs on a separate thread because a handler may not join the thread it interrupted.
* **Server logging is the service's logger, not stderr.** The default
  ``BaseHTTPRequestHandler.log_message`` writes an unstructured line per request; a process
  with structured log fields everywhere else should not also have an unstructured one.
"""

from __future__ import annotations

import logging
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Final

from polyforge.core import errors
from polyforge.core.errors import PolyForgeError
from polyforge.services.runtime_api import errors as apierrors
from polyforge.services.runtime_api.app import RuntimeService
from polyforge.services.runtime_api.config import ServiceConfig
from polyforge.services.runtime_api.router import API_BASE_PATH, Request, Response

__all__ = [
    "RuntimeHTTPServer",
    "RuntimeRequestHandler",
    "build_handler",
    "create_server",
    "serve",
]

logger = logging.getLogger("polyforge.runtime_api.server")

#: Refuse a ``Content-Length`` larger than this outright, without reading a byte. A body the
#: Core will reject anyway should not be allowed to allocate first.
HARD_BODY_LIMIT: Final[int] = 64 * 1024 * 1024

_JSON_CONTENT_TYPES: Final[tuple[str, ...]] = ("application/json", "text/json", "")


class _RejectingHandler(BaseHTTPRequestHandler):
    """Base handler that only knows how to fail cleanly.

    Every early refusal in ``handle_one_request`` needs the same three things: a status, the
    correlation header, and a body in the Core's error shape. Doing them here means a
    malformed request gets the same envelope a refused one does, instead of the stdlib's
    HTML error page that no client in this system can parse.
    """

    server_version = "polyforge-runtime/1"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # Overridden by the bound class.
    service: RuntimeService = None  # type: ignore[assignment]

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        """Route the stdlib's per-request line into the structured logger."""
        logger.debug(
            "http.access",
            extra={"pf.event": "http.access", "pf.detail": format % args, "pf.peer": self.address_string()},
        )

    def log_error(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        logger.warning(
            "http.error",
            extra={"pf.event": "http.error", "pf.detail": format % args, "pf.peer": self.address_string()},
        )

    # -- helpers --------------------------------------------------------

    def _send(self, response: Response) -> None:
        self.send_response(response.status)
        for name, value in response.headers:
            self.send_header(name, value)
        if response.body:
            self.send_header("Content-Type", response.content_type)
        # Always sent, even on 204 and 304: without it the client cannot tell an empty body
        # from a truncated one, and keep-alive stalls.
        self.send_header("Content-Length", str(len(response.body)))
        self.end_headers()
        if response.body and self.command != "HEAD":
            self.wfile.write(response.body)

    def _fail(self, exc: PolyForgeError, correlation_id: str) -> None:
        self._send(apierrors.response_for(exc, correlation_id))

    def _read_body(self) -> bytes:
        if self.headers.get("Transfer-Encoding", "").lower().strip() == "chunked":
            # Chunked bodies need a streaming parser this surface does not have. Refusing is
            # better than buffering an unbounded stream into the Core's memory.
            raise PolyForgeError(
                errors.ErrorCode.BAD_REQUEST,
                "a chunked request body is not accepted; send Content-Length",
                details={"header": "Transfer-Encoding"},
                status=411,
            )
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return b""
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise apierrors.unsupported_media_type_error("invalid Content-Length") from exc
        if length < 0:
            raise PolyForgeError(
                errors.ErrorCode.BAD_REQUEST, "Content-Length may not be negative", status=400
            )
        limit = min(HARD_BODY_LIMIT, self.service.config.max_body_bytes)
        if length > limit:
            raise apierrors.payload_too_large_error(limit, length)
        if length == 0:
            return b""
        return self.rfile.read(length)

    # -- dispatch -------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PATCH(self) -> None:  # noqa: N802
        self._handle("PATCH")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle("HEAD")

    def _handle(self, method: str) -> None:
        correlation_id = ""
        try:
            body = self._read_body()
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if body and content_type not in _JSON_CONTENT_TYPES:
                correlation_id = self.headers.get("X-PF-Correlation-Id", "") or ""
                self._fail(apierrors.unsupported_media_type_error(content_type), correlation_id)
                return
            request = Request.build(
                method,
                self.path,
                {key: value for key, value in self.headers.items()},
                body,
                peer=self.address_string(),
            )
            response = self.service.dispatch(request)
            self._send(response)
        except PolyForgeError as exc:
            correlation_id = correlation_id or self.headers.get("X-PF-Correlation-Id", "") or "cor_unknown"
            self._fail(exc, correlation_id)
        except (BrokenPipeError, ConnectionResetError):
            # The caller hung up mid-response. There is nothing to say and nowhere to say it.
            logger.debug("http.client_disconnected", extra={"pf.event": "http.client_disconnected"})
        except Exception as exc:  # noqa: BLE001 - a handler thread must never die silently
            logger.error(
                "http.handler_failed",
                extra={
                    "pf.event": "http.handler_failed",
                    "pf.exceptionType": type(exc).__name__,
                    "pf.method": method,
                    "pf.path": self.path,
                },
                exc_info=(type(exc), exc, exc.__traceback__),
            )
            self._send(apierrors.internal_error("cor_handler", exc=exc))


def build_handler(service: RuntimeService) -> type[_RejectingHandler]:
    """A handler class bound to one service instance.

    A bound subclass rather than a module-level global: two services in one process (a test
    harness and a real one, say) must not be able to reach each other's Core.
    """
    return type("BoundRuntimeRequestHandler", (_RejectingHandler,), {"service": service})


class RuntimeHTTPServer(ThreadingHTTPServer):
    """A threading server that owns its service and stops it with itself.

    ``daemon_threads`` so a wedged client connection cannot keep the process alive past a
    graceful stop, and ``allow_reuse_address`` so a restart in a test does not hit TIME_WAIT.
    """

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], handler: type[_RejectingHandler], service: RuntimeService) -> None:
        self.service = service
        super().__init__(address, handler)

    def server_close(self) -> None:
        try:
            super().server_close()
        finally:
            # The service owns the database and the loops, so it is the only thing that can
            # close them. Doing it here means an embedder that just drops the server still
            # gets a clean shutdown.
            self.service.stop()


def create_server(
    config: ServiceConfig,
    *,
    service: RuntimeService | None = None,
    bind: str | None = None,
    port: int | None = None,
    start_background: bool = True,
) -> RuntimeHTTPServer:
    """Build the server. The Core is created lazily on first request, not here.

    ``migrate()`` runs inside :meth:`RuntimeService._ensure_core` rather than at construction so
    a database that cannot be opened or migrated still produces a listening socket that answers
    ``/health`` with ``blocked``, instead of a process that exits and leaves a supervisor
    guessing.
    """
    config.validate()
    runtime = service or RuntimeService(config)
    address = (config.bind if bind is None else bind, config.port if port is None else port)
    server = RuntimeHTTPServer(address, build_handler(runtime), runtime)
    if start_background:
        runtime.start()
    logger.info(
        "runtime_api.listening",
        extra={
            "pf.event": "runtime_api.listening",
            "pf.bind": server.server_address[0],
            "pf.port": server.server_address[1],
            "pf.base": API_BASE_PATH,
            "pf.config": config.to_public_dict(),
        },
    )
    return server


def serve(config: ServiceConfig, *, ready: threading.Event | None = None) -> int:
    """Run until a signal arrives, then stop gracefully. Returns a process exit code.

    The signal handler does the minimum a signal handler may do: set an event. The shutdown
    runs on its own thread, because ``server_close`` joins the handler threads and a handler
    that joins the thread it interrupted is a deadlock.
    """
    server = create_server(config)
    stopping = threading.Event()

    def _begin_stop(signum: int, _frame: Any) -> None:
        if stopping.is_set():
            return
        stopping.set()
        logger.info(
            "runtime_api.signal", extra={"pf.event": "runtime_api.signal", "pf.signal": int(signum)}
        )
        threading.Thread(target=server.shutdown, name="polyforge-shutdown", daemon=True).start()

    for signame in ("SIGINT", "SIGTERM"):
        number = getattr(signal, signame, None)
        if number is not None:
            try:
                signal.signal(number, _begin_stop)
            except ValueError:  # pragma: no cover - not on the main thread
                logger.debug("signal.registration_skipped", extra={"pf.signal": signame})
    if ready is not None:
        ready.set()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:  # pragma: no cover - the handler normally gets there first
        pass
    finally:
        server.server_close()
    return 0
