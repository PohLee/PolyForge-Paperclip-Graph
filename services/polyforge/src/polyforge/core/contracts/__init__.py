"""Contracts: effective policy and the transition contract.

A contract is the only thing a worker is ever asked to satisfy, and the only thing a gate
ever commits. It is built from the resolved policy and hashed into an identity that is
stable across retries and process restarts.
"""

from __future__ import annotations

from polyforge.core.contracts.policy import (
    PlatformGrants,
    PolicyContext,
    PolicyEffect,
    PolicyRule,
    EffectivePolicy,
    policy_from_rules,
    resolve_policy,
)
from polyforge.core.contracts.transition import (
    CONTRACT_SCHEMA_VERSION,
    RequiredEvaluator,
    TransitionContract,
    build_contract,
    contract_hash,
    decision_target_hash,
)

__all__ = [
    "CONTRACT_SCHEMA_VERSION",
    "EffectivePolicy",
    "PlatformGrants",
    "PolicyContext",
    "PolicyEffect",
    "PolicyRule",
    "RequiredEvaluator",
    "TransitionContract",
    "build_contract",
    "contract_hash",
    "decision_target_hash",
    "policy_from_rules",
    "resolve_policy",
]
