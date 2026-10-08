export class ConnectorError extends Error {
  readonly code: "NOT_FOUND" | "BAD_REQUEST" | "ILLEGAL_TRANSITION";
  constructor(code: ConnectorError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
