"""EntryPoint admission: the gate between a start intent and a ``GraphRun``.

An EntryPoint is a promise with a price. It names the inputs a caller must supply, the
prerequisite facts it will not run without, the nodes it may start, the facts it promises
to export, the capability its coordinator must hold, and whether it may be resumed. This
package checks all of that before any state is written.
"""

from __future__ import annotations

from polyforge.core.entrypoints.admission import (
    AdmissionResult,
    Blocker,
    admit,
    check_fact_provenance,
)

__all__ = ["AdmissionResult", "Blocker", "admit", "check_fact_provenance"]
