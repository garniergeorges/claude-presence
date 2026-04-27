import { describe, expect, it } from "vitest";
import {
  ALL_TOOLS,
  canCallTool,
  canForceRelease,
  effectiveTools,
  SCOPE_TOOLS,
} from "../../src/auth/rbac.js";

describe("rbac", () => {
  describe("scope defaults", () => {
    it("read scope contains only read-only tools", () => {
      expect(SCOPE_TOOLS.read).toEqual([
        "session_list",
        "session_heartbeat",
        "resource_list",
        "read_inbox",
      ]);
    });

    it("write scope is a strict superset of read", () => {
      for (const t of SCOPE_TOOLS.read) {
        expect(SCOPE_TOOLS.write).toContain(t);
      }
      expect(SCOPE_TOOLS.write.length).toBeGreaterThan(SCOPE_TOOLS.read.length);
    });

    it("admin scope contains all 9 tools", () => {
      expect(new Set(SCOPE_TOOLS.admin)).toEqual(new Set(ALL_TOOLS));
    });
  });

  describe("canCallTool", () => {
    it("denies read scope on resource_claim", () => {
      expect(canCallTool({ scope: "read" }, "resource_claim")).toBe(false);
    });

    it("allows read scope on session_list", () => {
      expect(canCallTool({ scope: "read" }, "session_list")).toBe(true);
    });

    it("allows write scope on broadcast", () => {
      expect(canCallTool({ scope: "write" }, "broadcast")).toBe(true);
    });

    it("denies any scope on an unknown tool", () => {
      expect(canCallTool({ scope: "admin" }, "unknown_tool")).toBe(false);
    });
  });

  describe("tool overrides", () => {
    it("restrict the effective tool set when set", () => {
      const tools = effectiveTools({
        scope: "write",
        toolOverrides: ["resource_claim", "resource_release"],
      });
      expect(tools).toEqual(["resource_claim", "resource_release"]);
    });

    it("cannot escalate beyond the scope's allowed tools", () => {
      // read scope cannot grant resource_claim via overrides
      const tools = effectiveTools({
        scope: "read",
        toolOverrides: ["resource_claim", "session_list"],
      });
      expect(tools).toEqual(["session_list"]);
    });

    it("ignored when null or empty", () => {
      expect(effectiveTools({ scope: "read", toolOverrides: null })).toEqual(
        SCOPE_TOOLS.read,
      );
      expect(effectiveTools({ scope: "read", toolOverrides: [] })).toEqual(
        SCOPE_TOOLS.read,
      );
    });
  });

  describe("canForceRelease", () => {
    it("only admin can force-release", () => {
      expect(canForceRelease({ scope: "admin" })).toBe(true);
      expect(canForceRelease({ scope: "write" })).toBe(false);
      expect(canForceRelease({ scope: "read" })).toBe(false);
    });
  });
});
