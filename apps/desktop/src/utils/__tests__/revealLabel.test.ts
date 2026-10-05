import { describe, it, expect } from "vitest";
import { revealLabelKey } from "../revealLabel";

describe("revealLabelKey", () => {
  it("names the platform's own file manager", () => {
    expect(revealLabelKey("MacIntel")).toBe("filesView.ctxRevealMac");
    expect(revealLabelKey("Win32")).toBe("filesView.ctxRevealWindows");
    expect(revealLabelKey("Linux x86_64")).toBe("filesView.ctxRevealLinux");
    expect(revealLabelKey("")).toBe("filesView.ctxRevealLinux");
  });
});
