"""The external effect ledger: identity, reconciliation, and the retry rule.

``may_retry`` is the sharpest rule in the system. It exists to stop a timeout from becoming a
second side effect, so every one of its conditions is tested separately.
"""

from __future__ import annotations

import unittest

from services.polyforge.tests.runtime.fixtures import SCOPE_A, digest, insert_run_row, make_engine
from polyforge.core import errors
from polyforge.core.runtime.effects import (
    RETRYABLE_PRIOR_WORKER_STATES,
    EffectAuthority,
    EffectLedger,
    effect_key,
)
from polyforge.core.store.models import EffectStatus

TRANSITION = "sha256:transition"
STEP = "deploy.production"
TARGET = "sha256:target"


class EffectKeyTests(unittest.TestCase):
    def test_the_key_is_stable_across_calls(self) -> None:
        self.assertEqual(
            effect_key(transition_hash=TRANSITION, step_id=STEP, target_hash=TARGET),
            effect_key(transition_hash=TRANSITION, step_id=STEP, target_hash=TARGET),
        )

    def test_a_different_transition_or_target_is_a_different_key(self) -> None:
        base = effect_key(transition_hash=TRANSITION, step_id=STEP, target_hash=TARGET)
        self.assertNotEqual(
            base, effect_key(transition_hash="sha256:other", step_id=STEP, target_hash=TARGET)
        )
        self.assertNotEqual(
            base, effect_key(transition_hash=TRANSITION, step_id=STEP, target_hash="sha256:other")
        )
        self.assertNotEqual(
            base, effect_key(transition_hash=TRANSITION, step_id="other.step", target_hash=TARGET)
        )

    def test_the_key_is_domain_separated_from_a_contract_hash(self) -> None:
        from polyforge.core import hashing

        self.assertNotEqual(
            effect_key(transition_hash=TRANSITION, step_id=STEP, target_hash=TARGET),
            hashing.hash_domain("pf.contract", TRANSITION),
        )

    def test_a_missing_component_is_refused_rather_than_guessed(self) -> None:
        for kwargs in (
            {"transition_hash": "", "step_id": STEP, "target_hash": TARGET},
            {"transition_hash": TRANSITION, "step_id": "", "target_hash": TARGET},
            {"transition_hash": TRANSITION, "step_id": STEP, "target_hash": ""},
        ):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(errors.PolyForgeError):
                    effect_key(**kwargs)  # type: ignore[arg-type]

    def test_a_step_id_derived_from_an_attempt_number_is_refused(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            effect_key(
                transition_hash=TRANSITION, step_id="attempt-3", target_hash=TARGET
            )
        self.assertIn("attempt number", caught.exception.message)


class LedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        self.ledger = EffectLedger(self.db, clock=self.clock)
        insert_run_row(self.db, "run-1", now=self.clock.iso())
        self.scope = {
            "company_ref": SCOPE_A["companyRef"],
            "project_ref": SCOPE_A["projectRef"],
        }

    def _pending(self, **overrides: object) -> str:
        kwargs: dict[str, object] = {
            **self.scope,
            "run_id": "run-1",
            "transition_hash": TRANSITION,
            "step_id": STEP,
            "target_hash": TARGET,
            "request_hash": digest("request"),
        }
        kwargs.update(overrides)
        record = self.ledger.record_pending(**kwargs)  # type: ignore[arg-type]
        return str(record["effect_key"])

    def test_recording_pending_is_create_or_verify(self) -> None:
        first = self._pending()
        second = self._pending()
        self.assertEqual(first, second)
        rows = self.ledger.list_for_run(**self.scope, run_id="run-1")  # type: ignore[arg-type]
        self.assertEqual(len(rows), 1)
        self.assertEqual(str(rows[0]["status"]), EffectStatus.PENDING)

    def test_the_same_key_with_a_different_request_is_a_conflict(self) -> None:
        self._pending()
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._pending(request_hash=digest("other-request"))
        self.assertEqual(caught.exception.code, errors.ErrorCode.IDEMPOTENCY_CONFLICT)

    def test_marking_effected_records_the_receipt(self) -> None:
        key = self._pending()
        record = self.ledger.mark_effected(
            **self.scope,  # type: ignore[arg-type]
            run_id="run-1",
            key=key,
            receipt={"operationId": "op-1", "status": "accepted"},
            provider_ref={"provider": "paperclip", "kind": "operation", "id": "op-1"},
        )
        self.assertEqual(str(record["status"]), EffectStatus.EFFECTED)
        self.assertIn("op-1", str(record["receipt_json"]))
        self.assertFalse(self.ledger.may_retry(record))

    def test_an_unauthoritative_non_occurrence_becomes_unknown(self) -> None:
        key = self._pending()
        record = self.ledger.mark_not_effected(
            **self.scope,  # type: ignore[arg-type]
            run_id="run-1",
            key=key,
            authority=EffectAuthority(
                source="worker_self_report", outcome=EffectStatus.NOT_EFFECTED, observed_at="now"
            ),
        )
        self.assertEqual(
            str(record["status"]),
            EffectStatus.UNKNOWN,
            "a worker's own claim that it did nothing is not an authoritative absence",
        )
        self.assertFalse(self.ledger.may_retry(record))

    def test_updating_an_unknown_row_that_does_not_exist_is_refused(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.ledger.mark_unknown(
                **self.scope, run_id="run-1", key="sha256:never", reason="n/a"  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.NOT_FOUND)

    def test_list_unknown_filters_by_scope(self) -> None:
        insert_run_row(self.db, "run-2", scope=SCOPE_A, now=self.clock.iso())
        key_one = self._pending()
        key_two = self._pending(run_id="run-2", step_id="other.step")
        self.ledger.mark_unknown(**self.scope, run_id="run-1", key=key_one, reason="t")  # type: ignore[arg-type]
        self.assertEqual(len(self.ledger.list_unknown(**self.scope)), 1)  # type: ignore[arg-type]
        self.ledger.mark_unknown(**self.scope, run_id="run-2", key=key_two, reason="t")  # type: ignore[arg-type]
        self.assertEqual(len(self.ledger.list_unknown(**self.scope)), 2)  # type: ignore[arg-type]
        self.assertEqual(self.ledger.list_unknown(company_ref="other", project_ref="other"), [])


class MayRetryTests(unittest.TestCase):
    """The rule: authoritative non-occurrence AND a fenced or stopped prior worker."""

    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        self.ledger = EffectLedger(self.db, clock=self.clock)
        insert_run_row(self.db, "run-1", now=self.clock.iso())
        self.scope = {
            "company_ref": SCOPE_A["companyRef"],
            "project_ref": SCOPE_A["projectRef"],
        }
        self.key = str(
            self.ledger.record_pending(
                **self.scope,  # type: ignore[arg-type]
                run_id="run-1",
                transition_hash=TRANSITION,
                step_id=STEP,
                target_hash=TARGET,
                request_hash=digest("request"),
            )["effect_key"]
        )

    def _row(self) -> dict[str, object]:
        record = self.ledger.get(**self.scope, run_id="run-1", key=self.key)  # type: ignore[arg-type]
        assert record is not None
        return record

    def test_pending_is_never_retryable(self) -> None:
        self.assertFalse(self.ledger.may_retry(self._row()))

    def test_effected_is_never_retryable(self) -> None:
        self.ledger.mark_effected(
            **self.scope, run_id="run-1", key=self.key, receipt={"operationId": "op-1"}  # type: ignore[arg-type]
        )
        self.assertFalse(self.ledger.may_retry(self._row()))
        self.assertIn("already happened", self.ledger.retry_advisory(self._row()))

    def test_unknown_is_never_retryable(self) -> None:
        self.ledger.mark_unknown(**self.scope, run_id="run-1", key=self.key, reason="timeout")  # type: ignore[arg-type]
        self.assertFalse(self.ledger.may_retry(self._row()))
        self.assertIn("only an authoritative non-occurrence", self.ledger.retry_advisory(self._row()))

    def test_authoritative_absence_with_a_fenced_worker_is_retryable(self) -> None:
        self.ledger.mark_not_effected(
            **self.scope,  # type: ignore[arg-type]
            run_id="run-1",
            key=self.key,
            authority=EffectAuthority(
                source="provider",
                outcome=EffectStatus.NOT_EFFECTED,
                observed_at=self.clock.iso(),
                note="the provider has no record of the operation",
            ),
        )
        self.ledger.set_prior_worker_state(
            **self.scope, run_id="run-1", key=self.key, state="fenced"  # type: ignore[arg-type]
        )
        self.assertTrue(self.ledger.may_retry(self._row()))

    def test_authoritative_absence_with_a_stopped_worker_is_retryable(self) -> None:
        self.ledger.mark_not_effected(
            **self.scope,  # type: ignore[arg-type]
            run_id="run-1",
            key=self.key,
            authority=EffectAuthority(
                source="provider",
                outcome=EffectStatus.NOT_EFFECTED,
                observed_at=self.clock.iso(),
            ),
        )
        self.ledger.set_prior_worker_state(
            **self.scope, run_id="run-1", key=self.key, state="stopped"  # type: ignore[arg-type]
        )
        self.assertTrue(self.ledger.may_retry(self._row()))

    def test_authoritative_absence_with_a_still_running_worker_is_not_retryable(self) -> None:
        self.ledger.mark_not_effected(
            **self.scope,  # type: ignore[arg-type]
            run_id="run-1",
            key=self.key,
            authority=EffectAuthority(
                source="provider",
                outcome=EffectStatus.NOT_EFFECTED,
                observed_at=self.clock.iso(),
            ),
        )
        self.ledger.set_prior_worker_state(
            **self.scope, run_id="run-1", key=self.key, state="running"  # type: ignore[arg-type]
        )
        self.assertFalse(self.ledger.may_retry(self._row()))
        self.assertIn("confirmed stopped or fenced", self.ledger.retry_advisory(self._row()))

    def test_authoritative_absence_with_an_unaccounted_worker_is_not_retryable(self) -> None:
        self.ledger.mark_not_effected(
            **self.scope,  # type: ignore[arg-type]
            run_id="run-1",
            key=self.key,
            authority=EffectAuthority(
                source="provider",
                outcome=EffectStatus.NOT_EFFECTED,
                observed_at=self.clock.iso(),
            ),
        )
        self.assertFalse(self.ledger.may_retry(self._row()))
        self.assertIn("unaccounted for", self.ledger.retry_advisory(self._row()))

    def test_the_retryable_worker_states_are_exactly_fenced_and_stopped(self) -> None:
        self.assertEqual(set(RETRYABLE_PRIOR_WORKER_STATES), {"fenced", "stopped"})

    def test_may_retry_any_reports_per_key_answers(self) -> None:
        self.ledger.mark_unknown(**self.scope, run_id="run-1", key=self.key, reason="t")  # type: ignore[arg-type]
        answers = self.ledger.may_retry_any(**self.scope, run_id="run-1")  # type: ignore[arg-type]
        self.assertEqual(answers, {self.key: False})


if __name__ == "__main__":
    unittest.main()
