"""Registry tests: draft concurrency, publish-time compare-and-swap, immutability, activation.

The database doubles in ``fake_db`` and the shared setup in ``fixtures`` keep this suite
runnable whether or not ``polyforge.core.store.db`` has landed.
"""
