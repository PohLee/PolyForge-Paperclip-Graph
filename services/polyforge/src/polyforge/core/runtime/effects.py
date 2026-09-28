"""The external effect ledger.

Responsibility: know, for every side effect the Runtime asked the platform to perform,
whether it happened — and refuse to try again unless the answer is authoritative.

Invariants (``docs/05-PROTOCOL.md`` sections 8.1 and 11):

* ``effectKey = hash("pf.effect-key", {transitionHash, stepId, targetHash/requestHash})``.
  Never an HTTP retry id (every retry would be a new side effect) and never an attempt
  number (a rework would re-run a business effect). A genuinely new business effect needs a
  new transition/step identity, which is exactly what the key is derived from.
* A provider returns one of three facts: it happened with a receipt, it authoritatively did
  not happen, or it is unknown. ``UNKNOWN`` is stored as a durable state, not as absence.
* :func:`may_retry` requires **both** an authoritative non-occurrence **and** a fenced or
  confirmed-stopped prior worker. A timeout is neither.
* A database rollback is not an external undo. There is no ``compensate`` here on purpose:
  compensation is a separate, authorizable workflow that is allowed to fail.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from polyforge.core import errors, hashing, ids
from polyforge.core.store.db import Database, dumps, loads
from polyforge.core.store.models import EffectRecord, EffectStatus

__all__ = [
    "EFFECT_KEY_DOMAIN",
    "RETRYABLE_PRIOR_WORKER_STATES",
    "EffectLedger",
    "effect_key",
]

EFFECT_KEY_DOMAIN = "pf.effect-key"

#: A prior worker may only be superseded once it is provably gone. ``running`` is exactly the
#: case docs/05 section 10 forbids overriding, so it is absent on purpose.
RETRYABLE_PRIOR_WORKER_STATES: frozenset[str] = frozenset({"fenced", "stopped"})


def effect_key(*, transition_hash: str, step_id: str, target_hash: str) -> str:
    """Derive the stable identity of one external side effect.

    Every component is mandatory. A missing ``step_id`` or an empty ``target_hash`` would
    collapse unrelated effects onto one key (over-blocking) or split one effect across keys
    (duplicating it), so this refuses rather than guesses.
    """
    if not transition_hash:
        raise errors.bad_request("an effect key needs the transition hash it belongs to")
    if not step_id or not str(step_id).strip():
        raise errors.bad_request(
            "an effect key needs a stable step id; a step id is a business identity, not an "
            "HTTP attempt or attempt number"
        )
    if str(step_id).strip().lower().startswith("attempt-"):
        raise errors.bad_request(
            "a step id derived from an attempt number cannot identify an external effect: a "
            "retry would produce a second side effect"
        )
    if not target_hash:
        raise errors.bad_request(
            "an effect key needs the target or request hash it acts on; without it two "
            "requests could share one key"
        )
    return hashing.hash_domain(
        EFFECT_KEY_DOMAIN,
        {
            "transitionHash": str(transition_hash),
            "stepId": str(step_id),
            "targetHash": str(target_hash),
        },
    )


@dataclass(frozen=True)
class EffectAuthority:
    """An authoritative statement from the provider about an effect's occurrence."""

    source: str
    outcome: str
    observed_at: str
    reference: str | None = None
    note: str = ""

    @property
    def authoritative(self) -> bool:
        return self.source == "provider" and self.outcome in (
            EffectStatus.NOT_EFFECTED,
            EffectStatus.EFFECTED,
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "outcome": self.outcome,
            "observedAt": self.observed_at,
            "reference": self.reference,
            "note": self.note,
        }

    @staticmethod
    def from_wire(value: Mapping[str, Any] | None) -> "EffectAuthority | None":
        if not isinstance(value, Mapping) or not value:
            return None
        return EffectAuthority(
            source=str(value.get("source", "")),
            outcome=str(value.get("outcome", "")),
            observed_at=str(value.get("observedAt", "")),
            reference=None if value.get("reference") is None else str(value["reference"]),
            note=str(value.get("note", "")),
        )


