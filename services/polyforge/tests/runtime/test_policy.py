"""Policy resolution tests (AT-33: deny precedence and no implicit authority)."""

from __future__ import annotations

import unittest

from services.polyforge.tests.runtime.fixtures import PROJECT_A, PROJECT_B
from polyforge.core.contracts.policy import (
    PlatformGrants,
    PolicyContext,
    PolicyEffect,
    PolicyRule,
    resolve_policy,
)


def _context(**overrides: object) -> PolicyContext:
    base: dict[str, object] = {
        "project_ref": PROJECT_A,
        "workflow_ref": "verification",
        "transition_ref": "verification.review_gate",
        "agent_subject": "sub-security",
        "action": "node.review_gate.execute",
        "resource": "review_gate",
        "environment": "production",
    }
    base.update(overrides)
    return PolicyContext(**base)  # type: ignore[arg-type]


def _allow(**overrides: object) -> PolicyRule:
    base: dict[str, object] = {"rule_id": "allow-1", "effect": PolicyEffect.ALLOW, "project_ref": PROJECT_A}
    base.update(overrides)
    return PolicyRule(**base)  # type: ignore[arg-type]


class DenyPrecedenceTests(unittest.TestCase):
    """AT-33: the original deny-first precedence is preserved."""

    def test_no_matching_rule_is_a_deny(self) -> None:
        policy = resolve_policy([_allow()], _context(project_ref=PROJECT_B))
        self.assertTrue(policy.is_denied)
        self.assertEqual(policy.rule_id, "no-match")
        self.assertIn("an absent rule is a deny", policy.reason)

    def test_no_rules_at_all_is_a_deny(self) -> None:
        policy = resolve_policy([], _context())
        self.assertTrue(policy.is_denied)

    def test_a_more_specific_deny_beats_a_broader_allow(self) -> None:
        rules = [
            _allow(),
            _allow(rule_id="allow-review", transition_ref="verification.review_gate"),
            PolicyRule(
                rule_id="deny-release",
                effect=PolicyEffect.DENY,
                project_ref=PROJECT_A,
                transition_ref="verification.review_gate",
                environments=("production",),
                reason="release gates are frozen during the freeze window",
            ),
        ]
        policy = resolve_policy(rules, _context())
        self.assertTrue(policy.is_denied)
        self.assertEqual(policy.rule_id, "deny-release")

    def test_deny_wins_at_equal_specificity(self) -> None:
        rules = [
            _allow(rule_id="allow-prod", environments=("production",)),
            PolicyRule(
                rule_id="deny-prod",
                effect=PolicyEffect.DENY,
                project_ref=PROJECT_A,
                environments=("production",),
            ),
        ]
        policy = resolve_policy(rules, _context())
        self.assertTrue(policy.is_denied)
        self.assertEqual(policy.rule_id, "deny-prod")

    def test_require_approval_beats_allow_at_equal_specificity(self) -> None:
        rules = [
            _allow(),
            PolicyRule(
                rule_id="approve-prod",
                effect=PolicyEffect.REQUIRE_APPROVAL,
                project_ref=PROJECT_A,
                environments=("production",),
                requires_human_approval=True,
            ),
        ]
        policy = resolve_policy(rules, _context())
        self.assertTrue(policy.requires_approval)

    def test_scoping_by_agent_and_project_narrows_the_match(self) -> None:
        rules = [
            _allow(),
            PolicyRule(
                rule_id="deny-agent",
                effect=PolicyEffect.DENY,
                project_ref=PROJECT_A,
                agent_ref="sub-qa",
            ),
        ]
        self.assertTrue(resolve_policy(rules, _context(agent_subject="sub-qa")).is_denied)
        self.assertFalse(resolve_policy(rules, _context(agent_subject="sub-security")).is_denied)


class FreshAuthorizationTests(unittest.TestCase):
    def test_approval_requires_a_fresh_check_at_admission_and_before_commit(self) -> None:
        rules = [
            PolicyRule(
                rule_id="approve-release",
                effect=PolicyEffect.REQUIRE_APPROVAL,
                project_ref=PROJECT_A,
                transition_ref="verification.review_gate",
                requires_human_approval=True,
                freshness_seconds=900,
            )
        ]
        policy = resolve_policy(rules, _context())
        self.assertTrue(policy.requires_fresh_authorization_at_admission)
        self.assertTrue(policy.requires_fresh_authorization_before_commit)
        self.assertEqual(policy.freshness_seconds, 900)

    def test_allow_does_not_demand_a_platform_approval(self) -> None:
        policy = resolve_policy([_allow()], _context())
        self.assertFalse(policy.requires_fresh_authorization_at_admission)
        self.assertFalse(policy.requires_fresh_authorization_before_commit)

    def test_a_revocation_between_phases_turns_an_allow_into_a_deny(self) -> None:
        policy = resolve_policy([_allow()], _context(), grants=PlatformGrants(), phase="admission")
        self.assertFalse(policy.is_denied)
        revoked = policy.with_grants(PlatformGrants(revoked=True), phase="before_commit")
        self.assertTrue(revoked.is_denied)
        self.assertIn("revoked", revoked.reason)

    def test_an_expiry_between_phases_turns_an_allow_into_a_deny(self) -> None:
        policy = resolve_policy([_allow()], _context())
        expired = policy.with_grants(PlatformGrants(expired=True), phase="before_commit")
        self.assertTrue(expired.is_denied)
        self.assertIn("expired", expired.reason)


class PlatformCeilingTests(unittest.TestCase):
    """REQ-GOV-07: a policy may narrow a platform grant, never widen it."""

    def test_allow_requesting_an_ungranted_authority_is_downgraded_to_deny(self) -> None:
        rules = [_allow(requested_authority="production.write")]
        policy = resolve_policy(rules, _context(), grants=PlatformGrants(allowed_authorities=()))
        self.assertTrue(policy.is_denied)
        self.assertIn("never widen", policy.reason)

    def test_allow_within_the_platform_ceiling_survives_and_is_marked(self) -> None:
        rules = [_allow(requested_authority="production.read")]
        policy = resolve_policy(
            rules,
            _context(),
            grants=PlatformGrants(allowed_authorities=("production.read", "production.write")),
        )
        self.assertFalse(policy.is_denied)
        self.assertTrue(policy.platform_ceiling_applied)
        self.assertEqual(policy.granted_authority, "production.read")

    def test_a_missing_capability_is_a_deny_not_a_downgrade(self) -> None:
        rules = [_allow(required_capabilities=("security.review",))]
        policy = resolve_policy(
            rules, _context(), grants=PlatformGrants(capabilities=("verification.qa",))
        )
        self.assertTrue(policy.is_denied)
        self.assertIn("security.review", policy.reason)

    def test_policy_hash_is_stable_and_sensitive_to_the_decision(self) -> None:
        first = resolve_policy([_allow()], _context())
        second = resolve_policy([_allow()], _context())
        self.assertEqual(first.hash, second.hash)
        other = resolve_policy([_allow(required_capabilities=("x",))], _context())
        self.assertNotEqual(first.hash, other.hash)


if __name__ == "__main__":
    unittest.main()
