export class GovernanceDeniedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Governance denied: ${reason}`);
    this.name = 'GovernanceDeniedError';
    this.reason = reason;
  }
}

export class ApprovalRequiredError extends Error {
  readonly approvalId: string;
  readonly riskLevel: string;
  readonly simulation: Record<string, unknown>;

  constructor(approvalId: string, riskLevel: string, simulation: Record<string, unknown>) {
    super(`Approval required: ${approvalId}`);
    this.name = 'ApprovalRequiredError';
    this.approvalId = approvalId;
    this.riskLevel = riskLevel;
    this.simulation = simulation;
  }
}
