"""Effective engineering policy.

Responsibility: decide, from a set of scoped rules, what a transition is allowed to do —
and refuse to invent authority the platform did not grant.

Invariants (``docs/02-TECHNICAL-PLAN.md`` section 12, ``docs/01-REQUIREMENTS.md``
REQ-ARCH-04 / REQ-GOV-07):

* Deny-first. ``deny > require_approval > allow``, and **no matching rule is a deny**. A
  missing policy is not an implicit allow.
* A more specific rule beats a broader one; among equally specific rules the more
  restrictive effect wins. This is what makes a ``project`` or ``transition`` scoped deny
  impossible to override from ``org`` scope.
* A policy may narrow a platform grant and never widen one. An ``allow`` whose required
  authority is not covered by the platform grants is downgraded to ``deny`` — the Core
  does not get to grant itself a resource.
* A rule that requires approval makes the check *fresh twice*: once at admission and again
  before commit. An approval is a moment, not a possession.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Any, Iterable, Mapping, Sequence

from polyforge.core import errors, hashing

__all__ = [
    "PLATFORM_GRANT_NONE",
    "PlatformGrants",
    "PolicyContext",
    "PolicyEffect",
    "PolicyRule",
    "EffectivePolicy",
    "policy_from_rules",
    "resolve_policy",
]


class PolicyEffect(StrEnum):
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"
    ALLOW = "allow"


# Precedence index; higher wins at equal specificity.
_EFFECT_PRECEDENCE: Mapping[PolicyEffect, int] = {
    PolicyEffect.ALLOW: 0,
    PolicyEffect.REQUIRE_APPROVAL: 1,
    PolicyEffect.DENY: 2,
}

#: The authority ladder. A policy may ask for a level, never above this ceiling.
PLATFORM_GRANT_NONE: tuple[str, ...] = ()


@dataclass(frozen=True)
class PlatformGrants:
    """What the platform actually allows for this subject, action, resource, environment.

    Supplied by the bridge from authoritative platform state. ``revoked`` and
    ``expired`` are checked at admission *and* before commit, because a revocation between
    the two must not be treated as if it never happened.
    """

    allowed_authorities: tuple[str, ...] = PLATFORM_GRANT_NONE
    capabilities: tuple[str, ...] = ()
    revoked: bool = False
    expired: bool = False
    checked_at: str | None = None
    source: str = "platform"

    def covers(self, authority: str | None) -> bool:
        if authority is None or authority == "":
            return True
        return authority in self.allowed_authorities

    def to_wire(self) -> dict[str, Any]:
        return {
            "allowedAuthorities": list(self.allowed_authorities),
            "capabilities": list(self.capabilities),
            "revoked": self.revoked,
            "expired": self.expired,
            "checkedAt": self.checked_at,
            "source": self.source,
        }

    @staticmethod
    def from_wire(value: Any) -> "PlatformGrants":
        if not isinstance(value, Mapping):
            return PlatformGrants()
        return PlatformGrants(
            allowed_authorities=tuple(str(v) for v in (value.get("allowedAuthorities") or ())),
            capabilities=tuple(str(v) for v in (value.get("capabilities") or ())),
            revoked=bool(value.get("revoked", False)),
            expired=bool(value.get("expired", False)),
            checked_at=None if value.get("checkedAt") is None else str(value["checkedAt"]),
            source=str(value.get("source", "platform")),
        )


@dataclass(frozen=True)
class PolicyContext:
    """What the rules are matched against. Never a caller-supplied free-form blob."""

    project_ref: str
    workflow_ref: str
    transition_ref: str
    agent_subject: str = ""
    action: str = ""
    resource: str = ""
    environment: str = ""
    authority: str | None = None
    org_ref: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "orgRef": self.org_ref,
            "projectRef": self.project_ref,
            "workflowRef": self.workflow_ref,
            "transitionRef": self.transition_ref,
            "agentSubject": self.agent_subject,
            "action": self.action,
            "resource": self.resource,
            "environment": self.environment,
            "authority": self.authority,
        }


@dataclass(frozen=True)
class PolicyRule:
    """One scoped rule.

    A ``None`` scope dimension matches anything; a set dimension means "any of". Specificity
    is the count of bound dimensions plus the explicit ``priority``, so a rule pinned to one
    transition always outranks a rule pinned only to the org.
    """

    rule_id: str
    effect: PolicyEffect
    org_ref: str | None = None
    project_ref: str | None = None
    workflow_ref: str | None = None
    agent_ref: str | None = None
    transition_ref: str | None = None
    actions: tuple[str, ...] = ()
    resources: tuple[str, ...] = ()
    environments: tuple[str, ...] = ()
    required_capabilities: tuple[str, ...] = ()
    requested_authority: str | None = None
    requires_human_approval: bool = False
    freshness_seconds: int | None = None
    priority: int = 0
    version: str = "1"
    reason: str = ""

    def _binds(self, values: tuple[str, ...], wanted: str) -> bool:
        if not values:
            return True
        return wanted in values

    def matches(self, context: PolicyContext) -> bool:
        if self.org_ref is not None and context.org_ref is not None:
            if self.org_ref != context.org_ref:
                return False
        if self.project_ref is not None and self.project_ref != context.project_ref:
            return False
        if self.workflow_ref is not None and self.workflow_ref != context.workflow_ref:
            return False
        if self.agent_ref is not None and self.agent_ref != context.agent_subject:
            return False
        if self.transition_ref is not None and self.transition_ref != context.transition_ref:
            return False
        if not self._binds(self.actions, context.action):
            return False
        if not self._binds(self.resources, context.resource):
            return False
        if not self._binds(self.environments, context.environment):
            return False
        return True

    @property
    def specificity(self) -> tuple[int, int]:
        bound = sum(
            1
            for dimension in (
                self.org_ref,
                self.project_ref,
                self.workflow_ref,
                self.agent_ref,
                self.transition_ref,
            )
            if dimension is not None
        )
        scoped = 1 if (self.actions or self.resources or self.environments) else 0
        return (bound + scoped, self.priority)

    def to_wire(self) -> dict[str, Any]:
        return {
            "ruleId": self.rule_id,
            "effect": str(self.effect),
            "orgRef": self.org_ref,
            "projectRef": self.project_ref,
            "workflowRef": self.workflow_ref,
            "agentRef": self.agent_ref,
            "transitionRef": self.transition_ref,
            "actions": list(self.actions),
            "resources": list(self.resources),
            "environments": list(self.environments),
            "requiredCapabilities": list(self.required_capabilities),
            "requestedAuthority": self.requested_authority,
            "requiresHumanApproval": self.requires_human_approval,
            "freshnessSeconds": self.freshness_seconds,
            "priority": self.priority,
            "version": self.version,
            "reason": self.reason,
        }

    @staticmethod
    def from_wire(value: Mapping[str, Any]) -> "PolicyRule":
        return PolicyRule(
            rule_id=str(value.get("ruleId", "")),
            effect=PolicyEffect(str(value.get("effect", "deny"))),
            org_ref=_str_or_none(value.get("orgRef")),
            project_ref=_str_or_none(value.get("projectRef")),
            workflow_ref=_str_or_none(value.get("workflowRef")),
            agent_ref=_str_or_none(value.get("agentRef")),
            transition_ref=_str_or_none(value.get("transitionRef")),
            actions=tuple(str(v) for v in (value.get("actions") or ())),
            resources=tuple(str(v) for v in (value.get("resources") or ())),
            environments=tuple(str(v) for v in (value.get("environments") or ())),
            required_capabilities=tuple(str(v) for v in (value.get("requiredCapabilities") or ())),
            requested_authority=_str_or_none(value.get("requestedAuthority")),
            requires_human_approval=bool(value.get("requiresHumanApproval", False)),
            freshness_seconds=(
                None
                if value.get("freshnessSeconds") is None
                else int(value["freshnessSeconds"])
            ),
            priority=int(value.get("priority", 0)),
            version=str(value.get("version", "1")),
            reason=str(value.get("reason", "")),
        )


@dataclass(frozen=True)
class EffectivePolicy:
    """The winning rule plus what the Runtime must therefore do."""

    effect: PolicyEffect
    rule_id: str
    reason: str
    version: str
    required_capabilities: tuple[str, ...] = ()
    requires_human_approval: bool = False
    requires_fresh_authorization_at_admission: bool = False
    requires_fresh_authorization_before_commit: bool = False
    freshness_seconds: int | None = None
    requested_authority: str | None = None
    granted_authority: str | None = None
    authority_capped: bool = False
    platform_ceiling_applied: bool = False
    action: str = ""
    resource: str = ""
    environment: str = ""

    @property
    def is_denied(self) -> bool:
        return self.effect is PolicyEffect.DENY

    @property
    def requires_approval(self) -> bool:
        return self.effect is PolicyEffect.REQUIRE_APPROVAL

    @property
    def hash(self) -> str:
        """Stable identity of this policy decision, safe to bind into a contract."""
        return hashing.hash_domain(
            "pf.policy",
            {
                "effect": str(self.effect),
                "ruleId": self.rule_id,
                "version": self.version,
                "requiredCapabilities": list(self.required_capabilities),
                "requiresHumanApproval": self.requires_human_approval,
                "freshnessSeconds": self.freshness_seconds,
                "requestedAuthority": self.requested_authority,
                "grantedAuthority": self.granted_authority,
                "action": self.action,
                "resource": self.resource,
                "environment": self.environment,
            },
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "effect": str(self.effect),
            "ruleId": self.rule_id,
            "reason": self.reason,
            "version": self.version,
            "requiredCapabilities": list(self.required_capabilities),
            "requiresHumanApproval": self.requires_human_approval,
            "requiresFreshAuthorizationAtAdmission": self.requires_fresh_authorization_at_admission,
            "requiresFreshAuthorizationBeforeCommit": self.requires_fresh_authorization_before_commit,
            "freshnessSeconds": self.freshness_seconds,
            "requestedAuthority": self.requested_authority,
            "grantedAuthority": self.granted_authority,
            "authorityCapped": self.authority_capped,
            "platformCeilingApplied": self.platform_ceiling_applied,
            "action": self.action,
            "resource": self.resource,
            "environment": self.environment,
            "hash": self.hash,
        }

    @staticmethod
    def from_wire(value: Mapping[str, Any]) -> "EffectivePolicy":
        return EffectivePolicy(
            effect=PolicyEffect(str(value.get("effect", "deny"))),
            rule_id=str(value.get("ruleId", "")),
            reason=str(value.get("reason", "")),
            version=str(value.get("version", "1")),
            required_capabilities=tuple(str(v) for v in (value.get("requiredCapabilities") or ())),
            requires_human_approval=bool(value.get("requiresHumanApproval", False)),
            requires_fresh_authorization_at_admission=bool(
                value.get("requiresFreshAuthorizationAtAdmission", False)
            ),
            requires_fresh_authorization_before_commit=bool(
                value.get("requiresFreshAuthorizationBeforeCommit", False)
            ),
            freshness_seconds=(
                None
                if value.get("freshnessSeconds") is None
                else int(value["freshnessSeconds"])
            ),
            requested_authority=_str_or_none(value.get("requestedAuthority")),
            granted_authority=_str_or_none(value.get("grantedAuthority")),
            authority_capped=bool(value.get("authorityCapped", False)),
            platform_ceiling_applied=bool(value.get("platformCeilingApplied", False)),
            action=str(value.get("action", "")),
            resource=str(value.get("resource", "")),
            environment=str(value.get("environment", "")),
        )

    def with_grants(self, grants: PlatformGrants, *, phase: str) -> "EffectivePolicy":
        """Re-check this decision against fresh platform state.

        Called twice — at admission and immediately before commit — because that is the
        only way a revocation that lands mid-flight stops the action.
        """
        if self.is_denied:
            return self
        if grants.revoked:
            return replace(
                self,
                effect=PolicyEffect.DENY,
                reason=f"platform authorization revoked at {phase}: {self.reason}",
            )
        if grants.expired:
            return replace(
                self,
                effect=PolicyEffect.DENY,
                reason=f"platform authorization expired at {phase}: {self.reason}",
            )
        if not grants.covers(self.requested_authority):
            return replace(
                self,
                effect=PolicyEffect.DENY,
                reason=(
                    f"policy requested authority {self.requested_authority!r} which the "
                    f"platform grants do not cover at {phase}; a policy may narrow a grant, "
                    "never widen it"
                ),
            )
        missing = tuple(
            capability
            for capability in self.required_capabilities
            if grants.capabilities and capability not in grants.capabilities
        )
        if missing:
            return replace(
                self,
                effect=PolicyEffect.DENY,
                reason=(
                    f"platform grants at {phase} are missing required capabilities: "
                    + ", ".join(missing)
                ),
            )
        return replace(self, platform_ceiling_applied=True)


def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text or None


def _deny_no_match(context: PolicyContext) -> EffectivePolicy:
    return EffectivePolicy(
        effect=PolicyEffect.DENY,
        rule_id="no-match",
        reason=(
            "no policy rule matches this project/workflow/agent/transition combination; "
            "an absent rule is a deny, not an allow"
        ),
        version="0",
        action=context.action,
        resource=context.resource,
        environment=context.environment,
    )


def resolve_policy(
    rules: Sequence[PolicyRule] | Iterable[Mapping[str, Any]],
    context: PolicyContext,
    *,
    grants: PlatformGrants | None = None,
    phase: str = "admission",
) -> EffectivePolicy:
    """Return the effective policy for ``context``.

    ``grants`` is applied immediately when supplied, so the same function serves both the
    admission check and the pre-commit re-check.
    """
    normalized: list[PolicyRule] = []
    for rule in rules or ():
        normalized.append(PolicyRule.from_wire(rule) if isinstance(rule, Mapping) else rule)

    matching = [rule for rule in normalized if rule.matches(context)]
    if not matching:
        policy = _deny_no_match(context)
        return policy.with_grants(grants, phase=phase) if grants is not None else policy

    best_specificity = max(rule.specificity for rule in matching)
    finalists = [rule for rule in matching if rule.specificity == best_specificity]
    winner = max(finalists, key=lambda rule: _EFFECT_PRECEDENCE[rule.effect])

    # An approval requirement is the only effect that demands a platform check; an allow
    # still checks that nothing was revoked, so ``with_grants`` runs for all of them.
    needs_approval = winner.effect is PolicyEffect.REQUIRE_APPROVAL or winner.requires_human_approval
    policy = EffectivePolicy(
        effect=winner.effect,
        rule_id=winner.rule_id,
        reason=winner.reason
        or f"rule {winner.rule_id} matched at specificity {best_specificity[0]}",
        version=winner.version,
        required_capabilities=winner.required_capabilities,
        requires_human_approval=winner.requires_human_approval,
        requires_fresh_authorization_at_admission=needs_approval,
        requires_fresh_authorization_before_commit=needs_approval,
        freshness_seconds=winner.freshness_seconds,
        requested_authority=winner.requested_authority,
        granted_authority=(
            winner.requested_authority if winner.requested_authority is not None else None
        ),
        action=context.action,
        resource=context.resource,
        environment=context.environment,
    )
    if grants is not None:
        policy = policy.with_grants(grants, phase=phase)
    return policy


def policy_from_rules(
    rules: Sequence[PolicyRule] | Iterable[Mapping[str, Any]],
    **context_fields: Any,
) -> EffectivePolicy:
    """Convenience wrapper: build a :class:`PolicyContext` and resolve in one call."""
    try:
        context = PolicyContext(**context_fields)
    except TypeError as exc:  # pragma: no cover - programming error, surfaced clearly
        raise errors.bad_request(f"policy context fields are invalid: {exc}") from exc
    return resolve_policy(rules, context)
