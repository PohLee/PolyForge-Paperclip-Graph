"""Verify the canonical-request fixture against the *Python* canonical encoder.

The fixture in ``packages/paperclip-plugin/tests/contract-canonical.test.ts`` asserts an exact
canonical string and an exact HMAC. This script asserts the same two values against
``polyforge.core.hashing`` (the Python twin of ``packages/protocol/src/canonical.ts``), so the
claim "the two languages cannot drift" is a checked fact rather than a promise.

Run from the repository root::

    PYTHONPATH=services/polyforge/src \
      python3 packages/paperclip-plugin/tests/helpers/canonical_fixture_check.py

Exit code 0 means the TypeScript and Python encoders agree byte for byte. It is deliberately
not part of ``npm test``: it needs a Python interpreter, and the Node suite asserts the same
fixture from the TypeScript side.
"""

from __future__ import annotations

import hashlib
import hmac
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "services" / "polyforge" / "src"))

from polyforge.core.hashing import canonical_json  # noqa: E402

SECRET = b"shared-secret-for-the-fixture"

# Copied verbatim from tests/contract-canonical.test.ts. If either side changes, this fails and
# says which.
EXPECTED_CANONICAL_REQUEST = (
    '{"actor":{"actorId":"agent-1","actorType":"agent","agentId":"agent-1","roles":[],'
    '"runId":"run-agent-1"},'
    '"audience":"polyforge-runtime",'
    '"bodyHash":"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",'
    '"issuer":"polyforge-bridge","method":"POST",'
    '"nonce":"0123456789abcdef0123456789abcdef",'
    '"path":"/v1/runs/run-1/claims?force=true",'
    '"scope":{"companyRef":"company-a","projectRef":"project-a"},'
    '"timestamp":"2026-01-02T03:04:05.000Z"}'
)

EXPECTED_SIGNATURE = "v1=a89273417e1e3c1b64315e8038ea39f4205255d87a5c533f80000229f7e3cbe2"


def main() -> int:
    canonical = canonical_json(
        {
            "audience": "polyforge-runtime",
            "method": "POST",
            "path": "/v1/runs/run-1/claims?force=true",
            "bodyHash": "sha256:" + hashlib.sha256(b"").hexdigest(),
            "timestamp": "2026-01-02T03:04:05.000Z",
            "nonce": "0123456789abcdef0123456789abcdef",
            "issuer": "polyforge-bridge",
            "actor": {
                "actorId": "agent-1",
                "actorType": "agent",
                "agentId": "agent-1",
                "roles": [],
                "runId": "run-agent-1",
            },
            "scope": {"companyRef": "company-a", "projectRef": "project-a"},
        }
    )
    signature = "v1=" + hmac.new(SECRET, canonical.encode("utf-8"), hashlib.sha256).hexdigest()

    failures: list[str] = []
    if canonical != EXPECTED_CANONICAL_REQUEST:
        failures.append("canonical request differs from the TypeScript fixture")
    if signature != EXPECTED_SIGNATURE:
        failures.append(
            f"signature differs from the TypeScript fixture: {signature} != {EXPECTED_SIGNATURE}"
        )
    if failures:
        for failure in failures:
            print(f"MISMATCH: {failure}", file=sys.stderr)
        print(f"python: {canonical}", file=sys.stderr)
        print(f"ts    : {EXPECTED_CANONICAL_REQUEST}", file=sys.stderr)
        return 1

    print("canonical request and signature match the TypeScript fixture byte for byte")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
