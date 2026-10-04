/** A network model call was attempted while local-only was on (global, scope or notebook). */
export class EgressBlocked extends Error {
  readonly code = "EGRESS_BLOCKED";
  readonly provider: string;
  constructor(provider: string, reason: string) {
    super(`Blocked a call to ${provider}: local-only mode is on (${reason}).`);
    this.provider = provider;
  }
}

/** The pre-call estimate would push this month's API spend over the cap. */
export class BudgetExceeded extends Error {
  readonly code = "BUDGET_EXCEEDED";
  readonly cap: number;
  readonly spent: number;
  readonly estimate: number;
  constructor(cap: number, spent: number, estimate: number) {
    super(
      `API calls are paused: this call (~$${estimate.toFixed(4)}) would exceed your monthly budget of $${cap.toFixed(2)} ` +
        `($${spent.toFixed(4)} spent so far). Raise the cap in Settings → Budget or switch to local-only mode.`,
    );
    this.cap = cap;
    this.spent = spent;
    this.estimate = estimate;
  }
}

/** A budget cap is set but the model has no entry in prices.yaml, so its cost can't be bounded. */
export class UnknownPrice extends Error {
  readonly code = "UNKNOWN_PRICE";
  constructor(model: string) {
    super(
      `No price for ${model} in prices.yaml, so it is blocked while a budget cap is set. Add its price or remove the cap.`,
    );
  }
}

/** Local-only is on and the task has no local route (router.md resolution step 4). */
export class TaskNeedsApi extends Error {
  readonly code = "TASK_NEEDS_API";
  constructor(task: string) {
    super(`The "${task}" task needs an API model, but local-only mode is on.`);
  }
}

export class MissingApiKey extends Error {
  readonly code = "MISSING_API_KEY";
  constructor(provider: string) {
    super(
      `No ${provider} API key is stored. Add one with \`rocky secrets set ${provider}\` or in Settings → Models.`,
    );
  }
}

export type ProviderFailureKind =
  | "timeout"
  | "provider_down"
  | "refusal"
  | "json_invalid"
  | "error";

/** A call reached the provider (or tried to) and failed in a way the router may escalate past. */
export class ProviderFailure extends Error {
  readonly code = "PROVIDER_FAILURE";
  readonly kind: ProviderFailureKind;
  constructor(kind: ProviderFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Errors the router must surface instead of falling back: they are policy decisions, not faults. */
export const isPolicyError = (e: unknown) =>
  e instanceof EgressBlocked ||
  e instanceof BudgetExceeded ||
  e instanceof UnknownPrice ||
  e instanceof TaskNeedsApi;