class EffectLedger:
    """Durable effect records with create-or-verify identity."""

    def __init__(self, db: Database, *, clock: Any | None = None) -> None:
        self.db = db
        self._clock = clock if clock is not None else db.clock

    def _now(self) -> str:
        return self._clock.iso() if hasattr(self._clock, "iso") else ids.now_iso()

    def get(
        self, *, company_ref: str, project_ref: str, run_id: str, key: str
    ) -> dict[str, Any] | None:
        return self.db.query_one(
            "SELECT * FROM effect_records WHERE company_ref = ? AND project_ref = ?"
            " AND run_id = ? AND effect_key = ?",
            (company_ref, project_ref, run_id, key),
        )

    def list_for_run(
        self, *, company_ref: str, project_ref: str, run_id: str
    ) -> list[dict[str, Any]]:
        return self.db.query(
            "SELECT * FROM effect_records WHERE company_ref = ? AND project_ref = ? AND run_id = ?"
            " ORDER BY created_at, effect_key",
            (company_ref, project_ref, run_id),
        )

    def list_unknown(
        self, *, company_ref: str | None = None, project_ref: str | None = None
    ) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM effect_records WHERE status = ?", (EffectStatus.UNKNOWN,))
        if company_ref is None:
            return rows
        return [
            r
            for r in rows
            if str(r["company_ref"]) == company_ref and str(r["project_ref"]) == project_ref
        ]

    def record_pending(
        self,
        *,
        company_ref: str,
        project_ref: str,
        run_id: str,
        transition_hash: str,
        step_id: str,
        target_hash: str,
        request_hash: str,
        node_id: str | None = None,
        prior_worker_state: str | None = None,
        provider_ref: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create the ledger row before the platform is asked to do anything.

        Writing it first is what makes a crash between "asked" and "answered" recoverable:
        the row exists in ``PENDING`` and recovery moves it to ``UNKNOWN`` rather than
        losing the fact that something was in flight.
        """
        key = effect_key(transition_hash=transition_hash, step_id=step_id, target_hash=target_hash)
        now = self._now()
        existing = self.get(company_ref=company_ref, project_ref=project_ref, run_id=run_id, key=key)
        if existing is not None:
            # Create-or-verify: a replay with a different request body is a conflict, not an
            # overwrite, because it would mean two different effects share one key.
            if str(existing["request_hash"]) != str(request_hash):
                raise errors.idempotency_conflict(
                    "effect key already recorded with a different request hash; the key does not "
                    "identify this effect",
                    effectKey=key,
                    recordedRequestHash=str(existing["request_hash"]),
                    presentedRequestHash=str(request_hash),
                )
            return existing
        self.db.execute(
            "INSERT INTO effect_records (effect_key, company_ref, project_ref, run_id, node_id,"
            " transition_hash, step_id, target_hash, request_hash, status, provider_ref_json,"
            " result_hash, receipt_json, authority_json, prior_worker_state, reconciliation_note,"
            " created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,?,?)",
            (
                key,
                company_ref,
                project_ref,
                run_id,
                node_id,
                str(transition_hash),
                str(step_id),
                str(target_hash),
                str(request_hash),
                EffectStatus.PENDING,
                dumps(dict(provider_ref)) if provider_ref else None,
                prior_worker_state,
                now,
                now,
            ),
        )
        record = self.get(company_ref=company_ref, project_ref=project_ref, run_id=run_id, key=key)
        assert record is not None  # just inserted inside the caller's transaction
        return record

    def mark_effected(
        self,
        *,
        company_ref: str,
        project_ref: str,
        run_id: str,
        key: str,
        receipt: Mapping[str, Any],
        result_hash: str | None = None,
        provider_ref: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Record that the effect happened, with the exact receipt.

        This is the only terminal-positive state. A receipt without a provider reference is
        kept, but the note says so, because an unverifiable receipt is a fact an operator
        will need to reconcile later.
        """
        now = self._now()
        authority = EffectAuthority(
            source="provider",
            outcome=EffectStatus.EFFECTED,
            observed_at=now,
            reference=None if provider_ref is None else str(provider_ref.get("id", "")),
            note="receipt recorded by the bridge",
        )
        return self._update(
            company_ref=company_ref,
            project_ref=project_ref,
            run_id=run_id,
            key=key,
            status=EffectStatus.EFFECTED,
            authority=authority,
            receipt=receipt,
            result_hash=result_hash,
            provider_ref=provider_ref,
            note="effect confirmed effected with an exact receipt",
        )

    def mark_not_effected(
        self,
        *,
        company_ref: str,
        project_ref: str,
        run_id: str,
        key: str,
        authority: EffectAuthority | Mapping[str, Any],
    ) -> dict[str, Any]:
        """Record the provider's authoritative statement that the effect did not happen."""
        resolved = (
            authority
            if isinstance(authority, EffectAuthority)
            else EffectAuthority.from_wire(authority)
        )
        if resolved is None or not resolved.authoritative:
            # A non-authoritative "did not happen" is exactly the case docs/05 section 10
            # forbids acting on, so it lands in UNKNOWN instead.
            return self.mark_unknown(
                company_ref=company_ref,
                project_ref=project_ref,
                run_id=run_id,
                key=key,
                reason=(
                    "absence was not reported by the provider authoritatively; an unverified "
                    "non-occurrence is recorded as UNKNOWN"
                ),
            )
        return self._update(
            company_ref=company_ref,
            project_ref=project_ref,
            run_id=run_id,
            key=key,
            status=EffectStatus.NOT_EFFECTED,
            authority=resolved,
            note=resolved.note or "provider authoritatively confirmed the effect did not occur",
        )

    def mark_unknown(
        self, *, company_ref: str, project_ref: str, run_id: str, key: str, reason: str
    ) -> dict[str, Any]:
        """Record that nobody can say whether the effect happened.

        This is the state a timeout lands in. It blocks rather than retries, and it is
        handed to an authorized human; it is never quietly resolved in the Core's favour.
        """
        return self._update(
            company_ref=company_ref,
            project_ref=project_ref,
            run_id=run_id,
            key=key,
            status=EffectStatus.UNKNOWN,
            note=reason,
        )

    def set_prior_worker_state(
        self, *, company_ref: str, project_ref: str, run_id: str, key: str, state: str
    ) -> dict[str, Any]:
        return self._update(
            company_ref=company_ref,
            project_ref=project_ref,
            run_id=run_id,
            key=key,
            status=None,
            note=None,
            prior_worker_state=state,
        )

    def _update(
        self,
        *,
        company_ref: str,
        project_ref: str,
        run_id: str,
        key: str,
        status: str | None,
        authority: EffectAuthority | None = None,
        receipt: Mapping[str, Any] | None = None,
        result_hash: str | None = None,
        provider_ref: Mapping[str, Any] | None = None,
        note: str | None = None,
        prior_worker_state: str | None = None,
    ) -> dict[str, Any]:
        existing = self.get(company_ref=company_ref, project_ref=project_ref, run_id=run_id, key=key)
        if existing is None:
            raise errors.not_found(
                f"no effect record for key {key!r} in run {run_id!r}; the ledger never invents a row"
            )
        now = self._now()
        self.db.execute(
            "UPDATE effect_records SET status = COALESCE(?, status),"
            " authority_json = COALESCE(?, authority_json),"
            " receipt_json = COALESCE(?, receipt_json),"
            " result_hash = COALESCE(?, result_hash),"
            " provider_ref_json = COALESCE(?, provider_ref_json),"
            " prior_worker_state = COALESCE(?, prior_worker_state),"
            " reconciliation_note = COALESCE(?, reconciliation_note),"
            " updated_at = ?"
            " WHERE company_ref = ? AND project_ref = ? AND run_id = ? AND effect_key = ?",
            (
                status,
                dumps(authority.to_wire()) if authority else None,
                dumps(dict(receipt)) if receipt else None,
                result_hash,
                dumps(dict(provider_ref)) if provider_ref else None,
                prior_worker_state,
                note,
                now,
                company_ref,
                project_ref,
                run_id,
                key,
            ),
        )
        updated = self.get(company_ref=company_ref, project_ref=project_ref, run_id=run_id, key=key)
        assert updated is not None
        return updated

    # -- retry policy ------------------------------------------------------

    def may_retry(self, effect: Mapping[str, Any] | EffectRecord) -> bool:
        """Whether one more attempt at this effect is admissible.

        Two independent conditions, both required:

        1. the provider **authoritatively** reported non-occurrence; and
        2. the prior worker is ``fenced`` or ``stopped``.

        A timeout, a lost receipt, or a worker that may still be running all fail this, and
        the correct outcome is a block for an authorized human rather than a second try.
        """
        if isinstance(effect, EffectRecord):
            status = effect.status
            authority = effect.authority
            prior = effect.prior_worker_state
        else:
            status = str(effect.get("status", ""))
            authority = loads(effect.get("authority_json"), None)
            prior = effect.get("prior_worker_state")
        if status != EffectStatus.NOT_EFFECTED:
            return False
        parsed = EffectAuthority.from_wire(authority) if isinstance(authority, Mapping) else None
        if parsed is None or not parsed.authoritative:
            return False
        return str(prior or "") in RETRYABLE_PRIOR_WORKER_STATES

    def retry_advisory(self, effect: Mapping[str, Any] | EffectRecord) -> str:
        """Explain a ``False`` from :meth:`may_retry` in one sentence."""
        if isinstance(effect, EffectRecord):
            status, authority, prior = effect.status, effect.authority, effect.prior_worker_state
        else:
            status = str(effect.get("status", ""))
            authority = loads(effect.get("authority_json"), None)
            prior = effect.get("prior_worker_state")
        if status == EffectStatus.UNKNOWN:
            return (
                "the effect outcome is unknown; only an authoritative non-occurrence permits "
                "another attempt, so this is blocked for an authorized human"
            )
        if status == EffectStatus.EFFECTED:
            return "the effect already happened; re-running it would duplicate a side effect"
        if status == EffectStatus.PENDING:
            return "the effect is still in flight; its outcome must be reconciled first"
        parsed = EffectAuthority.from_wire(authority) if isinstance(authority, Mapping) else None
        if parsed is None or not parsed.authoritative:
            return "the recorded non-occurrence is not an authoritative provider statement"
        if str(prior or "") not in RETRYABLE_PRIOR_WORKER_STATES:
            return (
                f"the prior worker is {prior or 'unaccounted for'}; a new attempt is admissible "
                "only after the old worker is confirmed stopped or fenced at the provider"
            )
        return "a retry is admissible: authoritative non-occurrence plus a fenced prior worker"

    def may_retry_any(
        self, *, company_ref: str, project_ref: str, run_id: str, keys: Sequence[str] | None = None
    ) -> dict[str, bool]:
        rows = self.list_for_run(company_ref=company_ref, project_ref=project_ref, run_id=run_id)
        if keys is not None:
            wanted = {str(k) for k in keys}
            rows = [r for r in rows if str(r["effect_key"]) in wanted]
        return {str(r["effect_key"]): self.may_retry(r) for r in rows}
