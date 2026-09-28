/**
 * The runtime command vocabulary, in one place.
 *
 * The list is the complete set of mutations a runtime view may offer. It is a closed set on
 * purpose: adding an entry here is a deliberate decision to expose a new server call in the
 * runtime view, and the absence of "add node", "connect node", "set status" or "edit contract" is
 * the structural half of REQ-GRAPH-07.
 *
 * `effect` is the sentence shown before the command is confirmed, because the reviewer should
 * know what they are about to do to a durable, pinned instance before they type a reason.
 */

export type RuntimeCommandName =
  | "pause"
  | "resume"
  | "cancel"
  | "retry"
  | "retry_node"
  | "resolve_block";

export interface RuntimeCommandSpec {
  readonly name: RuntimeCommandName;
  readonly label: string;
  /** True when the command addresses one node rather than the whole run. */
  readonly nodeScoped: boolean;
  /** What the server will do if it accepts. */
  readonly effect: string;
}

export const RUNTIME_COMMANDS: ReadonlyArray<RuntimeCommandSpec> = [
  {
    name: "pause",
    label: "Pause the run",
    nodeScoped: false,
    effect:
      "Asks the Core to stop dispatching. Work already in flight is not killed; it finishes or is cancelled, and the run parks at a checkpoint you can resume from.",
  },
  {
    name: "resume",
    label: "Resume the run",
    nodeScoped: false,
    effect:
      "Asks the Core to continue from the last durable checkpoint. The version closure this run pinned is unchanged, so resuming never picks up newer graph or policy state.",
  },
  {
    name: "cancel",
    label: "Cancel the run",
    nodeScoped: false,
    effect:
      "Ends the run. External effects that already fired stay in the ledger and are not rolled back — cancellation stops further work, it does not undo the world.",
  },
  {
    name: "retry",
    label: "Retry the run",
    nodeScoped: false,
    effect:
      "Asks the Core to re-evaluate the run. Whether rework is allowed is the Core's decision against its own budget; this is a request, and it can be refused.",
  },
  {
    name: "retry_node",
    label: "Retry a single node",
    nodeScoped: true,
    effect:
      "Requests a new attempt for one node. The previous attempt is invalidated and its lease epoch fenced, so a late worker holding the old lease cannot write.",
  },
  {
    name: "resolve_block",
    label: "Resolve a recorded block",
    nodeScoped: true,
    effect:
      "Marks a block as addressed. This records a claim by a person; the Core re-checks the underlying condition and will refuse if the block is still real.",
  },
];
