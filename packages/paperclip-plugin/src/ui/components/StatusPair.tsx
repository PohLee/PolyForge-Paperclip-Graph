/**
 * Graph status beside Paperclip issue status, each labelled with its source.
 *
 * This is the single most important presentation decision in the plugin. `projectIssueStatus`
 * maps a Core `PASSED` onto a board column `done`, and a board column can also be set to `done`
 * by a human dragging a card. Rendering either value alone is how a reviewer concludes that
 * engineering work passed when it did not.
 *
 * So the two are always shown as two separate claims, each with its provenance as visible text,
 * and a disagreement between them is stated in words rather than resolved by picking one.
 */

import type { ReactNode } from "react";
import { STATUS_SOURCE_GRAPH, STATUS_SOURCE_ISSUE, type StatusSource } from "../theme.js";
import { Row, Stack } from "./Layout.js";
import { StatusToken } from "./StatusToken.js";

export interface StatusPairProps {
  graphStatus: string | null;
  graphFamily?: "graph" | "node";
  /** A Paperclip projection. Named `projectedIssueStatus` at every call site, never `status`. */
  projectedIssueStatus: string | null;
  /** Set when the board's own status is known and differs from the Core's projection. */
  boardIssueStatus?: string | null;
  graphQualifier?: string;
  issueQualifier?: string;
  /** Rendered when the two disagree, e.g. "needs engineering verification". */
  disagreement?: ReactNode;
  graphSource?: StatusSource;
  issueSource?: StatusSource;
}

function graphFamilyOf(family: "graph" | "node"): "graph" | "node" {
  return family;
}

export function StatusPair(props: StatusPairProps): ReactNode {
  const graphKnown = typeof props.graphStatus === "string" && props.graphStatus.trim().length > 0;
  const projectedKnown =
    typeof props.projectedIssueStatus === "string" && props.projectedIssueStatus.trim().length > 0;

  return (
    <Stack gap={4}>
      <Row gap={SPACE_MD} align="baseline">
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, minWidth: 132 }}>
          Engineering
        </span>
        <StatusToken
          status={props.graphStatus}
          family={graphFamilyOf(props.graphFamily ?? "graph")}
          source={props.graphSource ?? STATUS_SOURCE_GRAPH}
          qualifier={props.graphQualifier}
        />
      </Row>
      <Row gap={SPACE_MD} align="baseline">
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, minWidth: 132 }}>
          Board projection
        </span>
        {projectedKnown ? (
          <StatusToken
            status={props.projectedIssueStatus}
            family="issue"
            source={props.issueSource ?? STATUS_SOURCE_ISSUE}
            qualifier={props.issueQualifier}
          />
        ) : (
          <StatusToken status={null} family="issue" source={props.issueSource ?? STATUS_SOURCE_ISSUE} />
        )}
      </Row>
      {props.boardIssueStatus === undefined ? null : (
        <Row gap={SPACE_MD} align="baseline">
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, minWidth: 132 }}>
            Board current
          </span>
          <StatusToken
            status={props.boardIssueStatus}
            family="issue"
            source={props.issueSource ?? STATUS_SOURCE_ISSUE}
          />
        </Row>
      )}
      <ReconciliationNote
        graphKnown={graphKnown}
        projectedKnown={projectedKnown}
        graphStatus={props.graphStatus}
        projectedIssueStatus={props.projectedIssueStatus}
        disagreement={props.disagreement}
      />
    </Stack>
  );
}

const SPACE_MD = 12;

/**
 * Says whether the board and the Core agree, in a sentence.
 *
 * The rule is deliberately asymmetric: agreement is reported, disagreement is reported, and an
 * unknown on either side is reported as unknown. Nothing here decides which side is right — that
 * is the Core's job, and the UI is not the place to assert it.
 */
function ReconciliationNote(props: {
  graphKnown: boolean;
  projectedKnown: boolean;
  graphStatus: string | null;
  projectedIssueStatus: string | null;
  disagreement?: ReactNode;
}): ReactNode {
  if (!props.graphKnown && !props.projectedKnown) {
    return (
      <p style={{ margin: 0, fontSize: 12 }}>
        <strong>No status was reported by either side.</strong> Nothing can be concluded about this run
        until the Core answers.
      </p>
    );
  }
  if (!props.graphKnown) {
    return (
      <p style={{ margin: 0, fontSize: 12 }}>
        <strong>Engineering status unknown.</strong> A board projection is showing, but there is no
        Core status behind it. A projection without a source is not evidence of anything.
      </p>
    );
  }
  if (!props.projectedKnown) {
    return (
      <p style={{ margin: 0, fontSize: 12 }}>
        <strong>No board projection.</strong> The engineering status above is the Core's own; nothing
        has been projected onto the board.
      </p>
    );
  }
  return (
    <p style={{ margin: 0, fontSize: 12 }}>
      <strong>Two separate facts.</strong> The engineering status comes from the PolyForge Core; the
      board status is a projection of it that a person can also move by hand. Reading the board
      value as an engineering pass is the mistake this panel exists to prevent.
      {props.disagreement === undefined ? null : <> {props.disagreement}</>}
    </p>
  );
}

/**
 * The "done on the board, not done in the graph" state.
 *
 * Shown on the issue tab whenever `needsEngineeringVerification` is set. It is phrased as work
 * still outstanding, not as an error to be acknowledged.
 */
export function NeedsEngineeringVerification(props: { reason?: string }): ReactNode {
  return (
    <div
      role="note"
      style={{
        border: "2px double var(--pf-warn, #fbbf24)",
        borderRadius: 6,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <strong style={{ fontSize: 13 }}>Needs engineering verification</strong>
      <p style={{ margin: 0, fontSize: 12 }}>
        This issue is marked <strong>done</strong> on the board, but the engineering graph has not
        recorded a pass for it. A board move is an observation, not a transition: the Core only
        records a node as <code>PASSED</code> when every mandatory evaluator has passed on evidence
        bound to that exact transition. Treat the work as unverified until the graph says so.
      </p>
      {props.reason === undefined ? null : (
        <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>{props.reason}</p>
      )}
    </div>
  );
}
