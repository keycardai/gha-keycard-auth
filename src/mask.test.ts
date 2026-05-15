import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import { maskSecret } from "./mask";

describe("maskSecret", () => {
  let setSecret: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setSecret = vi.spyOn(core, "setSecret").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("masks a single-line value once", () => {
    maskSecret("hunter2");
    expect(setSecret).toHaveBeenCalledTimes(1);
    expect(setSecret).toHaveBeenCalledWith("hunter2");
  });

  it("is a no-op for the empty string", () => {
    maskSecret("");
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("masks every non-empty line of a multi-line value (LF)", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nLINE2\nLINE3\n-----END PRIVATE KEY-----";
    maskSecret(pem);
    const masked = setSecret.mock.calls.map((c) => c[0]);
    expect(masked).toContain(pem);
    expect(masked).toContain("-----BEGIN PRIVATE KEY-----");
    expect(masked).toContain("LINE2");
    expect(masked).toContain("LINE3");
    expect(masked).toContain("-----END PRIVATE KEY-----");
  });

  it("handles CRLF line endings", () => {
    maskSecret("ONE\r\nTWO\r\nTHREE");
    const masked = setSecret.mock.calls.map((c) => c[0]);
    expect(masked).toContain("ONE");
    expect(masked).toContain("TWO");
    expect(masked).toContain("THREE");
  });

  it("handles bare CR line endings", () => {
    maskSecret("ONE\rTWO");
    const masked = setSecret.mock.calls.map((c) => c[0]);
    expect(masked).toContain("ONE");
    expect(masked).toContain("TWO");
  });

  it("skips empty / whitespace-only lines (no point masking them)", () => {
    maskSecret("ONE\n\n\nTWO");
    const masked = setSecret.mock.calls.map((c) => c[0]);
    // The whole blob + ONE + TWO. No empty entries.
    expect(masked).not.toContain("");
    expect(masked.filter((s) => s.length === 0)).toHaveLength(0);
    expect(masked).toContain("ONE");
    expect(masked).toContain("TWO");
  });

  it("masks the entire blob in addition to individual lines", () => {
    const blob = "ALPHA\nBETA";
    maskSecret(blob);
    const masked = setSecret.mock.calls.map((c) => c[0]);
    expect(masked).toContain(blob);
    expect(masked).toContain("ALPHA");
    expect(masked).toContain("BETA");
  });

  it("does not double-mask a single-line value", () => {
    maskSecret("just-one-line");
    expect(setSecret).toHaveBeenCalledTimes(1);
  });
});
